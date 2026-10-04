/** 集成测试：网关本地缩略图（/view?preview=webp 本地缩放 + 磁盘缓存）与代理媒体缓存头。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createMockComfy } from './helpers/mock-comfy.js';
import { createGateway } from '../src/gateway.js';
import { loadConfig } from '../src/config.js';

const TOKEN = 'thumb-test-token';
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

function makeFixturePng(width = 800, height = 600) {
  return sharp({ create: { width, height, channels: 3, background: { r: 120, g: 90, b: 60 } } }).png().toBuffer();
}

async function makeGateway(overrides = {}) {
  const cfg = loadConfig({
    configFile: '',
    overrides: { token: TOKEN, webDir: webRoot, ...overrides },
  });
  const gw = createGateway(cfg, webRoot);
  const port = await listen(gw.server);
  return { gw, base: `http://127.0.0.1:${port}`, cfg };
}

function authed(base, pathname, params = {}, method = 'GET', extraHeaders = {}) {
  const q = new URLSearchParams(params);
  return fetch(`${base}${pathname}${q.toString() ? `?${q}` : ''}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, ...extraHeaders } });
}

const metaOf = async (res) => sharp(Buffer.from(await res.arrayBuffer())).metadata();

// ---------- 本地生成组：上游指向不存在的端口，命中本地缩略图就不会走到代理 ----------
const localDirs = { in: fs.mkdtempSync(path.join(os.tmpdir(), 'cm-th-in-')), out: fs.mkdtempSync(path.join(os.tmpdir(), 'cm-th-out-')), cache: fs.mkdtempSync(path.join(os.tmpdir(), 'cm-th-ca-')) };
const local = await makeGateway({
  // 端口 9（discard）无监听：一旦回退代理必然 502，可证明响应来自本地
  upstream: 'http://127.0.0.1:9',
  inputDir: localDirs.in,
  outputDir: localDirs.out,
  thumbCacheDir: localDirs.cache,
});

// ---------- 代理回退组：上游是 mock，验证不拦截的场景与缓存头注入 ----------
const mock = createMockComfy({});
const mockPort = await listen(mock.server);
const fallback = await makeGateway({ upstream: `http://127.0.0.1:${mockPort}` });

test.after(async () => {
  await local.gw.close();
  await fallback.gw.close();
  await mock.close();
  for (const dir of Object.values(localDirs)) fs.rmSync(dir, { recursive: true, force: true });
});

test('loadConfig 把 thumbCacheDir 默认派生到 config.json 同目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-th-cfg-'));
  const cfg = loadConfig({ configFile: path.join(dir, 'config.json'), overrides: { token: TOKEN } });
  assert.equal(path.resolve(cfg.thumbCacheDir), path.join(dir, '.thumb-cache'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('preview=webp 的 input 图片由网关本地缩放为 WebP，不经过上游', async () => {
  fs.writeFileSync(path.join(localDirs.in, 'fixture.png'), await makeFixturePng());
  const res = await authed(local.base, '/view', { filename: 'fixture.png', type: 'input', preview: 'webp;70' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /image\/webp/);
  assert.match(res.headers.get('cache-control') ?? '', /max-age=3600/, 'input 类型缓存 1 小时（前端 v=mtime 版本参数防陈旧）');
  const meta = await metaOf(res);
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 512, '最长边缩到默认 512');
  assert.equal(meta.height, 384, '保持宽高比 800×600');
});

test('w 参数控制尺寸且不放大；quality 进缓存键', async () => {
  const small = await authed(local.base, '/view', { filename: 'fixture.png', type: 'input', preview: 'webp;70', w: '200' });
  assert.equal((await metaOf(small)).width, 200);
  const noEnlarge = await authed(local.base, '/view', { filename: 'fixture.png', type: 'input', preview: 'webp;70', w: '2048' });
  assert.equal((await metaOf(noEnlarge)).width, 800, '源图 800px 时不放大');
  // 三个不同参数 → 三份缓存
  assert.equal(fs.readdirSync(localDirs.cache).length, 3);
});

test('同参数重复请求命中磁盘缓存', async () => {
  // 用独立文件保证可定位其缓存项（此前测试已生成多份不同参数的缓存，目录顺序不可靠）
  fs.writeFileSync(path.join(localDirs.in, 'cacheprobe.png'), await makeFixturePng());
  const params = { filename: 'cacheprobe.png', type: 'input', preview: 'webp;70' };
  const filesBefore = new Set(fs.readdirSync(localDirs.cache));
  await authed(local.base, '/view', params);
  const newFile = fs.readdirSync(localDirs.cache).find((f) => !filesBefore.has(f));
  assert.ok(newFile, '首次请求应生成恰好一份新缓存');
  // 篡改缓存内容为另一张有效 WebP：若走缓存应返回篡改后的内容，重新生成则返回原图缩放
  const sentinel = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 0, g: 200, b: 0 } } }).webp().toBuffer();
  fs.writeFileSync(path.join(localDirs.cache, newFile), sentinel);
  const second = await authed(local.base, '/view', params);
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), Buffer.from(sentinel), '第二次应直接返回缓存内容');
});

test('mtime 变化后重新生成新缩略图', async () => {
  const target = path.join(localDirs.in, 'fixture.png');
  const st = fs.statSync(target);
  fs.utimesSync(target, st.atime, new Date(st.mtimeMs + 60_000));
  const before = fs.readdirSync(localDirs.cache).length;
  const res = await authed(local.base, '/view', { filename: 'fixture.png', type: 'input', preview: 'webp;70' });
  assert.equal(res.status, 200);
  assert.equal(fs.readdirSync(localDirs.cache).length, before + 1, '新键 → 新缓存文件');
});

test('output 类型缩略图用长缓存；HEAD 请求只回头', async () => {
  fs.writeFileSync(path.join(localDirs.out, 'gen.png'), await makeFixturePng(1024, 256));
  const res = await authed(local.base, '/view', { filename: 'gen.png', type: 'output', preview: 'webp;70' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /max-age=86400/, 'output 类型视为不可变');
  assert.equal((await metaOf(res)).height, 128, '1024×256 → 512×128');

  const head = await authed(local.base, '/view', { filename: 'gen.png', type: 'output', preview: 'webp;70' }, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')) > 0, true, 'HEAD 应有 Content-Length');
  assert.equal(Number(head.headers.get('content-length')), Number(res.headers.get('content-length')));
});

test('ETag 协商缓存：max-age 过期后 If-None-Match 命中只回 304', async () => {
  fs.writeFileSync(path.join(localDirs.in, 'etag.png'), await makeFixturePng());
  const params = { filename: 'etag.png', type: 'input', preview: 'webp;70' };
  const first = await authed(local.base, '/view', params);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag?.startsWith('"') && etag?.endsWith('"'), '应返回带引号的强 ETag');

  const revalidated = await authed(local.base, '/view', params, 'GET', { 'If-None-Match': etag });
  assert.equal(revalidated.status, 304);
  assert.equal((await revalidated.arrayBuffer()).byteLength, 0, '304 无响应体');
  assert.equal(revalidated.headers.get('etag'), etag);
  assert.match(revalidated.headers.get('cache-control') ?? '', /max-age=3600/, '304 也带缓存策略，浏览器据此续期');

  const weak = await authed(local.base, '/view', params, 'GET', { 'If-None-Match': `W/${etag}` });
  assert.equal(weak.status, 304, '弱匹配 W/ 前缀同样命中');

  const st = fs.statSync(path.join(localDirs.in, 'etag.png'));
  fs.utimesSync(path.join(localDirs.in, 'etag.png'), st.atime, new Date(st.mtimeMs + 120_000));
  const changed = await authed(local.base, '/view', params, 'GET', { 'If-None-Match': etag });
  assert.equal(changed.status, 200, '文件 mtime 变化 → 缓存键变化 → 旧 ETag 失效回全量');
  assert.notEqual(changed.headers.get('etag'), etag);
});

test('非图片扩展名与 preview=jpeg 不拦截，走代理（mock 响应）', async () => {
  const video = await authed(fallback.base, '/view', { filename: 'clip.mp4', type: 'output', preview: 'webp;70' });
  assert.match(video.headers.get('content-type') ?? '', /video\/mp4/, '视频不缩略');
  const jpeg = await authed(fallback.base, '/view', { filename: 'a.png', type: 'output', preview: 'jpeg;70' });
  assert.match(jpeg.headers.get('content-type') ?? '', /image\/png/, 'jpeg 预览格式仍由上游处理');
});

test('代理透传的媒体响应补 Cache-Control（output/input 分级）', async () => {
  const out = await authed(fallback.base, '/view', { filename: 'a.png', type: 'output' });
  assert.match(out.headers.get('cache-control') ?? '', /max-age=86400/);
  const inp = await authed(fallback.base, '/view', { filename: 'a.png', type: 'input' });
  assert.match(inp.headers.get('cache-control') ?? '', /max-age=3600/);
  const json = await authed(fallback.base, '/history');
  assert.match(json.headers.get('cache-control') ?? '', /no-cache/, '/history 走 ETag 协商缓存');
});

test('inputDir 未配置 / 源文件缺失 / 图片损坏时回退代理', async () => {
  const noDir = await authed(fallback.base, '/view', { filename: 'a.png', type: 'input', preview: 'webp;70' });
  assert.match(noDir.headers.get('content-type') ?? '', /image\/png/, '未配置目录 → 代理透传上游');

  const missing = await authed(local.base, '/view', { filename: 'missing.png', type: 'input', preview: 'webp;70' });
  assert.equal(missing.status, 502, '目录已配置但文件不在盘且上游不可达 → 代理报上游错误');

  fs.writeFileSync(path.join(localDirs.in, 'broken.png'), 'not a real png');
  const broken = await authed(local.base, '/view', { filename: 'broken.png', type: 'input', preview: 'webp;70' });
  assert.equal(broken.status, 502, '解码失败退回代理，上游不可达时暴露 502');
});
