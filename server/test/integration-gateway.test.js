/** 集成测试：网关 × 模拟 ComfyUI 端到端（鉴权/代理/媒体/上传/WS/限流/封禁）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createMockComfy } from './helpers/mock-comfy.js';
import { createGateway } from '../src/gateway.js';
import { loadConfig } from '../src/config.js';

const TOKEN = 'integration-test-token';
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// ---------- 测试夹具：主实例（默认限额） + 独立限额实例（互不干扰计数器） ----------
const mock = createMockComfy({ execDelayMs: 120 });
const mockPort = await listen(mock.server);

const mainCfg = loadConfig({
  configFile: '',
  overrides: { token: TOKEN, upstream: `http://127.0.0.1:${mockPort}`, maxUploadMB: 512, rateLimitPerMin: 1000, webDir: webRoot },
});
const gw = createGateway(mainCfg, webRoot);
const gwPort = await listen(gw.server);
const base = `http://127.0.0.1:${gwPort}`;

function makeStrictGw(overrides) {
  const cfg = loadConfig({
    configFile: '',
    overrides: { token: TOKEN, upstream: `http://127.0.0.1:${mockPort}`, webDir: webRoot, ...overrides },
  });
  const instance = createGateway(cfg, webRoot);
  return listen(instance.server).then((port) => ({ instance, base: `http://127.0.0.1:${port}` }));
}
const uploadLimit = await makeStrictGw({ maxUploadMB: 1 });
const rateLimit = await makeStrictGw({ rateLimitPerMin: 3 });
const banLimit = await makeStrictGw({ authFailsPerMin: 3, banMinutes: 1 });

function gfetch(pathname, opts = {}) {
  const headers = new Headers(opts.headers ?? {});
  headers.set('Authorization', `Bearer ${TOKEN}`);
  return fetch(`${base}${pathname}`, { ...opts, headers });
}

const SD_WORKFLOW = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'mock_a.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 256, height: 256, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'integration cat', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 1, steps: 3, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
      model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
    },
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'it', images: ['8', 0] } },
};

test.after(async () => {
  await gw.close();
  await uploadLimit.instance.close();
  await rateLimit.instance.close();
  await banLimit.instance.close();
  await mock.close();
});

// ---------- 鉴权 ----------
test('GET /health 免鉴权', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const health = await res.json();
  assert.equal(health.ok, true);
  assert.equal(typeof health.version, 'string', 'health 应带应用版本号');
});

test('无令牌请求代理端点 → 401', async () => {
  const res = await fetch(`${base}/system_stats`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'unauthorized');
});

test('Bearer / 查询参数 / Cookie 三通道鉴权均可用', async () => {
  const bearer = await fetch(`${base}/system_stats`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(bearer.status, 200);

  const query = await fetch(`${base}/system_stats?token=${TOKEN}`);
  assert.equal(query.status, 200);

  const cookie = await fetch(`${base}/system_stats`, { headers: { Cookie: `cm_token=${TOKEN}` } });
  assert.equal(cookie.status, 200);
  const direct = await fetch(`http://127.0.0.1:${mockPort}/system_stats`);
  assert.deepEqual(await cookie.json(), await direct.json(), '代理响应应与上游一致');
});

test('错误令牌 → 401', async () => {
  const res = await fetch(`${base}/system_stats`, { headers: { Authorization: 'Bearer wrong-token' } });
  assert.equal(res.status, 401);
});

// ---------- 静态壳 ----------
test('静态资源可访问（壳无鉴权）', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const js = await fetch(`${base}/js/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
});

// ---------- 队列提交 → WS 事件 → 历史 → 媒体 ----------
test('完整生图链路：提交 → WS 事件与二进制预览 → 历史 → /view 字节一致与 Range', async () => {
  const events = [];
  const binaries = [];
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?clientId=test-client&token=${TOKEN}`);
  ws.binaryType = 'nodebuffer';
  const wsReady = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) binaries.push(data);
    else events.push(JSON.parse(data.toString()));
  });
  await wsReady;
  await new Promise((r) => setTimeout(r, 100)); // 等待初始 status

  const submit = await gfetch('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: SD_WORKFLOW, client_id: 'test-client' }),
  });
  assert.equal(submit.status, 200);
  const { prompt_id: promptId } = await submit.json();

  // 等待执行完成事件
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (events.some((e) => e.type === 'execution_success' && e.data?.prompt_id === promptId)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(events.some((e) => e.type === 'status'), '应有 status 事件');
  assert.ok(events.some((e) => e.type === 'execution_start'), '应有 execution_start');
  assert.ok(events.some((e) => e.type === 'progress'), '应有 progress');
  assert.ok(events.some((e) => e.type === 'executed'), '应有 executed');
  assert.ok(events.some((e) => e.type === 'execution_success'), '应有 execution_success');
  assert.ok(binaries.length >= 1, '应收到二进制预览帧');
  const header = binaries[0].subarray(0, 8);
  assert.equal(header.readUInt32LE(0), 1, '事件类型应为预览图');
  assert.equal(header.readUInt32LE(4), 1, '图片类型应为 JPEG');
  assert.equal(binaries[0].subarray(8, 10).toString('hex'), 'ffd8', 'JPEG 魔数应完整透传');
  ws.close();

  // 历史
  const history = await gfetch('/history?max_items=10');
  const entry = (await history.json())[promptId];
  assert.ok(entry, '历史中应包含该任务');
  const imageItem = Object.values(entry.outputs).flatMap((o) => o.images ?? [])[0];
  assert.equal(imageItem.filename, 'it_00001_.png');

  // /view 字节与上游一致
  const viewUrl = `/view?filename=${encodeURIComponent(imageItem.filename)}&subfolder=&type=output`;
  const viaGw = await gfetch(viewUrl);
  assert.equal(viaGw.status, 200);
  assert.match(viaGw.headers.get('content-type'), /image\/png/);
  const viaUpstream = await fetch(`http://127.0.0.1:${mockPort}/view?filename=${encodeURIComponent(imageItem.filename)}`);
  const upstreamBytes = Buffer.from(await viaUpstream.arrayBuffer());
  assert.deepEqual(Buffer.from(await viaGw.arrayBuffer()), upstreamBytes);

  // Range 请求 → 206
  const range = await gfetch(viewUrl, { headers: { Range: 'bytes=0-99' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-99/${upstreamBytes.length}`);
  const slice = Buffer.from(await range.arrayBuffer());
  assert.equal(slice.length, 100);
  assert.deepEqual(slice, upstreamBytes.subarray(0, 100));

  // Content-Disposition 透传
  const headers = (await gfetch(viewUrl)).headers;
  assert.ok(headers.get('content-disposition')?.includes('filename'), '应透传 Content-Disposition');
});

test('带音频与视频输出的工作流', async () => {
  const wf = {
    '1': { class_type: 'SaveAudioMP3', inputs: { audio: ['a', 0], filename_prefix: 'song', quality: '320k' } },
    '2': { class_type: 'VHS_VideoCombine', inputs: { images: ['i', 0], frame_rate: 24, loop_count: 0, filename_prefix: 'clip', format: 'video/h264-mp4', pingpong: false, save_output: true } },
  };
  const submit = await gfetch('/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: 'test-client' }),
  });
  assert.equal(submit.status, 200);
  const { prompt_id: promptId } = await submit.json();
  await new Promise((r) => setTimeout(r, 400));

  const history = (await (await gfetch('/history?max_items=5')).json())[promptId];
  const audio = Object.values(history.outputs).flatMap((o) => o.audio ?? [])[0];
  const video = Object.values(history.outputs).flatMap((o) => o.gifs ?? [])[0];
  assert.ok(audio?.filename.endsWith('.mp3'));
  assert.ok(video?.filename.endsWith('.mp4'));
  assert.match((await gfetch('/view?filename=' + encodeURIComponent(video.filename) + '&subfolder=VHS')).headers.get('content-type'), /video\/mp4/);
});

test('node_errors 校验失败透传（400 + 错误体）', async () => {
  const res = await gfetch('/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: { '1': { class_type: 'NoSuchClass', inputs: {} } }, client_id: 'c' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.node_errors['1'], 'node_errors 应透传');
});

test('中断与队列删除', async () => {
  const int = await gfetch('/interrupt', { method: 'POST' });
  assert.equal(int.status, 200);
  const del = await gfetch('/queue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delete: ['nonexistent-id'] }),
  });
  assert.equal(del.status, 200);
});

// ---------- userdata ----------
test('userdata 保存/列表/读取/删除（含中文文件名）', async () => {
  const name = '中文工作流 test.json';
  const save = await gfetch(`/userdata/workflows/${encodeURIComponent(name)}?overwrite=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SD_WORKFLOW),
  });
  assert.equal(save.status, 201);

  const list = await (await gfetch('/userdata?dir=workflows&recurse=true&split=false')).json();
  assert.ok(list.includes(name), `列表应包含 ${name}，实际：${JSON.stringify(list)}`);

  const loaded = await (await gfetch(`/userdata/workflows/${encodeURIComponent(name)}`)).text();
  assert.deepEqual(JSON.parse(loaded), SD_WORKFLOW);

  const del = await gfetch(`/userdata/workflows/${encodeURIComponent(name)}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  const after = await gfetch(`/userdata/workflows/${encodeURIComponent(name)}`);
  assert.equal(after.status, 404);
});

test('userdata 路径穿越被网关拒绝', async () => {
  const res = await gfetch('/userdata/workflows/..%2F..%2Fetc%2Fevil.json');
  assert.equal(res.status, 400);
});

test('/view 文件名穿越被网关拒绝', async () => {
  const res = await gfetch(`/view?filename=${encodeURIComponent('../../etc/passwd.png')}`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'invalid_filename');
});

// ---------- 模型与上传 ----------
test('模型列表透传', async () => {
  const res = await gfetch('/models/checkpoints');
  assert.deepEqual(await res.json(), ['mock_a.safetensors', 'mock_b.safetensors']);
});

test('multipart 图片上传透传', async () => {
  const form = new FormData();
  form.append('image', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), '手机照片.png');
  const res = await gfetch('/upload/image', { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, '手机照片.png');
  assert.equal(body.type, 'input');
});

test('object_info 单节点查询透传', async () => {
  const res = await gfetch('/object_info/KSampler');
  const body = await res.json();
  assert.ok(body.KSampler.input.required.seed);
});

// ---------- WS 鉴权 ----------
test('WS 无令牌升级被拒绝', async () => {
  await new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?clientId=x`);
    ws.on('error', (err) => {
      assert.match(String(err), /401/);
      resolve();
    });
    ws.on('open', () => {
      assert.fail('不应连接成功');
      resolve();
    });
  });
});

// ---------- 独立限额实例：上传上限 / 限流 / 防爆破 ----------
test('超过 maxUploadMB 的请求 → 413', async () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 7);
  const res = await fetch(`${uploadLimit.base}/prompt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: big,
  });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'payload_too_large');
});

test('写操作限流：超过每分钟 3 次 → 429', async () => {
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${rateLimit.base}/interrupt`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 429]);
});

test('鉴权失败防爆破：连续失败后封禁（正确令牌也 429）', async () => {
  for (let i = 0; i < 4; i++) {
    await fetch(`${banLimit.base}/system_stats`, { headers: { Authorization: 'Bearer bad-token' } });
  }
  const good = await fetch(`${banLimit.base}/system_stats`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(good.status, 429, '触发封禁后正确令牌也应被拒绝');
});

test('未带令牌的请求不计入防爆破（否则客户端轮询会把自己封死）', async () => {
  const { instance, base } = await makeStrictGw({ authFailsPerMin: 3, banMinutes: 1 });
  try {
    // 连续 6 次「不带令牌」请求：应始终 401，但不触发封禁
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${base}/system_stats`);
      assert.equal(res.status, 401, '未带令牌应为普通 401');
    }
    // 此时带正确令牌仍应可用（说明未被封禁）
    const ok = await fetch(`${base}/system_stats`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200, '未带令牌的失败不应导致封禁');
  } finally {
    await instance.close();
  }
});

test('携带错误令牌仍会触发封禁（防爆破不被削弱）', async () => {
  const { instance, base } = await makeStrictGw({ authFailsPerMin: 3, banMinutes: 1 });
  try {
    for (let i = 0; i < 4; i++) {
      await fetch(`${base}/system_stats`, { headers: { Authorization: 'Bearer wrong-token' } });
    }
    const banned = await fetch(`${base}/system_stats`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(banned.status, 429, '错误令牌累积后应封禁');
  } finally {
    await instance.close();
  }
});
