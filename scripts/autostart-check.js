/**
 * 网关保活检查：网关健康则直接退出；无响应则以分离进程拉起网关（日志写 logs/gateway.log）。
 * 由 scripts/gateway-keepalive.vbs 在计划任务里以隐藏窗口运行，也可手动 `node scripts/autostart-check.js` 调试。
 * 幂等：多个实例并发时最多多起一个网关，多余者因端口占用立即退出，下一轮自愈。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logsDir = path.join(root, 'logs');

function log(line) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, 'autostart.log'), `${new Date().toISOString()} ${line}\n`);
  } catch { /* 日志写失败不影响主流程 */ }
}

/** 端口与网关一致：优先读 server/config.json 的 port，读不到用默认 8899。 */
function readPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'server', 'config.json'), 'utf8'));
    return Number.isInteger(cfg.port) && cfg.port > 0 ? cfg.port : 8899;
  } catch {
    return 8899;
  }
}

const port = readPort();
const healthy = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })
  .then((r) => r.ok)
  .catch(() => false);
if (healthy) {
  log(`网关健康（127.0.0.1:${port}），无需处理`);
  process.exit(0);
}

const out = fs.openSync(path.join(logsDir, 'gateway.log'), 'a');
const child = spawn(process.execPath, [path.join(root, 'server', 'src', 'index.js')], {
  cwd: root,
  detached: true, // 与本检查进程分离：检查退出后网关继续常驻
  windowsHide: true,
  stdio: ['ignore', out, out],
});
const releaseFd = () => { try { fs.closeSync(out); } catch { /* 已关闭 */ } };
child.once('spawn', releaseFd);
child.once('error', (err) => {
  releaseFd();
  log(`网关拉起失败：${err.message}`);
});
child.unref();
log(`网关无响应（127.0.0.1:${port}），已拉起进程 pid=${child.pid}`);
