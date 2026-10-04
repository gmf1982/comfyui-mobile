/** 网关输出文件删除接口的单元/集成测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createMockComfy } from './helpers/mock-comfy.js';
import { createGateway } from '../src/gateway.js';
import { loadConfig } from '../src/config.js';

const TOKEN = 'delete-test-token';
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const mock = createMockComfy({ execDelayMs: 50 });
const mockPort = await listen(mock.server);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-out-'));

async function makeGateway(extra = {}) {
  const cfg = loadConfig({
    configFile: '',
    overrides: { token: TOKEN, upstream: `http://127.0.0.1:${mockPort}`, webDir: webRoot, ...extra },
  });
  const gw = createGateway(cfg, webRoot);
  const port = await listen(gw.server);
  return { gw, base: `http://127.0.0.1:${port}` };
}

const withDir = await makeGateway({ outputDir: outDir });
const withoutDir = await makeGateway({});

test.after(async () => {
  await withDir.gw.close();
  await withoutDir.gw.close();
  await mock.close();
  fs.rmSync(outDir, { recursive: true, force: true });
});

function del(base, params) {
  const q = new URLSearchParams(params);
  return fetch(`${base}/gw/output-file?${q}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
}

test('未配置 outputDir 时删除返回 501（历史删除仍可用）', async () => {
  const res = await del(withoutDir.base, { filename: 'a.png', type: 'output' });
  assert.equal(res.status, 501);
  assert.equal((await res.json()).error, 'output_dir_unconfigured');
});

test('删除输出目录中的媒体文件', async () => {
  const file = path.join(outDir, 'pic_00001_.png');
  fs.writeFileSync(file, 'x');
  const res = await del(withDir.base, { filename: 'pic_00001_.png', type: 'output' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deleted, 'pic_00001_.png');
  assert.equal(fs.existsSync(file), false, '文件应被删除');
});

test('子目录中的文件可删除，不存在的文件返回 404', async () => {
  fs.mkdirSync(path.join(outDir, 'VHS'), { recursive: true });
  const file = path.join(outDir, 'VHS', 'clip_00001_.mp4');
  fs.writeFileSync(file, 'x');
  assert.equal((await del(withDir.base, { filename: 'clip_00001_.mp4', subfolder: 'VHS' })).status, 200);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await del(withDir.base, { filename: 'nope.png' })).status, 404);
});

test('路径穿越与非媒体扩展名被拒绝', async () => {
  const outside = path.join(os.tmpdir(), 'cm-secret.txt');
  fs.writeFileSync(outside, 'secret');
  const cases = [
    { filename: '..%2F..%2Fcm-secret.txt'.replace(/%2F/g, '/'), type: 'output' },
    { filename: '../outside.png' },
    { filename: path.join(os.tmpdir(), 'outside.png') },
    { filename: 'evil.exe' },
    { filename: 'notes.txt' },
    { filename: 'x.png', subfolder: '..' },
    { filename: 'x.png', type: 'input' },
  ];
  for (const params of cases) {
    const res = await del(withDir.base, params);
    assert.ok(res.status === 400 || res.status === 404, `应拒绝：${JSON.stringify(params)} → ${res.status}`);
  }
  assert.equal(fs.existsSync(outside), true, '输出目录外的文件必须不受影响');
});

test('删除接口需要令牌', async () => {
  fs.writeFileSync(path.join(outDir, 'auth.png'), 'x');
  const res = await fetch(`${withDir.base}/gw/output-file?filename=auth.png`, { method: 'DELETE' });
  assert.equal(res.status, 401);
  assert.equal(fs.existsSync(path.join(outDir, 'auth.png')), true);
});

test('历史删除接口透传（图库移除记录）', async () => {
  const res = await fetch(`${withDir.base}/history`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ delete: ['whatever-id'] }),
  });
  assert.equal(res.status, 200);
});
