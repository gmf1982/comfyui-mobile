/**
 * 缓存头与偏好同步的集成测试：
 * - /userdata 等 JSON 响应必须带 Cache-Control: no-store（否则浏览器启发式缓存
 *   会在保存覆盖后继续提供旧副本——2026-09-28 「保存后重开是旧内容」事故的根因）；
 * - /gw/* 本机文件操作不占用写操作限流（批量删除是正常用法）；
 * - 偏好同步文件（cm_sync/prefs.json）走通用 userdata 接口可读写。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockComfy } from './helpers/mock-comfy.js';
import { createGateway } from '../src/gateway.js';
import { loadConfig } from '../src/config.js';

const TOKEN = 'cache-headers-test-token';
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const mock = createMockComfy({ execDelayMs: 20 });
const mockPort = await listen(mock.server);
const inDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cache-in-'));

const cfg = loadConfig({
  configFile: '',
  overrides: { token: TOKEN, upstream: `http://127.0.0.1:${mockPort}`, webDir: webRoot, inputDir: inDir, rateLimitPerMin: 3 },
});
const gw = createGateway(cfg, webRoot);
const port = await listen(gw.server);
const base = `http://127.0.0.1:${port}`;

test.after(async () => {
  await gw.close();
  await mock.close();
  fs.rmSync(inDir, { recursive: true, force: true });
});

const authed = (pathname, opts = {}) => fetch(`${base}${pathname}`, {
  ...opts,
  headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.headers ?? {}) },
});

test('JSON 响应带 Cache-Control: no-store（保存后重开必须读到新内容）', async () => {
  // 建一个工作流文件再读回
  await authed('/userdata/workflows%2Fcache-test.json?overwrite=true', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}',
  });
  const res = await authed('/userdata/workflows%2Fcache-test.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  // 列表类 JSON 同样生效
  const list = await authed('/userdata?dir=workflows&recurse=true&split=false');
  assert.equal(list.headers.get('cache-control'), 'no-store');
});

test('非 JSON 的媒体响应不强制 no-store（视频进度条依赖缓存）', async () => {
  const res = await authed('/view?filename=sample.png&subfolder=&type=input');
  // mock 可能 404，无所谓：只要不是 JSON 就不该有 no-store
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    assert.notEqual(res.headers.get('cache-control'), 'no-store');
  }
});

test('/history 列表用 ETag 协商缓存（内容未变 304 省流量，变化回全量）', async () => {
  // 夹具的 mock 没有历史：先提交一次运行让 /history 有内容
  const submit = await authed('/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: { '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'etag' } } } }),
  });
  assert.equal(submit.status, 200);
  await new Promise((r) => setTimeout(r, 60)); // mock 执行 20ms 后历史才落账

  const first = await authed('/history?max_items=10');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const etag = first.headers.get('etag');
  assert.match(etag ?? '', /^"h/, 'ETag 应为内容哈希');
  const body = await first.text();

  // 同内容重放：浏览器会自动带上 If-None-Match，网关应回 304 空体
  const replay = await authed('/history?max_items=10', { headers: { 'If-None-Match': etag } });
  assert.equal(replay.status, 304);
  assert.equal((await replay.text()).length, 0);

  // 内容变化（删除该条历史）→ ETag 变化，返回全量新内容
  const firstId = Object.keys(JSON.parse(body))[0];
  const del = await authed('/history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [firstId] }),
  });
  assert.ok(del.status < 300, `删除历史应成功，实际 ${del.status}`);
  const changed = await authed('/history?max_items=10', { headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  assert.notEqual(await changed.text(), body);

  // 其余 JSON（/userdata）保持 no-store 不受影响
  const ud = await authed('/userdata?dir=workflows&recurse=true&split=false');
  assert.equal(ud.headers.get('cache-control'), 'no-store');
});

test('/gw/* 写操作不占用写限流（超过 rateLimitPerMin 仍成功）', async () => {
  // rateLimitPerMin=3：先打满 3 个上游写
  for (let i = 0; i < 3; i++) {
    const res = await authed(`/userdata/workflows%2Frl-${i}.json?overwrite=true`, { method: 'POST', body: '{}' });
    assert.ok((res.status >= 200 && res.status < 300) || res.status === 429, `上游写应 2xx 或 429，实际 ${res.status}`);
  }
  // 第 4 个上游写应被限流
  const limited = await authed('/userdata/workflows%2Frl-over.json?overwrite=true', { method: 'POST', body: '{}' });
  assert.equal(limited.status, 429);
  // 但 /gw 的文件操作照常可用
  for (let i = 0; i < 5; i++) {
    const name = `rl-file-${i}.png`;
    fs.writeFileSync(path.join(inDir, name), 'x');
    const del = await authed(`/gw/input-file?filename=${encodeURIComponent(name)}`, { method: 'DELETE' });
    assert.equal(del.status, 200, `/gw/input-file 不应被写限流拦截（第 ${i + 1} 个）`);
  }
});

test('偏好同步文件走通用 userdata 接口可读写（跨域名共享收藏/设置）', async () => {
  // 独立网关实例：上面用例已把共享限流桶打满
  const cfg2 = loadConfig({ configFile: '', overrides: { token: TOKEN, upstream: `http://127.0.0.1:${mockPort}`, webDir: webRoot } });
  const gw2 = createGateway(cfg2, webRoot);
  const port2 = await listen(gw2.server);
  const base2 = `http://127.0.0.1:${port2}`;
  const authed2 = (pathname, opts = {}) => fetch(`${base2}${pathname}`, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.headers ?? {}) } });
  const prefs = JSON.stringify({ v: 1, updatedAt: 123, favorites: ['a.json'], settings: { theme: 'light' }, openWorkflows: [] });
  const post = await authed2('/userdata/cm_sync%2Fprefs.json?overwrite=true', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: prefs,
  });
  assert.ok(post.status >= 200 && post.status < 300, `偏好写入应 2xx，实际 ${post.status}`);
  const get = await authed2('/userdata/cm_sync%2Fprefs.json');
  assert.equal(get.status, 200);
  const body = await get.json();
  assert.equal(body.updatedAt, 123);
  assert.deepEqual(body.favorites, ['a.json']);
  await gw2.close();
});
