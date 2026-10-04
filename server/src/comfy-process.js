/**
 * ComfyUI 进程管理：探测 upstream 是否有 ComfyUI 在运行，并按本地配置拉起它。
 *
 * 安全边界：启动命令只来自 server/config.json 的 comfyuiLaunch（本机文件，不入库），
 * 网络请求永远无法指定「启动什么」——/gw/comfyui/start 只能触发这一个写死的动作，
 * 因此即使令牌泄露，可做的最坏事情也只是启动 ComfyUI 本身，而非任意命令执行。
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 模块级状态：跟踪最近一次拉起的子进程（仅本进程内存，网关重启后靠探测恢复认知）。 */
let child = null;
let lastSpawnAt = 0;

/** 两次真实拉起的最小间隔：上游未就绪时上游请求洪峰不会连发多份 ComfyUI。 */
const SPAWN_DEBOUNCE_MS = 15_000;

/** 探测 upstream 是否有 ComfyUI 在运行（2 秒超时，不可达即视为未运行）。 */
export async function probeUpstream(cfg) {
  try {
    const res = await fetch(new URL('/system_stats', cfg.upstream), { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** comfyuiLaunch 是否已配置（未配置时 /gw/comfyui/start 报 400，前端隐藏启动按钮）。 */
export function comfyLaunchConfigured(cfg) {
  return typeof cfg.comfyuiLaunch === 'string' && cfg.comfyuiLaunch.trim() !== '';
}

/** 子进程是否仍在运行（exitCode/signalCode 均为 null 表示未退出）。 */
function childAlive() {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

/** 当前进程状态：running 以探测为准；starting 是「已 spawn 但 upstream 尚未就绪」。 */
export async function comfyStatus(cfg) {
  const running = await probeUpstream(cfg);
  const alive = childAlive();
  return {
    configured: comfyLaunchConfigured(cfg),
    running,
    starting: !running && alive,
    pid: alive ? child.pid : null,
  };
}

/**
 * 拉起 ComfyUI（命令取自 cfg.comfyuiLaunch，经 shell 启动以支持 .bat 与含空格的带引号路径）。
 * @param {object} cfg 网关配置
 * @param {{ logsDir: string }} io 日志目录：ComfyUI 的 stdout/stderr 追加写入 logsDir/comfyui.log
 * @returns {Promise<{ok: boolean, status?: string, pid?: number, code?: number, error?: string, message?: string}>}
 */
export async function startComfyUI(cfg, { logsDir }) {
  if (!comfyLaunchConfigured(cfg)) {
    return { ok: false, code: 400, error: 'launch_not_configured', message: '网关未配置 ComfyUI 启动命令（server/config.json 的 comfyuiLaunch）' };
  }
  if (await probeUpstream(cfg)) return { ok: true, status: 'already-running' };
  if (childAlive()) return { ok: true, status: 'starting', pid: child.pid };
  if (Date.now() - lastSpawnAt < SPAWN_DEBOUNCE_MS) {
    return { ok: true, status: 'starting', ...(childAlive() ? { pid: child.pid } : {}) };
  }
  lastSpawnAt = Date.now();

  fs.mkdirSync(logsDir, { recursive: true });
  const out = fs.openSync(path.join(logsDir, 'comfyui.log'), 'a');
  const proc = spawn(cfg.comfyuiLaunch.trim(), {
    shell: true, // 启动命令来自本机配置（与网关代码同信任级），shell 才能跑 .bat 与带引号路径
    cwd: resolveCwd(cfg),
    detached: true, // ComfyUI 独立于网关生命周期：网关重启不影响已拉起的 ComfyUI
    windowsHide: true,
    stdio: ['ignore', out, out],
  });
  child = proc;
  const releaseFd = () => { try { fs.closeSync(out); } catch { /* 已关闭 */ } };
  proc.once('spawn', releaseFd);
  proc.once('error', (err) => {
    // spawn 失败（如命令不存在）只发 error 不发 exit：清掉引用，否则状态会永远卡在 starting
    if (child === proc) child = null;
    releaseFd();
    appendLog(logsDir, `拉起失败：${err.message}`);
  });
  proc.once('exit', (code, signal) => {
    if (child === proc) child = null;
    appendLog(logsDir, `ComfyUI 进程退出：code=${code} signal=${signal ?? '-'}`);
  });
  proc.unref();
  appendLog(logsDir, `已拉起 ComfyUI：pid=${proc.pid} cmd=${cfg.comfyuiLaunch.trim()}`);
  return { ok: true, status: 'starting', pid: proc.pid };
}

/**
 * 重启 ComfyUI：结束监听 upstream 端口的进程树（含网关自己拉起的，也含用户手动启动的），再按 comfyuiLaunch 重新拉起。
 * 仅支持本机 upstream（杀远端机器的端口毫无意义也绝不允许）；未配置启动命令时拒绝——否则「重启」等于只杀不拉。
 * @param {object} cfg 网关配置
 * @param {{ logsDir: string }} io 日志目录
 */
export async function restartComfyUI(cfg, { logsDir }) {
  if (!comfyLaunchConfigured(cfg)) {
    return { ok: false, code: 400, error: 'launch_not_configured', message: '网关未配置 ComfyUI 启动命令（server/config.json 的 comfyuiLaunch）' };
  }
  let url;
  try { url = new URL(cfg.upstream); } catch { return { ok: false, code: 400, error: 'invalid_upstream', message: 'upstream 配置不合法' }; }
  const host = url.hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    return { ok: false, code: 400, error: 'restart_local_only', message: `重启仅支持本机 upstream（当前 ${host}）` };
  }
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  if (port === cfg.port) {
    return { ok: false, code: 400, error: 'invalid_upstream', message: 'upstream 不能指向网关自身端口' };
  }
  // 刚拉起 15 秒保护期内不重复重启：连点/双击不会杀掉刚起来的进程
  if (childAlive() && Date.now() - lastSpawnAt < SPAWN_DEBOUNCE_MS) {
    return { ok: true, status: 'starting', pid: child.pid };
  }
  // 走到这里意味着保护期已过：清掉 start 的防抖时间戳，保证重启收尾一定真正拉起
  // （否则「spawn 崩溃后 15 秒内重启」会被防抖拦成 starting，永不恢复）
  lastSpawnAt = 0;
  if (!(await probeUpstream(cfg))) {
    return startComfyUI(cfg, { logsDir }); // 本就没运行 → 等价于启动
  }
  appendLog(logsDir, `收到重启请求：结束监听 ${host}:${port} 的进程树后重新拉起`);
  await killTrackedChild();
  const killed = await killUpstreamListeners(port);
  if (!killed && (await probeUpstream(cfg))) {
    return { ok: false, code: 502, error: 'kill_failed', message: `未能结束 ${host}:${port} 上的 ComfyUI 进程（权限不足或进程不受管）` };
  }
  // 等端口真正释放再拉起（taskkill 后套接字一般即刻释放，最多等 8 秒）
  const deadline = Date.now() + 8000;
  while (await probeUpstream(cfg)) {
    if (Date.now() > deadline) {
      return { ok: false, code: 502, error: 'kill_failed', message: `结束进程后 ${host}:${port} 仍可访问，放弃重启` };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return startComfyUI(cfg, { logsDir });
}

/** 结束网关自己拉起的子进程树（cmd 包装壳 + 其下的 python 等）。 */
async function killTrackedChild() {
  if (!childAlive()) return;
  await killTree(child.pid);
  child = null;
}

/** 按端口找到监听进程并结束其进程树。返回是否找到并结束了至少一个进程。 */
async function killUpstreamListeners(port) {
  if (process.platform === 'win32') {
    const out = await execP('netstat', ['-ano', '-p', 'tcp']);
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
      if (m && Number(m[1]) === port) pids.add(m[2]);
    }
    for (const pid of pids) await killTree(pid);
    return pids.size > 0;
  }
  const out = await execP('lsof', ['-t', `-i:${port}`]); // POSIX 尽力而为：lsof 不存在时返回空
  const pids = out.split(/\s+/).filter(Boolean);
  for (const pid of pids) await execP('kill', ['-9', pid]);
  return pids.length > 0;
}

/** taskkill /T /F（Windows）或 kill -9（POSIX，先试进程组）结束进程树。 */
async function killTree(pid) {
  if (process.platform === 'win32') {
    await execP('taskkill', ['/T', '/F', '/PID', String(pid)]);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 进程已退出 */ }
  }
}

/** execFile 的 Promise 化：失败返回空串而非抛出（调用方按「没找到」处理）。 */
function execP(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout ?? '')));
  });
}

/** 工作目录：显式 comfyuiCwd 优先；否则取启动命令首个带路径分隔符记号的目录（run_nvidia_gpu.bat 场景）。 */
function resolveCwd(cfg) {
  if (typeof cfg.comfyuiCwd === 'string' && cfg.comfyuiCwd.trim()) return path.resolve(cfg.comfyuiCwd);
  const token = firstToken(cfg.comfyuiLaunch ?? '');
  if (/[/\\]/.test(token)) {
    const dir = path.dirname(path.resolve(token));
    if (fs.existsSync(dir)) return dir;
  }
  return process.cwd();
}

/** 取命令行首个记号（兼容 "C:\Program Files\..." 带引号路径）。 */
function firstToken(launch) {
  const match = /^\s*"?([^"\s]+)"?/.exec(launch);
  return match ? match[1] : '';
}

function appendLog(logsDir, line) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, 'comfyui.log'), `${new Date().toISOString()} ${line}\n`);
  } catch { /* 日志写失败不影响主流程 */ }
}
