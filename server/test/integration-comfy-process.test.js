/** 集成测试：/gw/comfyui/status 与 /gw/comfyui/start——本地配置拉起 ComfyUI、防抖、鉴权、不回显启动命令。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../src/gateway.js';
import { loadConfig } from '../src/config.js';

const TOKEN = 'comfy-process-test-token';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const webRoot = path.join(root, 'web');
const mockScript = path.join(root, 'scripts', 'mock-comfy.js');
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

function makeGateway(overrides = {}) {
  const cfg = loadConfig({
    configFile: '',
    overrides: { token: TOKEN, upstream: 'http://127.0.0.1:9', ...overrides },
  });
  const gw = createGateway(cfg, webRoot);
  return listen(gw.server).then((port) => ({ gw, base: `http://127.0.0.1:${port}`, cfg }));
}

const authHeaders = { Authorization: `Bearer ${TOKEN}` };

async function getStatus(base) {
  const res = await fetch(`${base}/gw/comfyui/status`, { headers: authHeaders });
  return { res, data: await res.json() };
}

async function postStart(base) {
  return fetch(`${base}/gw/comfyui/start`, { method: 'POST', headers: authHeaders });
}

async function postRestart(base) {
  return fetch(`${base}/gw/comfyui/restart`, { method: 'POST', headers: authHeaders });
}

/** 取一个当前空闲的端口（随后关闭占位 server，用作「尚未监听的 upstream」）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

/** 轮询直到 upstream 探测为 running（mock-comfy 监听后即满足）。 */
async function waitRunning(base, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await getStatus(base);
    if (data.running) return data;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('ComfyUI mock 未在时限内就绪');
}

/** 杀掉网关拉起的子进程树（Windows 上 pid 是 cmd.exe 包装，需 /T 连带子进程）。 */
function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => resolve());
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
      resolve();
    }
  });
}

test('未配置 comfyuiLaunch：status.configured=false，start 返回 400', async (t) => {
  const { base, gw } = await makeGateway({});
  t.after(() => gw.close());

  const { res, data } = await getStatus(base);
  assert.equal(res.status, 200);
  assert.equal(data.configured, false);
  assert.equal(data.running, false);

  const start = await postStart(base);
  assert.equal(start.status, 400);
  assert.equal((await start.json()).error, 'launch_not_configured');
});

test('鉴权仍走网关令牌：无令牌的 start/status 都是 401', async (t) => {
  const { base, gw } = await makeGateway({});
  t.after(() => gw.close());

  assert.equal((await fetch(`${base}/gw/comfyui/status`)).status, 401);
  assert.equal((await fetch(`${base}/gw/comfyui/start`, { method: 'POST' })).status, 401);
});

test('上游已在运行：start 返回 already-running，不拉起新进程', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ system: { comfyui_version: 'stub' } }));
  });
  const port = await listen(upstream);
  t.after(() => new Promise((r) => upstream.close(r)));
  const { base, gw } = await makeGateway({
    upstream: `http://127.0.0.1:${port}`,
    comfyuiLaunch: `"${process.execPath}" "${mockScript}" --port=1`,
  });
  t.after(() => gw.close());

  const start = await postStart(base);
  assert.equal(start.status, 200);
  assert.equal((await start.json()).status, 'already-running');
  const { data } = await getStatus(base);
  assert.equal(data.running, true);
  assert.equal(data.pid, null, '上游本就健康，不应有网关拉起的子进程');
});

test('按本地配置拉起 ComfyUI：starting → running；防抖期内二次 start 不重复拉起；状态不回显命令', async (t) => {
  const port = await freePort();
  const { base, gw } = await makeGateway({
    upstream: `http://127.0.0.1:${port}`,
    comfyuiLaunch: `"${process.execPath}" "${mockScript}" --port=${port}`,
    comfyuiCwd: root,
  });
  t.after(() => gw.close());

  const first = await postStart(base);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.status, 'starting');
  assert.ok(firstBody.pid > 0);

  // 防抖期内二次点击：仍回 starting，pid 不变（同一份子进程）
  const second = await postStart(base);
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.status, 'starting');
  assert.equal(secondBody.pid, firstBody.pid);

  const ready = await waitRunning(base);
  assert.equal(ready.configured, true);
  assert.ok(ready.pid > 0);
  t.after(() => killTree(ready.pid));

  assert.equal(JSON.stringify(ready).includes('mock-comfy'), false, '状态接口绝不回显启动命令');
  assert.equal(JSON.stringify(ready).includes('comfyuiLaunch'), false);

  // 杀掉 mock 后探测应恢复为未运行（starting 也随之归 false）
  await killTree(ready.pid);
  await new Promise((r) => setTimeout(r, 500));
  const { data: after } = await getStatus(base);
  assert.equal(after.running, false);
  assert.equal(after.starting, false);
});

test('restart 防线：未配置 400；非本机 upstream 400；upstream 指向网关自身端口 400', async (t) => {
  const { base, gw } = await makeGateway({});
  t.after(() => gw.close());
  const none = await postRestart(base);
  assert.equal(none.status, 400);
  assert.equal((await none.json()).error, 'launch_not_configured');

  const { base: b2, gw: gw2 } = await makeGateway({ upstream: 'http://192.0.2.1:8188', comfyuiLaunch: 'x.bat' });
  t.after(() => gw2.close());
  const remote = await postRestart(b2);
  assert.equal(remote.status, 400);
  assert.equal((await remote.json()).error, 'restart_local_only', '远端 upstream 绝不尝试杀端口');

  const { base: b3, gw: gw3 } = await makeGateway({ upstream: 'http://127.0.0.1:8899', port: 8899, comfyuiLaunch: 'x.bat' });
  t.after(() => gw3.close());
  const self = await postRestart(b3);
  assert.equal(self.status, 400);
  assert.equal((await self.json()).error, 'invalid_upstream', '绝不允许杀网关自己的端口');
});

test('restart：结束外部启动的 ComfyUI 并重新拉起（转为网关管理）；保护期内二次重启不动手', async (t) => {
  const port = await freePort();
  // 测试进程先起一个「外部」mock，模拟用户手动启动的 ComfyUI（网关对此无 pid 认知）
  const external = spawn(process.execPath, [mockScript, `--port=${port}`], { stdio: 'ignore' });
  t.after(() => { try { external.kill(); } catch { /* 已被重启流程结束 */ } });
  const { base, gw } = await makeGateway({
    upstream: `http://127.0.0.1:${port}`,
    comfyuiLaunch: `"${process.execPath}" "${mockScript}" --port=${port}`,
    comfyuiCwd: root,
  });
  t.after(() => gw.close());

  // 等 external 就绪（网关探测到 running）
  const readyDeadline = Date.now() + 10_000;
  while (Date.now() < readyDeadline) {
    const { data } = await getStatus(base);
    if (data.running) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const before = await getStatus(base);
  assert.equal(before.data.running, true);
  assert.equal(before.data.pid, null, '外部启动的进程不应有网关侧 pid');

  const res = await postRestart(base);
  assert.equal(res.status, 200);
  const restarted = await waitRunning(base);
  assert.ok(restarted.pid > 0, '重启后应由网关拉起并跟踪 pid');
  t.after(() => killTree(restarted.pid));

  // 15 秒保护期内再次重启：不杀新进程（连点/双击保护）
  const res2 = await postRestart(base);
  assert.equal(res2.status, 200);
  assert.equal((await res2.json()).status, 'starting');
  const after = await getStatus(base);
  assert.equal(after.data.running, true, '保护期内 ComfyUI 不被打断');
  assert.equal(after.data.pid, restarted.pid);
});
