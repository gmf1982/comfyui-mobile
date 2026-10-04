/** tunnel.js 与隧道配置的单元测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseTunnelUrl, resolveCloudflared } from '../src/tunnel.js';
import { loadConfig } from '../src/config.js';

test('parseTunnelUrl 从 cloudflared 日志中提取公网地址', () => {
  const sample = `
2026-09-26T12:00:00Z INF +--------------------------------------------------------------------------------------------+
2026-09-26T12:00:00Z INF |  Your quick Tunnel has been created! Visit it at (may take some time to appear):  https://a-b-c.trycloudflare.com |
2026-09-26T12:00:00Z INF +--------------------------------------------------------------------------------------------+
`;
  assert.equal(parseTunnelUrl(sample), 'https://a-b-c.trycloudflare.com');
  assert.equal(parseTunnelUrl('no url here'), null);
  assert.equal(parseTunnelUrl(''), null);
  assert.equal(parseTunnelUrl(undefined), null);
});

test('resolveCloudflared 显式路径存在时优先返回', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-tunnel-'));
  const fake = path.join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  fs.writeFileSync(fake, '#!/bin/sh\n');
  const found = await resolveCloudflared({ cloudflared: fake }, os.tmpdir());
  assert.equal(found, fake);
});

test('resolveCloudflared 项目根放置的单文件可被发现', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-root-'));
  const fake = path.join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  fs.writeFileSync(fake, '');
  const found = await resolveCloudflared({}, dir);
  assert.equal(found, fake);
});

test('resolveCloudflared 找不到时返回 null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-empty-'));
  const found = await resolveCloudflared({ cloudflared: path.join(dir, 'missing.exe') }, dir);
  assert.equal(found, null);
});

test('resolveCloudflared 不受进程当前目录干扰（where 不再搜 cwd）', async () => {
  const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cwd-'));
  fs.writeFileSync(path.join(cwdDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'), '');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-empty2-'));
  const prevCwd = process.cwd();
  process.chdir(cwdDir);
  try {
    const found = await resolveCloudflared({ cloudflared: path.join(empty, 'missing.exe') }, empty);
    assert.equal(found, null);
  } finally {
    process.chdir(prevCwd);
  }
});

test('tunnel 配置接受 CLI 布尔字符串（true 等价 quick）', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cfg-')), 'config.json');
  assert.equal(loadConfig({ configFile: file, overrides: { tunnel: 'true' } }).tunnel, 'quick');
  assert.equal(loadConfig({ configFile: file, overrides: { tunnel: 'false' } }).tunnel, false);
});

test('parseTailscaleStatus 按本机端口匹配（区分多条 serve/funnel 规则）', async () => {
  const { parseTailscaleStatus } = await import('../src/tunnel.js');
  const serveStatus = `https://example-machine.example-tailnet.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8188

https://example-machine.example-tailnet.ts.net:8443 (Funnel on)
|-- / proxy http://127.0.0.1:8899
`;
  assert.equal(parseTailscaleStatus(serveStatus, 8899), 'https://example-machine.example-tailnet.ts.net:8443');
  assert.equal(parseTailscaleStatus(serveStatus, 8188), 'https://example-machine.example-tailnet.ts.net');
  assert.equal(parseTailscaleStatus(serveStatus, 9999), null, '未配置的端口应返回 null');
  assert.equal(parseTailscaleStatus('', 8899), null);
  assert.equal(parseTailscaleStatus('no proxy here', 8899), null);
});

test('隧道模式配置：true→quick、字符串模式、非法值报错', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cfg-')), 'config.json');
  assert.equal(loadConfig({ configFile: file, overrides: { tunnel: 'true' } }).tunnel, 'quick');
  assert.equal(loadConfig({ configFile: file, overrides: { tunnel: 'funnel' } }).tunnel, 'funnel');
  assert.equal(loadConfig({ configFile: file, overrides: { tunnel: 'serve' } }).tunnel, 'serve');
  assert.equal(loadConfig({ configFile: file, overrides: { tunnel: 'off' } }).tunnel, false);
  assert.equal(loadConfig({ configFile: file, overrides: { tunnel: 'funnel', tailscaleHttpsPort: '8443' } }).tailscaleHttpsPort, 8443);
  assert.throws(() => loadConfig({ configFile: file, overrides: { tunnel: 'bogus' } }), /tunnel 取值非法/);
});
