/** 集成测试：图库直读 output 目录（列表/排序/分页/Range/下载头/路径安全/删除/缩略图）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createGateway } from '../src/gateway.js';
import { loadConfig } from '../src/config.js';

const TOKEN = 'integration-test-token';
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// ---------- 夹具：临时 output 目录，mtime/大小完全可控 ----------
const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'og-out-'));
const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'og-cache-'));
const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'og-outside-'));
const PNG_SMALL = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
const PNG_GREEN = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 30, g: 200, b: 30 } } }).png().toBuffer();
const PNG_BIG = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 30, g: 30, b: 200 } } }).png().toBuffer();

await fsp.writeFile(path.join(outDir, 'a.png'), PNG_SMALL);
await fsp.writeFile(path.join(outDir, 'b.png'), PNG_GREEN);
await fsp.writeFile(path.join(outDir, 'big.png'), PNG_BIG);
await fsp.writeFile(path.join(outDir, 'clip.mp4'), Buffer.alloc(65536, 7));
await fsp.writeFile(path.join(outDir, 'song.mp3'), Buffer.alloc(1024, 3));
await fsp.writeFile(path.join(outDir, 'note.txt'), 'not media');
await fsp.writeFile(path.join(outDir, '.hidden.png'), PNG_SMALL);
await fsp.mkdir(path.join(outDir, 'sub'));
await fsp.writeFile(path.join(outDir, 'sub', 'nested.png'), PNG_SMALL);
await fsp.writeFile(path.join(outsideDir, 'secret.png'), PNG_SMALL);
const t0 = new Date('2026-01-01T00:00:00Z').getTime();
const mtimes = { 'a.png': 0, 'song.mp3': 300, 'sub/nested.png': 500, 'clip.mp4': 1000, 'big.png': 1500, 'b.png': 2000 };
for (const [rel, ms] of Object.entries(mtimes)) {
  await fsp.utimes(path.join(outDir, rel), new Date(t0 + ms), new Date(t0 + ms));
}

const cfg = loadConfig({
  configFile: '',
  overrides: { token: TOKEN, upstream: 'http://127.0.0.1:9', outputDir: outDir, thumbCacheDir: cacheDir, webDir: webRoot },
});
const gw = createGateway(cfg, webRoot);
const port = await listen(gw.server);
const base = `http://127.0.0.1:${port}`;

function gfetch(pathname, opts = {}) {
  const headers = new Headers(opts.headers ?? {});
  headers.set('Authorization', `Bearer ${TOKEN}`);
  return fetch(`${base}${pathname}`, { ...opts, headers });
}

// ---------- PNG 夹具辅助：注入 tEXt 文本块（模拟 ComfyUI 嵌入的 prompt） ----------
function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function injectTextChunk(png, keyword, text) {
  const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'utf8')]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('tEXt', 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return Buffer.concat([png.subarray(0, 8), chunk, png.subarray(8)]);
}

test.after(async () => {
  await gw.close();
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.rm(cacheDir, { recursive: true, force: true });
  await fsp.rm(outsideDir, { recursive: true, force: true });
});

// ---------- 鉴权 ----------
test('未带令牌返回 401', async () => {
  const res = await fetch(`${base}/gw/output-list`);
  assert.equal(res.status, 401);
});

// ---------- 列表 ----------
test('列表：只含媒体文件、默认 mtime 降序、含子目录', async () => {
  const res = await gfetch('/gw/output-list?limit=200');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.total, 6);
  assert.deepEqual(data.items.map((i) => i.path),
    ['b.png', 'big.png', 'clip.mp4', 'sub/nested.png', 'song.mp3', 'a.png']);
  const first = data.items[0];
  assert.equal(first.name, 'b.png');
  assert.equal(first.kind, 'image');
  assert.equal(first.size, PNG_GREEN.length);
  assert.equal(typeof first.mtimeMs, 'number');
});

test('列表：名称升序自然排序 + 分页', async () => {
  const page1 = await (await gfetch('/gw/output-list?sort=name&order=asc&limit=4')).json();
  assert.deepEqual(page1.items.map((i) => i.path), ['a.png', 'b.png', 'big.png', 'clip.mp4']);
  const page2 = await (await gfetch('/gw/output-list?sort=name&order=asc&offset=4&limit=4')).json();
  assert.deepEqual(page2.items.map((i) => i.path), ['sub/nested.png', 'song.mp3']);
  assert.equal(page2.total, 6);
});

test('列表：大小降序最大者在前，类型过滤只含对应 kind', async () => {
  const bySize = await (await gfetch('/gw/output-list?sort=size&order=desc')).json();
  assert.equal(bySize.items[0].path, 'clip.mp4');
  const video = await (await gfetch('/gw/output-list?filter=video')).json();
  assert.deepEqual(video.items.map((i) => i.path), ['clip.mp4']);
  const audio = await (await gfetch('/gw/output-list?filter=audio')).json();
  assert.deepEqual(audio.items.map((i) => i.path), ['song.mp3']);
  const image = await (await gfetch('/gw/output-list?filter=image')).json();
  assert.equal(image.total, 4);
});

// ---------- 文件流 ----------
test('文件流：全量、Range 206、ETag 304、下载 attachment 头', async () => {
  const full = await gfetch('/gw/output-file?path=b.png');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'image/png');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(PNG_GREEN));
  const etag = full.headers.get('etag');

  const part = await gfetch('/gw/output-file?path=b.png', { headers: { Range: 'bytes=0-9' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-9/${PNG_GREEN.length}`);
  assert.equal(Buffer.from(await part.arrayBuffer()).length, 10);

  const suffix = await gfetch('/gw/output-file?path=b.png', { headers: { Range: 'bytes=-5' } });
  assert.equal(suffix.status, 206);
  assert.equal(Buffer.from(await suffix.arrayBuffer()).length, 5);

  const notMod = await gfetch('/gw/output-file?path=b.png', { headers: { 'If-None-Match': etag } });
  assert.equal(notMod.status, 304);

  const dl = await gfetch('/gw/output-file?path=b.png&download=1');
  const cd = dl.headers.get('content-disposition') ?? '';
  assert.ok(cd.startsWith('attachment;'), 'download=1 应带 attachment 头');
  assert.ok(cd.includes("filename*=UTF-8''b.png"), cd);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(PNG_GREEN));
});

test('路径安全：拒绝越界、反斜杠、隐藏段与缺失文件', async () => {
  assert.equal((await gfetch(`/gw/output-file?path=${encodeURIComponent('../outside/secret.png')}`)).status, 400);
  assert.equal((await gfetch('/gw/output-file?path=a%5C..%5Cb.png')).status, 400);
  assert.equal((await gfetch('/gw/output-file?path=.hidden.png')).status, 400);
  assert.equal((await gfetch('/gw/output-file?path=nope.png')).status, 404);
});

// ---------- 子文件夹 ----------
test('目录清单与 dir 前缀过滤（含越界拒绝）', async () => {
  const dirsRes = await gfetch('/gw/output-dirs');
  assert.equal(dirsRes.status, 200);
  assert.deepEqual((await dirsRes.json()).dirs, ['sub']);

  const inDir = await (await gfetch('/gw/output-list?dir=sub')).json();
  assert.equal(inDir.total, 1);
  assert.deepEqual(inDir.items.map((i) => i.path), ['sub/nested.png']);

  const root = await (await gfetch('/gw/output-list?dir=')).json();
  assert.equal(root.total, 6);

  assert.equal((await gfetch(`/gw/output-list?dir=${encodeURIComponent('../x')}`)).status, 400);
  assert.equal((await gfetch('/gw/output-list?dir=a%5Cb')).status, 400);
});

// ---------- 批量删除 ----------
test('批量删除：逐文件回报结果，列表即时更新，拒绝越界', async () => {
  const res = await gfetch('/gw/output-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: ['a.png', 'sub/nested.png', 'nope.png', '../outside/secret.png'] }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.deleted, 2);
  const byPath = new Map(data.results.map((r) => [r.path, r]));
  assert.equal(byPath.get('a.png').ok, true);
  assert.equal(byPath.get('nope.png').ok, false);
  assert.equal(byPath.get('../outside/secret.png').ok, false);
  assert.ok(await fsp.readFile(path.join(outsideDir, 'secret.png')).then(() => true, () => false), '越界目标不得被删');

  const list = await (await gfetch('/gw/output-list')).json();
  assert.equal(list.total, 4);
  assert.ok(!list.items.some((i) => ['a.png', 'sub/nested.png'].includes(i.path)));
});

// ---------- 缩略图 ----------
test('缩略图：图片出 WebP，视频帧依赖 ffmpeg（200 或 404），音频/缺失 404', async () => {
  const res = await gfetch('/gw/output-thumb?path=b.png&w=64');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
  assert.ok(meta.width <= 64 && meta.width > 0);

  const video = await gfetch('/gw/output-thumb?path=clip.mp4&w=64');
  assert.ok([200, 404].includes(video.status), `视频缩略图状态 ${video.status}`);
  assert.equal((await gfetch('/gw/output-thumb?path=song.mp3')).status, 404);
  assert.equal((await gfetch('/gw/output-thumb?path=nope.png')).status, 404);
  assert.equal((await gfetch('/gw/output-thumb?path=../x.png')).status, 400);
});

// ---------- PNG 提示词提取 ----------
test('output-prompt：解析 PNG 元数据里的 prompt，非 PNG/无元数据/越界 404', async () => {
  const promptJson = { '3': { class_type: 'KSampler', inputs: { seed: 1, text: '山水画' } } };
  await fsp.writeFile(path.join(outDir, 'withprompt.png'), injectTextChunk(PNG_GREEN, 'prompt', JSON.stringify(promptJson)));

  const res = await gfetch('/gw/output-prompt?path=withprompt.png');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).prompt, promptJson);

  assert.equal((await gfetch('/gw/output-prompt?path=b.png')).status, 404);
  assert.equal((await gfetch('/gw/output-prompt?path=clip.mp4')).status, 404);
  assert.equal((await gfetch(`/gw/output-prompt?path=${encodeURIComponent('../outside/secret.png')}`)).status, 404);
});

// ---------- 未配置 outputDir ----------
test('未配置 outputDir 时列表返回 501', async () => {
  const cfg2 = loadConfig({ configFile: '', overrides: { token: TOKEN, upstream: 'http://127.0.0.1:9', webDir: webRoot } });
  const gw2 = createGateway(cfg2, webRoot);
  const port2 = await listen(gw2.server);
  try {
    const res = await fetch(`http://127.0.0.1:${port2}/gw/output-list`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 501);
  } finally {
    await gw2.close();
  }
});
