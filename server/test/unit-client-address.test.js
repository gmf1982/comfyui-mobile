/**
 * 客户端地址判定：隧道场景下不能把隧道进程的地址当成所有手机。
 * 2026-09-27 事故：经 cloudflared 访问时网关看到的对端是 127.0.0.1，
 * 手机重试触发封禁后，所有经隧道的客户端（含手机）一并被封。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientAddress } from '../src/gateway.js';

const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

test('回环连接优先采用隧道注入的客户端地址', () => {
  assert.equal(clientAddress(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7');
  assert.equal(clientAddress(req('::1', { 'cf-connecting-ip': '203.0.113.8' })), '203.0.113.8');
  assert.equal(clientAddress(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' })), '198.51.100.4');
});

test('直连（非回环）沿用对端地址，不受伪造头影响', () => {
  assert.equal(clientAddress(req('10.123.45.67', { 'cf-connecting-ip': '203.0.113.7' })), '10.123.45.67');
  assert.equal(clientAddress(req('100.64.0.23')), '100.64.0.23');
});

test('回环且无客户端地址头时退回回环地址（本机/无隧道请求）', () => {
  assert.equal(clientAddress(req('127.0.0.1')), '127.0.0.1');
  assert.equal(clientAddress(req(undefined)), 'unknown');
});
