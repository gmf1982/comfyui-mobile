/**
 * cloudflared 快速隧道集成：无需账号与公网 IP，自动获得 HTTPS 公网地址。
 * 仅依赖 cloudflared 单文件（PATH / 项目根 / 配置路径均可）。
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** 从 cloudflared 输出中解析 trycloudflare 公网地址。 */
export function parseTunnelUrl(text) {
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text ?? '');
  return match ? match[0] : null;
}

function whichSync(cmd) {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    execFile(finder, [cmd], (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout).split(/\r?\n/)[0]?.trim();
      resolve(first || null);
    });
  });
}

/**
 * 定位 cloudflared 可执行文件：显式配置 → PATH → 常见安装位置 → 项目根。
 * @param {{cloudflared?: string}} cfg
 * @param {string} projectRoot
 * @returns {Promise<string|null>}
 */
export async function resolveCloudflared(cfg, projectRoot) {
  const explicit = cfg.cloudflared || process.env.COMFY_MOBILE_CLOUDFLARED || '';
  const candidates = [];
  if (explicit) candidates.push(explicit);
  candidates.push(process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  candidates.push(
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
    '/opt/homebrew/bin/cloudflared',
    path.join(projectRoot, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
  );
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) || candidate.includes('\\') || candidate.includes('/')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const found = await whichSync(candidate);
    // where/which 输出按系统 ANSI 编码（Windows 中文为 GBK），按 UTF-8 解码会把
    // 非 ASCII 路径变成 U+FFFD 乱码；存在性校验可淘汰这类损坏结果
    if (found && existsSync(found)) return found;
  }
  return null;
}

/**
 * 启动快速隧道并等待公网地址。
 * @param {{ targetUrl: string, cloudflaredPath: string, timeoutMs?: number, onLog?: (line: string) => void }} options
 * @returns {Promise<{ url: string, child: import('node:child_process').ChildProcess }>}
 */
export function startTunnel({ targetUrl, cloudflaredPath, timeoutMs = 60_000, onLog }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cloudflaredPath, ['tunnel', '--url', targetUrl, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`cloudflared ${Math.round(timeoutMs / 1000)}s 内未返回隧道地址（检查网络或手动运行确认）`));
    }, timeoutMs);

    const handle = (chunk) => {
      const text = chunk.toString();
      output += text;
      onLog?.(text.trim());
      if (settled) return;
      const url = parseTunnelUrl(output);
      if (url) {
        settled = true;
        clearTimeout(timer);
        resolve({ url, child });
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle); // cloudflared 日志走 stderr
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 cloudflared：${err.message}`));
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared 提前退出（code ${code}）`));
    });
  });
}

// ---------------- Tailscale Serve / Funnel（永久地址） ----------------

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
