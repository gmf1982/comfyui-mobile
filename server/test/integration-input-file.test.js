/** 网关输入目录接口（/gw/input-files 列表 + /gw/input-file 删除）的集成测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockComfy } from './helpers/mock-comfy.js';
import { createGateway } from '../src/gateway.js';
import { loadConfig } from '../src/config.js';

const TOKEN = 'input-file-test-token';
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const mock = createMockComfy({ execDelayMs: 50 });
const mockPort = await listen(mock.server);
const inDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-in-'));

async function makeGateway(extra = {}) {
  const cfg = loadConfig({
    configFile: '',
    overrides: { token: TOKEN, upstream: `http://127.0.0.1:${mockPort}`, webDir: webRoot, ...extra },
  });
  const gw = createGateway(cfg, webRoot);
  const port = await listen(gw.server);
  return { gw, base: `http://127.0.0.1:${port}` };
}

const withDir = await makeGateway({ inputDir: inDir });
const withoutDir = await makeGateway({});

test.after(async () => {
  await withDir.gw.close();
  await withoutDir.gw.close();
  await mock.close();
  fs.rmSync(inDir, { recursive: true, force: true });
});

function authed(base, pathname, params = {}, method = 'GET') {
  const q = new URLSearchParams(params);
  return fetch(`${base}${pathname}${q.toString() ? `?${q}` : ''}`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
}

test('未配置 inputDir 时列表与删除都返回 501', async () => {
  assert.equal((await authed(withoutDir.base, '/gw/input-files')).status, 501);
  assert.equal((await authed(withoutDir.base, '/gw/input-file', { filename: 'a.png' }, 'DELETE')).status, 501);
});

test('列表返回媒体文件并按修改时间倒序', async () => {
  const old = path.join(inDir, 'a_old.png');
  const fresh = path.join(inDir, 'b_fresh.jpg');
  fs.writeFileSync(old, 'x');
  fs.writeFileSync(fresh, 'yy');
  // 保证 mtime 有差异（同一毫秒内写入时顺序不稳定）
  const st = fs.statSync(old);
  fs.utimesSync(old, st.atime, new Date(Date.now() - 60_000));
  const res = await authed(withDir.base, '/gw/input-files');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.files.map((f) => f.name), ['b_fresh.jpg', 'a_old.png']);
  assert.equal(body.files[0].size, 2);
  // 非媒体文件不出现在列表里
  fs.writeFileSync(path.join(inDir, 'notes.txt'), 'x');
  const again = await (await authed(withDir.base, '/gw/input-files')).json();
  assert.equal(again.files.some((f) => f.name === 'notes.txt'), false);
});

test('删除 input 目录媒体文件；子目录可用', async () => {
  fs.mkdirSync(path.join(inDir, 'clips'), { recursive: true });
  const nested = path.join(inDir, 'clips', 'c.mp4');
  fs.writeFileSync(nested, 'x');
  assert.equal((await authed(withDir.base, '/gw/input-file', { filename: 'c.mp4', subfolder: 'clips' }, 'DELETE')).status, 200);
  assert.equal(fs.existsSync(nested), false);
  assert.equal((await authed(withDir.base, '/gw/input-file', { filename: 'missing.png' }, 'DELETE')).status, 404);
});

test('路径穿越、非媒体扩展名、绝对路径被拒绝', async () => {
  const outside = path.join(os.tmpdir(), 'cm-input-secret.txt');
  fs.writeFileSync(outside, 'secret');
  const cases = [
    { filename: '../outside.png' },
    { filename: 'x.png', subfolder: '..' },
    { filename: 'evil.exe' },
    { filename: 'notes.txt' },
    { filename: path.join(os.tmpdir(), 'whatever.png') },
  ];
  for (const params of cases) {
    const res = await authed(withDir.base, '/gw/input-file', params, 'DELETE');
    assert.ok(res.status === 400 || res.status === 404, `应拒绝：${JSON.stringify(params)} → ${res.status}`);
  }
  assert.equal(fs.existsSync(outside), true, 'input 目录外的文件必须不受影响');
});

test('input 接口需要令牌', async () => {
  fs.writeFileSync(path.join(inDir, 'authcheck.png'), 'x');
  const list = await fetch(`${withDir.base}/gw/input-files`);
  assert.equal(list.status, 401);
  const del = await fetch(`${withDir.base}/gw/input-file?filename=authcheck.png`, { method: 'DELETE' });
  assert.equal(del.status, 401);
  assert.equal(fs.existsSync(path.join(inDir, 'authcheck.png')), true);
});

test('inputDir 未配置但配置了 outputDir 时按同级推导', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-out-'));
  const derived = loadConfig({ configFile: '', overrides: { token: TOKEN, outputDir: outDir } });
  assert.equal(path.resolve(derived.inputDir), path.resolve(outDir, '..', 'input'));
  fs.rmSync(outDir, { recursive: true, force: true });
});
