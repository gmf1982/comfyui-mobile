# ComfyUI Mobile

**中文** | [English](#english)

手机（广域网）远程控制电脑上的 ComfyUI：电脑运行一个**安全网关**，手机用浏览器打开即可获得专为竖屏设计的完整操作界面 —— 工作流管理、参数表单、实时进度、图库（图片/视频/音频的打开与保存）、队列、节点图、模型浏览。支持安装为 PWA。

- 开发文档：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)（架构 / API 映射 / 安全设计 / 测试计划）
- 目标 ComfyUI 版本：0.37.0 实测通过（兼容 `/api` 前缀与裸路径的新旧版本）

## 快速开始（电脑端）

```sh
# 1. 安装依赖（Node ≥ 20）
npm install

# 2. 启动网关（默认对接 http://127.0.0.1:8188）
npm start

# 3.（推荐，永久地址）Tailscale Funnel：地址绑定机器名，重启不变，公网可访问
node server/src/index.js --tunnel=funnel
```

首次启动会在 `server/config.json` 自动生成随机访问令牌，并在终端打印：

- **二维码**（在家扫码即用）+ **二维码下方整行可复制的链接列表**（含 Tailscale/隧道地址）
- 启用 `--tunnel=true` 时额外打印 **HTTPS 公网链接**（手机在任何网络都能打开），隧道需要 [cloudflared](https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe) 单文件——下载后放到项目根目录即可被自动发现

Windows 也可直接双击 `启动.bat`（默认开什么隧道由 `config.json` 的 `"tunnel"` 决定：`"funnel"` 公网永久、`"serve"` 仅 tailnet 永久、`"quick"` 临时）。

> **平台说明**：网关是纯 Node.js（≥ 20）、手机端是纯网页，本身不挑平台；但本文档与 `启动.bat`、开机自启脚本、远程启动示例均以 **Windows** 为准撰写并实测。Linux / macOS 可用 `start.sh` 启动网关，开机自启需自行配置（如 systemd / launchd），未经实测。

### 常用参数

```sh
node server/src/index.js --port=8899 --upstream=http://127.0.0.1:8188 --token=<你的令牌> --tunnel=true
```

配置文件 `server/config.json`（自动生成）：

```json
{
  "port": 8899,
  "upstream": "http://127.0.0.1:8188",
  "token": "<64 位随机 hex>",
  "tls": { "cert": "", "key": "" },
  "maxUploadMB": 512,
  "rateLimitPerMin": 120,
  "outputDir": "",
  "inputDir": "",
  "thumbCacheDir": "",
  "tunnel": "funnel",
  "tailscaleHttpsPort": 8443,
  "cloudflared": "",
  "comfyuiLaunch": "",
  "comfyuiCwd": ""
}
```

### 远程启动 ComfyUI（电脑端没开也能用手机拉起）

在 `server/config.json`（不入库）里配置本机的 ComfyUI 启动命令：

```json
{
  "comfyuiLaunch": "C:\\ComfyUI\\run_nvidia_gpu.bat",
  "comfyuiCwd": "C:\\ComfyUI"
}
```

手机端「设置 → 服务器」随即出现常驻按钮和实时状态：ComfyUI 没开时是 **「启动 ComfyUI」**，点一下远程拉起（冷启动约 1-3 分钟，页面轮询到就绪会提示）；ComfyUI 运行中时变为 **「重启 ComfyUI」**（运行太久/太慢时远程重启救急——会结束监听 upstream 端口的进程树后重新拉起，无论 ComfyUI 是网关拉起的还是你手动开的）。两个动作都弹确认层，重启会中断正在生成的任务。配套放宽了登录：**令牌正确但 ComfyUI 未运行时允许登录**，并提示到设置页远程启动——否则 ComfyUI 没开时根本进不去。

> **安全模型**：启动命令只来自这台机器的 `server/config.json`，网络请求无法指定「启动什么」——`/gw/comfyui/start` 只能触发配置里那一条固定命令，且与所有接口一样受访问令牌保护；未配置时接口直接拒绝、按钮不显示。ComfyUI 运行日志在 `logs/comfyui.log`。留空（默认）即完全关闭此功能。

### 开机自启（可选，推荐）

双击 `scripts/install-autostart.bat`（卸载用 `scripts/uninstall-autostart.bat`），会创建两个用户级计划任务（无需管理员、不存密码、可在任务计划程序里查看）：

- **ComfyUI Mobile Gateway**：登录时启动网关；
- **ComfyUI Mobile Gateway KeepAlive**：每 5 分钟检查一次，发现网关不在就拉起（崩溃自愈）。

两者只调用 `scripts/autostart-check.js`：网关健康时直接退出，不健康才以分离进程启动（幂等，不会起多份）。网关日志写入 `logs/gateway.log`。任务在你登录后生效（锁屏不影响）；希望重启后不登录也自动起，把任务改成 SYSTEM 账户或开启 Windows 自动登录即可。

## 手机端

1. **家里（同一 WiFi）**：扫终端二维码，或打开配对链接，自动登录。
2. **外面（手机流量 / 别的 WiFi）——地址类型按需选择**：

| 方式 | 地址是否永久 | 手机需要什么 | 说明 |
| --- | --- | --- | --- |
| **Tailscale Funnel** `--tunnel=funnel` | ✅ 永久 | 什么都不用装 | 公网可访问；**慢**：公网入口必须经 Tailscale 中继节点（国内用户常被路由到海外），不适合传图 |
| **Tailscale Serve** `--tunnel=serve` **（推荐）** | ✅ 永久 | 装 Tailscale 并保持在线 | 仅 tailnet 内可达；**直连时最快**（点对点，不绕中继），也不暴露公网 |
| cloudflared 快速隧道 `--tunnel=quick` | ❌ 每次重启换地址 | 什么都不用装 | 免账号，适合临时用（地址随机分配） |
| cloudflared 命名隧道 `--tunnel=named` | ✅ 永久 | 什么都不用装 | 需要自己的域名托管在 Cloudflare |
| frp / 端口转发 | 取决于服务 | 取决于服务 | 端口转发必须配置网关 TLS |

3. 浏览器菜单「添加到主屏幕」可安装为 App（PWA）。

> 地址永久 ≠ 服务永久：网关（以及 ComfyUI）在电脑上运行时手机才能用；关掉后用同一地址访问会看到错误页，重新启动即恢复——与所有自托管服务一样。

> 安全：所有 API 与 WebSocket 均需令牌（Bearer / Cookie / 查询参数三通道）；鉴权失败有防爆破封禁；写操作限流；`/view`、`/userdata` 有路径穿越校验；`/gw/comfyui/start` 只能执行配置文件里写死的本机启动命令，无法被用来执行任意命令。ComfyUI 本身保持只监听本机。

## 功能一览

| 页面 | 能力 |
| --- | --- |
| 工作流 | 列表 / 打开 / 新建 / 重命名 / 删除 / 下载；UI 格式自动转换（子图展平、旁路穿通、动态组合、VHS 对象形参数）；**📚 模板库**（官方模板 + 23 个节点包示例） |
| 快速运行 | 统一布局的手机表单（正/负提示词 → 图片 → 比例分辨率 → 步数\|CFG → 种子\|去噪 → 采样器\|调度器 → 模型族），**全部参数行可拖动：上下排序、主/高级区间互移（自动展开/折叠）、记忆**；**多工作流同时打开，下拉切换，最后选中的驻留**；图片/视频/音频上传（多图、拍照）；输入文件夹**按最新/名称排序、可删文件、长按看大图**；校验错误**一键修复**；JSON 源码兜底 |
| 图库 | 历史结果瀑布流、类型过滤、**视频首帧缩略图**、磁贴显示**生成用时**、**保存到手机 / 分享 / 用此参数重跑**；磁贴走网关本地缩略图（512px WebP）+ 浏览器缓存，二次打开近零流量 |
| 队列 | 实时进度 + **速度（步/秒）/ 已运行时间 / 显存占用** + 二进制预览图、删除/清空/中断；结果卡用 1024px 缩略图就地展示，点开才载原图 |
| 更多 | 模型浏览、节点图（**添加节点 / 连线 / 删除节点 / 重命名节点** / 点按改参数）、设置（**界面语言 中文/English**）、关于 |

## 开发与测试

```sh
npm test                 # 单元 + 集成测试（内置模拟 ComfyUI，173 个用例，离线可跑）
npm run mock             # 单独启动模拟 ComfyUI（默认 :8189，配合联调）
node scripts/gen-icons.js  # 重新生成应用图标
```

测试覆盖：鉴权三通道与防爆破封禁、代理透传与 Range 206、userdata 读写删（含中文名与 %2F 编码）、multipart 上传与大小限制、写操作限流、WS 事件与二进制预览帧、表单推导器（SD/SDXL/子图/旁路/UI 槽位对齐）、API→UI 工作流转换、ComfyUI 远程启动进程管理、缩略图生成、提示词增强、缓存偏好、文本历史、隧道地址解析与 cloudflared 定位。

真实联调记录（本机 0.37.0 实测通过）：网关只读链路、UI 格式子图工作流端到端出图、图库保存按钮、节点图点按编辑均通过。

## 目录结构

```
server/   网关（Node ESM：鉴权 / 反代 / WS 代理 / 静态 / 限流 / 一键隧道）
web/      移动端 PWA（无构建步骤：原生 ES Module + 手写 SW）
scripts/  mock-comfy.js、gen-icons.js、autostart 安装/检查脚本、隐私自检等
docs/     DEVELOPMENT.md（开发文档）、REVIEW.md（自我审查）、HANDOVER.md（交接/维护）
```

---

## English

[中文](#comfyui-mobile) | **English**

Control the ComfyUI on your desktop PC from your phone over the WAN: the PC runs a **secure gateway**, and the phone gets a full portrait-first UI in the browser — workflow management, parameter forms, live progress, gallery (open/save images/videos/audio), queue, node graph, model browser. Installable as a PWA.

- Development guide: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (architecture / API mapping / security design / test plan) *(in Chinese)*
- Target ComfyUI version: tested against 0.37.0 (compatible with both the new `/api`-prefixed and legacy bare-path endpoints)

## Quick Start (Desktop)

```sh
# 1. Install dependencies (Node >= 20)
npm install

# 2. Start the gateway (targets http://127.0.0.1:8188 by default)
npm start

# 3. (Recommended, permanent address) Tailscale Funnel: the address is bound to the machine name, survives restarts, and is reachable from the public internet
node server/src/index.js --tunnel=funnel
```

The first launch generates a random access token in `server/config.json` and prints in the terminal:

- a **QR code** (scan-and-go on the home Wi-Fi) plus a **one-line copyable list of links below it** (including Tailscale/tunnel addresses)
- with `--tunnel=true`, it additionally prints **HTTPS public links** (openable from any mobile network). The tunnel needs the single-file [cloudflared](https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe) binary — drop it into the project root and it is discovered automatically.

On Windows you can also double-click `启动.bat` (which tunnel starts by default is decided by `"tunnel"` in `config.json`: `"funnel"` public & permanent, `"serve"` tailnet-only & permanent, `"quick"` temporary).

> **Platform note**: the gateway is pure Node.js (>= 20) and the phone side is a plain web app, so nothing is Windows-bound by design. However, this document, `启动.bat`, the autostart scripts, and the remote-start examples are written for and tested on **Windows**. On Linux / macOS, start the gateway with `start.sh` and configure autostart yourself (e.g. systemd / launchd) — untested.

### Common Options

```sh
node server/src/index.js --port=8899 --upstream=http://127.0.0.1:8188 --token=<your-token> --tunnel=true
```

Config file `server/config.json` (auto-generated):

```json
{
  "port": 8899,
  "upstream": "http://127.0.0.1:8188",
  "token": "<64-char random hex>",
  "tls": { "cert": "", "key": "" },
  "maxUploadMB": 512,
  "rateLimitPerMin": 120,
  "outputDir": "",
  "inputDir": "",
  "thumbCacheDir": "",
  "tunnel": "funnel",
  "tailscaleHttpsPort": 8443,
  "cloudflared": "",
  "comfyuiLaunch": "",
  "comfyuiCwd": ""
}
```

### Remote-start ComfyUI (launch it from the phone even when the PC hasn't)

Configure the machine's ComfyUI launch command in `server/config.json` (not committed):

```json
{
  "comfyuiLaunch": "C:\\ComfyUI\\run_nvidia_gpu.bat",
  "comfyuiCwd": "C:\\ComfyUI"
}
```

The phone's "Settings → Server" then shows a persistent button with live status: when ComfyUI is not running it reads **"Start ComfyUI"** — one tap launches it remotely (a cold start takes about 1–3 minutes; the page polls until it is ready and then notifies). While ComfyUI is running it becomes **"Restart ComfyUI"** (a remote rescue for stuck or slow runs — it kills the process tree listening on the upstream port and relaunches, whether ComfyUI was started by the gateway or manually by you). Both actions show a confirmation dialog; restarting interrupts running jobs. Login was relaxed accordingly: **when the token is correct but ComfyUI is not running, login is allowed**, with a hint to remote-start from the settings page — otherwise you could not get in at all while ComfyUI is down.

> **Security model**: the launch command comes only from this machine's `server/config.json`; network requests cannot choose what to launch — `/gw/comfyui/start` can only trigger that one fixed command from the config, and like every endpoint it is protected by the access token. When unconfigured, the endpoint refuses and the button is hidden. ComfyUI's runtime log goes to `logs/comfyui.log`. Leave it empty (the default) to disable the feature entirely.

### Autostart on Boot (optional, recommended)

Double-click `scripts/install-autostart.bat` (uninstall with `scripts/uninstall-autostart.bat`); it creates two per-user scheduled tasks (no admin required, no stored password, visible in Task Scheduler):

- **ComfyUI Mobile Gateway**: starts the gateway on login;
- **ComfyUI Mobile Gateway KeepAlive**: checks every 5 minutes and relaunches the gateway if it is gone (crash self-healing).

Both only run `scripts/autostart-check.js`: it exits immediately when the gateway is healthy, and starts the gateway as a detached process only when it is not (idempotent — it never spawns duplicates). Gateway logs go to `logs/gateway.log`. The tasks take effect after you log in (a locked screen does not matter); to have them survive a reboot without login, switch the tasks to the SYSTEM account or enable Windows auto-login.

## Phone Side

1. **At home (same Wi-Fi)**: scan the QR code in the terminal, or open the pairing link — you are logged in automatically.
2. **Outside (mobile data / another Wi-Fi) — pick the address type that fits**:

| Method | Permanent address? | Phone needs | Notes |
| --- | --- | --- | --- |
| **Tailscale Funnel** `--tunnel=funnel` | ✅ Permanent | Nothing to install | Reachable from the public internet; **slow**: the public entry point must relay through Tailscale's relay nodes (often routed overseas for mainland-China users); not ideal for image transfer |
| **Tailscale Serve** `--tunnel=serve` **(recommended)** | ✅ Permanent | Install Tailscale and keep it online | Reachable only inside the tailnet; **fastest when direct** (peer-to-peer, no relay) and never exposes a public endpoint |
| cloudflared quick tunnel `--tunnel=quick` | ❌ Changes on every restart | Nothing to install | No account needed; good for temporary use (the address is randomly assigned) |
| cloudflared named tunnel `--tunnel=named` | ✅ Permanent | Nothing to install | Requires your own domain hosted on Cloudflare |
| frp / port forwarding | Depends on the setup | Depends on the setup | Port forwarding must have gateway TLS configured |

3. The browser menu "Add to Home Screen" installs it as an app (PWA).

> Permanent address ≠ permanent service: the phone works while the gateway (and ComfyUI) run on the PC; after they shut down the same address shows an error page, and it recovers once you start them again — the same as any self-hosted service.

> Security: every API and WebSocket requires the token (three channels: Bearer / Cookie / query parameter); failed auth triggers brute-force bans; write operations are rate-limited; `/view` and `/userdata` have path-traversal checks; `/gw/comfyui/start` can only execute the fixed local launch command written in the config file and cannot be abused to run arbitrary commands. ComfyUI itself keeps listening on localhost only.

## Feature Overview

| Page | Capabilities |
| --- | --- |
| Workflows | List / open / create / rename / delete / download; automatic UI-format conversion (subgraph flattening, bypass pass-through, dynamic combos, VHS object-params); **📚 template gallery** (official templates + samples from 23 node packs) |
| Quick Run | Unified mobile form layout (positive/negative prompts → images → aspect & resolution → steps\|CFG → seed\|denoise → sampler\|scheduler → model family); **every parameter row is draggable: reorder, move between main/advanced sections (auto expand/collapse), and remembered**; **multiple workflows open at once with a dropdown switcher — the last selected one persists**; image/video/audio upload (multi-image, camera); input folder **sorted by newest/name, files deletable, long-press for a full-size preview**; validation errors with **one-click fix**; raw JSON editor as a fallback |
| Gallery | Waterfall of historical results, type filters, **video first-frame thumbnails**, tiles show **generation time**, **save to phone / share / rerun with the same parameters**; tiles are served as gateway-local thumbnails (512px WebP) plus browser cache — near-zero traffic on the second open |
| Queue | Live progress + **speed (steps/s) / elapsed time / VRAM usage** + binary preview images; delete/clear/interrupt; result cards show 1024px thumbnails inline, the full image loads on tap |
| More | Model browser, node graph (**add nodes / wire / delete / rename nodes** / tap to edit params), settings (**UI language: 中文/English**), about |

## Development & Testing

```sh
npm test                 # unit + integration tests (built-in mock ComfyUI, 173 cases, runs offline)
npm run mock             # start the mock ComfyUI alone (default :8189, for joint debugging)
node scripts/gen-icons.js  # regenerate the app icons
```

Test coverage: the three auth channels and brute-force bans, proxy passthrough and Range 206, userdata read/write/delete (including Chinese names and %2F encoding), multipart upload and size limits, write rate limiting, WS events and binary preview frames, the form inference engine (SD/SDXL/subgraph/bypass/UI slot alignment), API→UI workflow conversion, ComfyUI remote-start process management, thumbnail generation, prompt enhancement, cache preferences, text history, tunnel address parsing and cloudflared discovery.

Verified in real integration (local 0.37.0): the gateway read-only path, end-to-end image generation from a UI-format subgraph workflow, the gallery save button, and node-graph tap editing all pass.

## Project Layout

```
server/   Gateway (Node ESM: auth / reverse proxy / WS proxy / static files / rate limiting / one-click tunnels)
web/      Mobile PWA (no build step: native ES Modules + a hand-written service worker)
scripts/  mock-comfy.js, gen-icons.js, autostart install/check scripts, privacy self-check, etc.
docs/     DEVELOPMENT.md (development), REVIEW.md (self-review), HANDOVER.md (handover/maintenance)
```

## License / 许可证

Released under the [MIT License](LICENSE). / 本项目以 [MIT](LICENSE) 协议开源。
