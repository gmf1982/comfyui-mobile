/**
 * 令牌轮换与防爆破的交互约束：
 * 客户端不得因自身轮询而把自己封在门外（2026-09-27 实际发生过）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('401 后停止后台轮询，登录成功再恢复（防自封）', () => {
  const app = fs.readFileSync('web/js/app.js', 'utf8');
  assert.match(app, /function stopBackgroundPolling\(\)/, '应有停止轮询');
  assert.match(app, /function resumeBackgroundPolling\(\)/, '应有恢复轮询');
  assert.match(app, /if \(!backgroundPolling\) return;/, '轮询应受开关控制');
  const unauth = app.slice(app.indexOf("bus.addEventListener('cm:unauthorized'"));
  assert.match(unauth.slice(0, 400), /stopBackgroundPolling\(\)/, '401 时应停止轮询');
  const login = app.slice(app.indexOf("bus.addEventListener('cm:login'"));
  assert.match(login.slice(0, 200), /resumeBackgroundPolling\(\)/, '登录后应恢复轮询');
});

test('网关仅把「携带错误令牌」计入防爆破', () => {
  const gw = fs.readFileSync('server/src/gateway.js', 'utf8');
  assert.match(gw, /function tokenProvided\(req, url\)/, '应有令牌存在性判断');
  assert.match(gw, /if \(tokenProvided\(req, url\)\) onAuthFail\(ip\);/, '仅错误令牌计入');
  // 未登录（无令牌）不应触发计数
  const block = gw.slice(gw.indexOf('if (!requestAuthorized(req, url))'), gw.indexOf('if (!requestAuthorized(req, url))') + 400);
  assert.doesNotMatch(block, /^\s*onAuthFail\(ip\);\s*$/m, '不应无条件计数');
});
