/**
 * Tailscale Serve / Funnel 集成：永久 HTTPS 地址（绑定机器名，重启不变）。
 * 仅依赖本机已安装的 tailscale 命令（PATH / 默认安装位置 / 配置路径均可）。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function whichSync(cmd) {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    // Windows 的 where 会先搜子进程当前目录；网关常以项目根为 cwd，cwd 命中会抢在
    // 「PATH → 常见安装位置 → 项目根」的声明顺序之前。钉到临时目录，让 where 只看
    // PATH（POSIX 的 which 本就不搜 cwd）。
    execFile(finder, [cmd], { cwd: os.tmpdir() }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout).split(/\r?\n/)[0]?.trim();
      resolve(first || null);
    });
  });
}

/**
 * 定位 tailscale 可执行文件（Windows 默认安装路径 / PATH）。
 * @param {{tailscale?: string}} cfg
 * @returns {Promise<string|null>}
 */
export async function resolveTailscale(cfg = {}) {
  const explicit = cfg.tailscale || process.env.COMFY_MOBILE_TAILSCALE || '';
  const candidates = [];
  if (explicit) candidates.push(explicit);
  candidates.push(
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
  );
  candidates.push(process.platform === 'win32' ? 'tailscale.exe' : 'tailscale');
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const found = await whichSync(candidate);
    if (found && existsSync(found)) return found;
  }
  return null;
}

/**
 * 从 `tailscale serve status` / `funnel status` 输出中解析代理到本机端口的地址。
 * @param {string} text 命令输出
 * @param {number} localPort 本机监听端口
 * @returns {string|null} 形如 https://host:8443 的地址
 */
export function parseTailscaleStatus(text, localPort) {
  const lines = String(text ?? '').split(/\r?\n/);
  let host = null;
  for (const line of lines) {
    const urlMatch = /^\s*(https:\/\/\S+?)(?:\s|$)/.exec(line);
    if (urlMatch) {
      host = urlMatch[1];
      if (host.endsWith('/')) host = host.slice(0, -1);
      continue;
    }
    if (host && /proxy\s+http:\/\/127\.0\.0\.1:/.test(line)) {
      const port = /127\.0\.0\.1:(\d+)/.exec(line);
      if (port && Number(port[1]) === localPort) return host;
      host = null;
    }
  }
  return null;
}

function run(bin, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n').slice(-3).join(' ')));
      else resolve(String(stdout));
    });
  });
}

/**
 * 让本机网关获得一个永久 HTTPS 地址（绑定机器名，进程重启后不变）。
 * @param {{bin: string, localPort: number, httpsPort?: number, public?: boolean}} options
 *        public=true 用 funnel（公网可访问，手机无需装 Tailscale）；
 *        public=false 用 serve（仅 tailnet 内可访问，更快）。
 * @returns {Promise<{url: string, mode: 'funnel'|'serve', created: boolean}>}
 */
export async function configureTailscale({ bin, localPort, httpsPort = 8443, public: isPublic = false }) {
  const port = String(httpsPort);
  const sub = isPublic ? 'funnel' : 'serve';
  const target = `http://127.0.0.1:${localPort}`;
  const status = async () => {
    try {
      return await run(bin, [sub, 'status']);
    } catch {
      return '';
    }
  };
  const existing = parseTailscaleStatus(await status(), localPort);
  if (existing) return { url: existing, mode: sub, created: false };

  await run(bin, [sub, '--bg', `--https=${port}`, target], 60000);
  const after = parseTailscaleStatus(await status(), localPort);
  if (!after) throw new Error(`tailscale ${sub} 已执行但未在状态中找到代理到 ${localPort} 的地址`);
  return { url: after, mode: sub, created: true };
}

/** 关闭由本网关建立的 Tailscale 代理。 */
export async function disableTailscale({ bin, httpsPort = 8443, public: isPublic = false }) {
  const sub = isPublic ? 'funnel' : 'serve';
  await run(bin, [sub, `--https=${httpsPort}`, 'off']);
}
