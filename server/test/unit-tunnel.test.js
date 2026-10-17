/** tunnel.js（Tailscale）与隧道配置的单元测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseTailscaleStatus, resolveTailscale } from '../src/tunnel.js';
import { loadConfig } from '../src/config.js';

test('parseTailscaleStatus 按本机端口匹配（区分多条 serve/funnel 规则）', () => {
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

test('resolveTailscale 显式路径存在时优先返回', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-tunnel-'));
  const fake = path.join(dir, process.platform === 'win32' ? 'tailscale.exe' : 'tailscale');
  fs.writeFileSync(fake, '#!/bin/sh\n');
  const found = await resolveTailscale({ tailscale: fake });
  assert.equal(found, fake);
});

test('隧道模式配置：true→serve、字符串模式、非法值报错', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cfg-')), 'config.json');
  assert.equal(loadConfig({ configFile: file, overrides: { tunnel: 'true' } }).tunnel, 'serve');
  assert.equal(loadConfig({ configFile: file, overrides: { tunnel: 'false' } }).tunnel, false);
  assert.equal(loadConfig({ configFile: file, overrides: { tunnel: 'funnel' } }).tunnel, 'funnel');
  assert.equal(loadConfig({ configFile: file, overrides: { tunnel: 'serve' } }).tunnel, 'serve');
  assert.equal(loadConfig({ configFile: file, overrides: { tunnel: 'off' } }).tunnel, false);
  assert.equal(loadConfig({ configFile: file, overrides: { tunnel: 'serve,funnel' } }).tunnel.join(','), 'serve,funnel');
  assert.equal(loadConfig({ configFile: file, overrides: { tunnel: 'funnel', tailscaleHttpsPort: '8443' } }).tailscaleHttpsPort, 8443);
  assert.throws(() => loadConfig({ configFile: file, overrides: { tunnel: 'bogus' } }), /tunnel 取值非法/);
  assert.throws(() => loadConfig({ configFile: file, overrides: { tunnel: 'quick' } }), /tunnel 取值非法/);
});
