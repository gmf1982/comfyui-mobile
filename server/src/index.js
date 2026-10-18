/**
 * 网关入口：解析 CLI/env → 加载配置 → 启动 http(s) 服务器 → 打印访问地址。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseArgOverrides } from './config.js';
import { createGateway } from './gateway.js';
import { resolveTailscale, configureTailscale } from './tunnel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');

function envOverrides() {
  const out = {};
  if (process.env.COMFY_MOBILE_PORT) out.port = Number(process.env.COMFY_MOBILE_PORT);
  if (process.env.COMFY_MOBILE_UPSTREAM) out.upstream = process.env.COMFY_MOBILE_UPSTREAM;
  if (process.env.COMFY_MOBILE_TOKEN) out.token = process.env.COMFY_MOBILE_TOKEN;
  return out;
}

const argOverrides = parseArgOverrides(process.argv.slice(2));
const configFile = argOverrides.config
  ?? process.env.COMFY_MOBILE_CONFIG
  ?? path.join(projectRoot, 'server', 'config.json');

let cfg;
try {
  cfg = loadConfig({ configFile, overrides: { ...envOverrides(), ...argOverrides } });
} catch (err) {
  console.error(`[comfyui-mobile] Config error / 配置错误：${err.message}`);
  process.exit(1);
}

const webRoot = path.resolve(projectRoot, argOverrides.web ?? cfg.webDir ?? 'web');
/** 启动过程中收集到的可用链接，最后写入「手机链接.txt」（免去每次翻终端）。 */
const collectUrls = [];
const gateway = createGateway(cfg, webRoot);

gateway.server.listen(cfg.port, cfg.host, async () => {
  const scheme = cfg.tls ? 'https' : 'http';
  const token = cfg.token;

  /** 收集可访问地址：本机 + 各网卡 IPv4（排除链路本地 169.254.*） */
  const interfaces = []; // { name, address }
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;
      interfaces.push({ name, address: addr.address });
    }
  }
  const urlOf = (ip) => `${scheme}://${ip}:${cfg.port}/?token=${token}`;
  const localUrl = urlOf('127.0.0.1');

  console.log('==========================================================');
  console.log('  ComfyUI Mobile gateway is running / 网关已启动');
  console.log(`  Upstream ComfyUI : ${cfg.upstream}`);
  console.log('');

  const modes = Array.isArray(cfg.tunnel) ? cfg.tunnel : (cfg.tunnel ? [cfg.tunnel] : []);
  let tunnelReady = false;
  for (const mode of modes) {
    if (await setupTailscaleTunnel({ cfg, port: cfg.port, mode })) tunnelReady = true;
  }

  // 只显示 Tailscale 地址；隧道不可用时才退回本机/局域网，避免无从连接
  if (!tunnelReady) {
    collectUrls.push({ label: '本机', url: localUrl });
    for (const { address } of interfaces) collectUrls.push({ label: '局域网', url: urlOf(address) });
    console.log('  未启用可用的 Tailscale 地址，改用本机/局域网地址（仅同一网络可用）：');
    for (const u of collectUrls) console.log('  ' + u.url);
    if (!cfg.tls) console.log('  ⚠ HTTP 明文：请勿把该地址直接暴露到公网。');
    console.log('  想出门在外也能连？只需做一次：① 电脑装 Tailscale（https://tailscale.com/download）');
    console.log('  ② 打开 Tailscale 登录 ③ 把 server/config.json 里的 "tunnel": false 改为 "tunnel": "serve"，重启网关。');
  }
  console.log('==========================================================');

  // 所有隧道建立完成后落盘，避免写入空列表
  writeLinksFile();
});

/**
 * 建立 Tailscale Serve/Funnel 隧道：地址绑定机器名，**进程重启后保持不变**。
 * funnel = 公网可访问（手机无需装 Tailscale）；serve = 仅 tailnet 内（更快）。
 */
async function setupTailscaleTunnel({ cfg, port, mode = 'serve' }) {
  const isPublic = mode === 'funnel';
  const bin = await resolveTailscale(cfg);
  if (!bin) {
    console.log('  ⚠ 未找到 tailscale 命令，跳过 Tailscale 隧道。');
    console.log('    安装：https://tailscale.com/download');
    return null;
  }
  try {
    const { url } = await configureTailscale({
      bin,
      localPort: port,
      httpsPort: cfg.tailscaleHttpsPort ?? 8443,
      public: isPublic,
    });
    const permanentUrl = `${url}/?token=${cfg.token}`;
    console.log(`  ${isPublic ? 'Tailscale Funnel（公网）' : 'Tailscale Serve（仅 tailnet）'}：`);
    console.log('  ' + permanentUrl);
    console.log('');
    collectUrls.push({ label: isPublic ? 'Tailscale Funnel' : 'Tailscale Serve', url: permanentUrl, permanent: true });
    return permanentUrl;
  } catch (err) {
    console.log(`  ⚠ Tailscale 隧道配置失败：${err.message}`);
    return null;
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('\n[comfyui-mobile] 正在关闭…');
    await gateway.close();
    process.exit(0);
  });
}

/**
 * 把本次启动的可用链接写入项目根目录的「手机链接.txt」，便于直接打开查看。
 * 全部为永久地址（Tailscale 绑定机器名，重启网关/电脑都不变）。
 */
function writeLinksFile() {
  if (!collectUrls.length) return;
  const stamp = new Date().toLocaleString('zh-CN');
  const hasTunnel = collectUrls.some((u) => u.permanent);
  const lines = [
    'ComfyUI Mobile —— 手机访问链接',
    '（生成时间：' + stamp + '）',
    '',
    hasTunnel ? 'Tailscale 永久地址（重启网关/电脑都不变）：' : '本机/局域网地址（仅同一网络可用）：',
  ];
  for (const u of collectUrls) lines.push('  ' + u.label + '：' + u.url);
  lines.push('');
  lines.push('提示：手机第一次打开需要带上链接里的 ?token=…，之后浏览器会记住登录。');
  if (!hasTunnel) {
    lines.push('');
    lines.push('想出门在外也能访问？外网访问教程（只需设置一次）：');
    lines.push('  1. 电脑安装 Tailscale：https://tailscale.com/download （Windows 下载后双击安装即可）');
    lines.push('  2. 打开 Tailscale，用浏览器登录（免费注册一个账号就行）');
    lines.push('  3. 用记事本打开网关目录 server 文件夹里的 config.json（绿色版在 app\\server 里），');
    lines.push('     把 "tunnel": false 改成 "tunnel": "serve"，保存后关掉网关窗口再重新打开');
    lines.push('     · serve（推荐）：手机也要装 Tailscale App 并登录同一账号，速度最快、不暴露公网');
    lines.push('     · funnel：手机什么都不用装，走公网中继较慢；改成 "funnel" 即可');
    lines.push('  4. 重启后本文件会出现 Tailscale 永久地址，手机保存它，以后在任何地方都能连');
  }
  try {
    const file = path.join(projectRoot, '手机链接.txt');
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    console.log('已把以上链接写入：' + file);
  } catch (err) {
    console.log('写入 手机链接.txt 失败：' + err.message);
  }
}
