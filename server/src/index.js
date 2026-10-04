/**
 * 网关入口：解析 CLI/env → 加载配置 → 启动 http(s) 服务器 → 打印配对二维码。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseArgOverrides } from './config.js';
import { createGateway } from './gateway.js';
import { resolveCloudflared, startTunnel, resolveTailscale, configureTailscale } from './tunnel.js';

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
  console.error(`[comfyui-mobile] 配置错误：${err.message}`);
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
  const isTailscale = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
  const isPrivateLan = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

  const urlOf = (ip) => `${scheme}://${ip}:${cfg.port}/?token=${token}`;
  const localUrl = urlOf('127.0.0.1');
  // 二维码优先指向局域网地址（在家扫码即用）；无局域网时退回本机地址
  const qrIp = (interfaces.find((i) => isPrivateLan(i.address)) ?? interfaces[0])?.address ?? '127.0.0.1';

  console.log('==========================================================');
  console.log('  ComfyUI Mobile 网关已启动');
  console.log(`  上游 ComfyUI : ${cfg.upstream}`);
  console.log(`  访问令牌     : ${token}`);
  console.log('');
  console.log('  可用地址（方括号为网卡名，Tailscale 即外网可用）：');
  console.log(`    [本机]       ${localUrl}`);
  for (const { name, address } of interfaces) {
    const tag = isTailscale(address) ? '（外网可用）' : '';
    console.log(`    [${name}] ${tag} ${urlOf(address)}`);
  }
  console.log('==========================================================');
  if (!cfg.tls) {
    console.log('  ⚠ 当前为 HTTP 明文，公网直连会泄露令牌；建议 Tailscale 等隧道或配置 tls 证书。');
  }

  await printQr(urlOf(qrIp)).catch(() => {});

  // 二维码下方输出无前缀纯链接，方便整行复制粘贴到手机浏览器
  console.log('');
  collectUrls.push({ label: '本机', url: localUrl, permanent: true });
  for (const { address } of interfaces) collectUrls.push({ label: '局域网', url: urlOf(address), permanent: true });
  console.log('手机浏览器打开任一链接即可自动配对（整行复制粘贴；以下为局域网/本机地址，重启不变）：');
  console.log(localUrl);
  for (const { address } of interfaces) {
    console.log(urlOf(address));
  }
  console.log('');

  const modes = Array.isArray(cfg.tunnel) ? cfg.tunnel : (cfg.tunnel ? [cfg.tunnel] : []);
  for (const mode of modes) {
    if (mode === 'serve' || mode === 'funnel') {
      await setupTailscaleTunnel({ cfg, port: cfg.port, mode });
    } else {
      await setupTunnel({ cfg, scheme, port: cfg.port, urlOf });
    }
  }

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
    console.log('⚠ 已选择 Tailscale 隧道，但未找到 tailscale 命令：');
    console.log('  安装后重试，或在 config.json 的 tailscale 字段填写完整路径。');
    console.log('  下载：https://tailscale.com/download');
    return;
  }
  try {
    const { url, created } = await configureTailscale({
      bin,
      localPort: port,
      httpsPort: cfg.tailscaleHttpsPort ?? 8443,
      public: isPublic,
    });
    const permanentUrl = `${url}/?token=${cfg.token}`;
    console.log('==========================================================');
    console.log(`  ✅ ${isPublic ? 'Tailscale Funnel（公网）' : 'Tailscale Serve（仅 tailnet）'} 已就绪`);
    console.log('  该地址为【永久地址】：绑定机器名，重启网关/重启电脑都不变。');
    console.log(`  永久地址 : ${permanentUrl}`);
    if (isPublic) {
      console.log('  公网可访问：手机无需安装 Tailscale，任何网络直接打开。');
      console.log('  令牌是唯一凭证，请勿泄露链接。');
    } else {
      console.log('  仅 tailnet 内可用：手机需登录同一 Tailscale 账号（速度更快）。');
      console.log(`  如需公网访问：tailscale funnel --bg --https=${cfg.tailscaleHttpsPort ?? 8443} http://127.0.0.1:${port}`);
    }
    console.log(`  （${created ? '本次已新建' : '复用已有'}配置；关闭：tailscale ${isPublic ? 'funnel' : 'serve'} --https=${cfg.tailscaleHttpsPort ?? 8443} off）`);
    console.log('==========================================================');
    await printQr(permanentUrl).catch(() => {});
    collectUrls.push({ label: isPublic ? '公网（Funnel）' : 'Tailscale 直连', url: permanentUrl, permanent: true });
    console.log('手机打开永久地址（整行复制粘贴）：');
    console.log(permanentUrl);
    console.log(`  测速：手机上打开 ${url}/gw/speedtest?mb=8 可测该路径吞吐（越大越慢说明链路受限）。`);
    console.log('');
  } catch (err) {
    console.log(`⚠ Tailscale 隧道配置失败：${err.message}`);
    console.log('  局域网地址不受影响；也可手动执行：tailscale funnel --bg --https=8443 http://127.0.0.1:' + port);
  }
}

/** 建立cloudflared快速隧道并打印公网链接 + 二维码（外网免 Tailscale 直接访问）。 */
async function setupTunnel({ cfg, scheme, port, urlOf }) {
  const cloudflaredPath = await resolveCloudflared(cfg, projectRoot);
  if (!cloudflaredPath) {
    console.log('⚠ 已启用隧道（tunnel），但未找到 cloudflared：');
    console.log('  1) 下载单文件版：https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe');
    console.log('  2) 放到本项目根目录（cloudflared.exe），或加入 PATH，或在 config.json 的 cloudflared 填完整路径');
    console.log('  重新启动网关即可自动建立隧道。');
    return;
  }
  console.log(`正在建立 cloudflared 隧道（${cloudflaredPath}）…`);
  try {
    const { url, child } = await startTunnel({
      targetUrl: `http://127.0.0.1:${port}`,
      cloudflaredPath,
      onLog: () => {}, // 隧道详细日志不刷屏；失败时 exit 事件会提示
    });
    const publicUrl = `${url}/?token=${cfg.token}`;
    console.log('==========================================================');
    console.log('  ✅ 外网隧道已建立（无需 Tailscale / 公网 IP，手机随时可访问）');
    console.log(`  外网链接 : ${publicUrl}`);
    console.log('  该地址公网可达，访问令牌是唯一凭证，请勿泄露链接或令牌。');
    console.log('==========================================================');
    await printQr(publicUrl).catch(() => {});
    collectUrls.push({ label: '公网临时', url: publicUrl, permanent: false });
    console.log('手机打开外网链接（整行复制粘贴）：');
    console.log(publicUrl);
    console.log('');
    child.on('exit', (code) => {
      console.log(`⚠ cloudflared 隧道已断开（code ${code}）：外网链接失效，重启网关可重建（地址会变化）。`);
    });
  } catch (err) {
    console.log(`⚠ 隧道建立失败：${err.message}`);
    console.log('  局域网/Tailscale 地址不受影响；也可手动运行 cloudflared 排查。');
  }
}

async function printQr(url) {
  try {
    const qrcode = (await import('qrcode')).default;
    console.log(await qrcode.toString(url, { type: 'terminal', small: true }));
  } catch {
    // qrcode 缺失只影响二维码展示，链接文本已给出
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
 * 永久（重启不变）与临时（重启会变）分组列出。
 */
function writeLinksFile() {
  if (!collectUrls.length) return;
  const stamp = new Date().toLocaleString('zh-CN');
  const lines = [
    'ComfyUI Mobile —— 手机访问链接',
    '（生成时间：' + stamp + '）',
    '',
  ];
  const permanent = collectUrls.filter((u) => u.permanent);
  const temporary = collectUrls.filter((u) => !u.permanent);
  if (permanent.length) {
    lines.push('【推荐】永久地址（重启网关/电脑都不变）：');
    for (const u of permanent) lines.push('  ' + u.label + '：' + u.url);
    lines.push('');
  }
  if (temporary.length) {
    lines.push('临时地址（重启网关后会变；手机没开 Tailscale 时用）：');
    for (const u of temporary) lines.push('  ' + u.url);
    lines.push('');
  }
  lines.push('提示：手机第一次打开需要带上链接里的 ?token=…，之后浏览器会记住登录。');
  try {
    const file = path.join(projectRoot, '手机链接.txt');
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    console.log('已把以上链接写入：' + file);
  } catch (err) {
    console.log('写入 手机链接.txt 失败：' + err.message);
  }
}
