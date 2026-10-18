/**
 * 构建 Windows 绿色版（免安装）：
 *   dist/ComfyUI-Mobile/
 *     ComfyUI-Mobile.exe   SEA 启动器（双击启动网关）
 *     runtime/node.exe     随包 Node 运行时
 *     app/                 网关代码 + 运行时依赖（npm ci --omit=dev）
 *     快速开始.txt
 *   dist/ComfyUI-Mobile-v<版本>-win-x64-portable.zip
 *
 * 用法：node scripts/build-portable.mjs   （需要网络：下载 Node 与 postject）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_VERSION = 'v22.23.3'; // 随包运行时版本（绿色版用户无需自装 Node）
const CACHE = path.join(ROOT, 'build-cache');
const DIST = path.join(ROOT, 'dist');
const PKG = path.join(DIST, 'ComfyUI-Mobile');
const APP = path.join(PKG, 'app');

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const ZIP_NAME = `ComfyUI-Mobile-v${version}-win-x64-portable.zip`;

function run(cmd, args, opts = {}) {
  // Windows 上 Node 20.12+ 禁止无 shell 直接 spawn .cmd（CVE-2024-27980），npm/npx 需走 shell
  const useShell = process.platform === 'win32' && ['npm', 'npx'].includes(cmd);
  if (useShell) cmd += '.cmd';
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: useShell, ...opts });
  if (r.status !== 0) throw new Error(`命令失败 / command failed: ${cmd} ${args.join(' ')}`);
}

async function download(url, dest) {
  if (fs.existsSync(dest)) return;
  console.log(`下载 / downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 / download failed ${res.status}: ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  // 1) 下载并校验随包 Node 运行时
  const zipName = `node-${NODE_VERSION}-win-x64.zip`;
  const nodeZip = path.join(CACHE, zipName);
  const nodeDir = path.join(CACHE, `node-${NODE_VERSION}-win-x64`);
  await download(`https://nodejs.org/dist/${NODE_VERSION}/${zipName}`, nodeZip);
  await download(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, path.join(CACHE, 'SHASUMS256.txt'));
  const expected = fs
    .readFileSync(path.join(CACHE, 'SHASUMS256.txt'), 'utf8')
    .split('\n')
    .find((line) => line.includes(zipName))
    ?.trim()
    .split(/\s+/)[0];
  if (!expected) throw new Error(`SHASUMS256.txt 中找不到 ${zipName}`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(nodeZip)).digest('hex');
  if (actual !== expected) throw new Error(`Node zip 校验失败 / sha256 mismatch: ${actual} != ${expected}`);
  // Git Bash 的 GNU tar 会把 "D:\" 解析成远程主机，Windows 上固定用系统 bsdtar
  const tar = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  if (!fs.existsSync(path.join(nodeDir, 'node.exe'))) run(tar, ['-xf', nodeZip, '-C', CACHE]);

  // 2) 组装 app/（只带运行时代码，绝不带本机配置、令牌、缓存、日志）
  fs.rmSync(PKG, { recursive: true, force: true });
  fs.mkdirSync(path.join(APP, 'server'), { recursive: true });
  for (const dir of ['server/src', 'web', 'scripts']) {
    fs.cpSync(path.join(ROOT, dir), path.join(APP, dir), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(APP, file));
  }
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: APP });

  // 3) SEA 启动器：blob 注入 node.exe 副本
  run(process.execPath, ['--experimental-sea-config', 'packaging/sea-config.json']);
  const exe = path.join(PKG, 'ComfyUI-Mobile.exe');
  fs.copyFileSync(path.join(nodeDir, 'node.exe'), exe);
  run('npx', [
    '--yes', 'postject', exe, 'NODE_SEA_BLOB', path.join(CACHE, 'sea-prep.blob'),
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ]);
  fs.mkdirSync(path.join(PKG, 'runtime'), { recursive: true });
  fs.copyFileSync(path.join(nodeDir, 'node.exe'), path.join(PKG, 'runtime', 'node.exe'));

  // 4) 快速开始说明
  fs.writeFileSync(path.join(PKG, '快速开始.txt'), QUICK_START(version));

  // 5) 隐私断言：产物里绝不能出现本机配置/令牌/缓存/日志
  const forbidden = ['config.json', '手机链接.txt', '.thumb-cache', 'logs', '.privacy-patterns', '本地备注.md'];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (forbidden.includes(e.name) && !p.includes(path.join('app', 'node_modules'))) {
        throw new Error(`产物含禁入文件 / forbidden file in package: ${p}`);
      }
      if (e.isDirectory()) walk(p);
    }
  };
  walk(PKG);
  for (const must of [exe, path.join(PKG, 'runtime', 'node.exe'), path.join(APP, 'node_modules', 'sharp')]) {
    if (!fs.existsSync(must)) throw new Error(`产物缺少必需文件 / missing: ${must}`);
  }

  // 6) 压缩
  const zip = path.join(DIST, ZIP_NAME);
  fs.rmSync(zip, { force: true });
  run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${PKG}' -DestinationPath '${zip}' -Force`]);
  const mb = (fs.statSync(zip).size / 1024 / 1024).toFixed(1);
  console.log(`\n完成 / done: ${zip} (${mb} MB)`);
}

function QUICK_START(v) {
  return `ComfyUI Mobile 网关 v${v} — 快速开始（免安装绿色版）

1. 双击 ComfyUI-Mobile.exe 启动网关。窗口里会显示日志和访问地址；
   关闭该窗口即停止网关。
2. 首次启动自动生成配置和访问令牌，并在 app\\ 目录下生成「手机链接.txt」，
   里面是手机可直接打开的链接。电脑浏览器打开 http://127.0.0.1:8899 即可使用。
3. 本包已自带 Node.js 运行时，无需安装任何东西。
   ComfyUI 和 Tailscale 是外部程序：请确保电脑上的 ComfyUI 能正常打开
   （默认对接 http://127.0.0.1:8188）；需要外网访问时再安装 Tailscale。
4. 首次运行若 Windows 提示「已保护你的电脑」（SmartScreen，因程序未签名）：
   点「更多信息」→「仍要运行」。
5. 想开机自动运行网关：以管理员不需要，直接运行 app\\scripts\\install-autostart.bat
   （创建当前用户的计划任务；卸载用同目录 uninstall-autostart.bat）。
6. 想出门在外也能用手机连电脑（外网访问，只需设置一次）：
   ① 电脑安装 Tailscale：https://tailscale.com/download （下载后双击安装）
   ② 打开 Tailscale，用浏览器登录（免费注册一个账号即可）
   ③ 用记事本打开 app\\server\\config.json，把 "tunnel": false 改成 "tunnel": "serve"，
      保存后关掉网关窗口再重新双击打开
   ④ 手机也安装 Tailscale App 并登录同一账号，之后「手机链接.txt」里的
      Tailscale 地址在任何地方都能打开
   · serve（推荐）：点对点直连最快、不暴露公网，但手机要装 Tailscale
   · funnel：手机什么都不用装，走公网中继较慢；把上面改成 "funnel" 即可

--- Quick Start (portable, no installation needed) ---

1. Double-click ComfyUI-Mobile.exe to start the gateway. The console window
   shows logs and the access URL; close the window to stop it.
2. On first run a config with a random access token is generated, and
   "手机链接.txt" (phone link) appears in the app\\ folder.
   Open http://127.0.0.1:8899 in a browser on this PC.
3. Node.js is bundled — nothing to install. ComfyUI and Tailscale are
   external programs (ComfyUI must already run at http://127.0.0.1:8188).
4. If SmartScreen says "Windows protected your PC" (the exe is unsigned):
   click "More info" → "Run anyway".
5. To auto-start at logon: run app\\scripts\\install-autostart.bat
   (user-level scheduled task; uninstall with uninstall-autostart.bat).
6. To reach the gateway from outside your home network (one-time setup):
   ① Install Tailscale on the PC: https://tailscale.com/download
   ② Open Tailscale and log in with a free account.
   ③ Edit app\\server\\config.json: change "tunnel": false to "tunnel": "serve",
      save, then close and reopen the gateway window.
   ④ Install the Tailscale app on your phone and sign in with the same account;
      the Tailscale URL in "手机链接.txt" then works anywhere.
   · serve (recommended): fastest peer-to-peer, not exposed to the public net.
   · funnel: nothing to install on the phone, but slower via public relay —
     use "funnel" instead of "serve" in step ③.
`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
