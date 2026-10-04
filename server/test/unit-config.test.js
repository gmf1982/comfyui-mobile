/** config.js 单元测试：默认值、覆盖、校验、token 比较。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, tokenMatches, parseArgOverrides } from '../src/config.js';

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cfg-'));
  const file = path.join(dir, 'config.json');
  if (content != null) fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

test('loadConfig 使用默认值并在首次生成 token 后写回文件', () => {
  const file = tmpFile(null);
  const cfg = loadConfig({ configFile: file });
  assert.equal(cfg.port, 8899);
  assert.equal(cfg.upstream, 'http://127.0.0.1:8188');
  assert.match(cfg.token, /^[0-9a-f]{64}$/);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.token, cfg.token, '生成的 token 应写回配置文件');
  const again = loadConfig({ configFile: file });
  assert.equal(again.token, cfg.token, '再次加载应复用已有 token');
});

test('loadConfig 合并文件与覆盖项', () => {
  const file = tmpFile({ port: 9000, upstream: 'http://1.2.3.4:8188' });
  const cfg = loadConfig({ configFile: file, overrides: { port: 9001, webDir: 'w' } });
  assert.equal(cfg.port, 9001);
  assert.equal(cfg.upstream, 'http://1.2.3.4:8188');
  assert.equal(cfg.webDir, 'w');
});

test('loadConfig 校验失败立即抛出', () => {
  const file = tmpFile(null);
  assert.throws(() => loadConfig({ configFile: file, overrides: { port: 99999 } }), /port/);
  assert.throws(() => loadConfig({ configFile: file, overrides: { upstream: 'ftp://x' } }), /upstream/);
  assert.throws(() => loadConfig({ configFile: file, overrides: { maxUploadMB: -1 } }), /maxUploadMB/);
  assert.throws(() => loadConfig({ configFile: file, overrides: { tls: { cert: '' } } }), /tls/);
  assert.throws(() => loadConfig({ configFile: file, overrides: { tls: { cert: 'C:/nope.pem', key: 'C:/nope.key' } } }), /TLS 文件不存在/);
  const badFile = path.join(path.dirname(file), 'bad.json');
  fs.writeFileSync(badFile, '{oops');
  assert.throws(() => loadConfig({ configFile: badFile }), /不是合法 JSON/);
});

test('tokenMatches 常量时间比较', () => {
  assert.equal(tokenMatches('abc123', 'abc123'), true);
  assert.equal(tokenMatches('abc123', 'xyz'), false);
  assert.equal(tokenMatches('abc123', ''), false);
  assert.equal(tokenMatches('abc123', undefined), false);
  assert.equal(tokenMatches('abc123', null), false);
});

test('parseArgOverrides 解析键值与 TLS 专用键', () => {
  const o = parseArgOverrides(['--port=8888', '--token=xyz', '--tls-cert=C:/a.pem', '--tls-key=C:/a.key']);
  assert.equal(o.port, '8888');
  assert.equal(o.token, 'xyz');
  assert.deepEqual(o.tls, { cert: 'C:/a.pem', key: 'C:/a.key' });
  const empty = parseArgOverrides(['--help', '-p', '123']);
  assert.deepEqual(empty, {});
});
