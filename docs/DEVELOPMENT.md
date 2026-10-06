# ComfyUI Mobile 开发文档

手机广域网远程控制电脑 ComfyUI 的完整方案：电脑侧运行一个**安全网关**，手机侧使用**移动端优先的 Web 应用**（PWA）。所有功能通过浏览器使用，无需在手机安装 App。

- 目标 ComfyUI 版本：以 0.37.0 实测为准（本文所有端点均在本机 `http://127.0.0.1:8188` 验证通过）
- 运行环境：Node.js ≥ 20（开发机为 v24.20.0，Windows / Git Bash）
- 文档版本：v1.0（2026-09-26）

---

## 1. 背景与目标

### 1.1 痛点

1. ComfyUI 原生界面面向桌面大屏 + 鼠标：节点画布在手机上无法有效操作（捏合缩放后节点文字过小、拖线困难）。
2. ComfyUI 默认只监听本机，直接暴露到广域网没有任何鉴权，公网可任意执行工作流。
3. 手机上需要方便地查看/保存生成结果（图片、视频、音频）。

### 1.2 目标（验收标准）

| 编号 | 目标 | 验收方式 |
| --- | --- | --- |
| G1 | 手机浏览器可用，界面按手机竖屏设计，手势可完成全部操作 | GUI 测试 |
| G2 | 覆盖 ComfyUI 主要功能：工作流管理（打开/保存/新建/删除/重命名）、运行/队列/中断、历史与结果、模型查看、节点图查看与参数修改、上传图片（图生图）、服务器状态 | GUI + API 测试 |
| G3 | "表单模式"：从工作流自动生成手机友好的参数表单（提示词、种子、步数、分辨率、模型下拉框等），无需拖节点 | 单元测试 + GUI |
| G4 | 生成结果（图片/视频/音频）可在手机上直接打开、保存到相册/文件 | 集成测试 + GUI |
| G5 | 广域网安全：令牌鉴权、可选 HTTPS、防路径穿越、上传大小限制、WS 鉴权 | 集成测试 |
| G6 | 全部自动化测试通过（单元 + 集成 + 模拟 ComfyUI 端到端） | `node --test` |
| G7 | 真实 ComfyUI 联调通过（本机 0.37.0） | 联调记录 |

### 1.3 非目标（明确不做）

- 不实现桌面级完整节点连线编辑（新增/拖拽连线）。替代方案：节点图**查看** + 单节点**参数编辑** + **JSON 源码编辑器**兜底。
- 不做 iOS/Android 原生 App；PWA 即可安装到主屏幕。
- 不做多用户体系；单令牌即单用户（家庭/个人场景）。

---

## 2. 总体架构

```
┌────────────── 手机（广域网） ──────────────┐        ┌─────────────────── 电脑 ───────────────────┐
│                                            │        │                                            │
│  PWA「ComfyUI Mobile」                      │        │  网关 comfyui-mobile-gateway (Node.js)      │
│  ┌─────────┐ ┌────────┐ ┌─────────┐        │        │  ┌──────────┐ ┌─────────┐ ┌─────────────┐ │
│  │ 工作流   │ │ 快速运行│ │ 图库     │        │ HTTPS/ │  │ 静态资源  │ │ 鉴权层   │ │ API 反向代理 │ │──┐
│  │ 队列/更多│ │ (表单)  │ │ 队列     │◄───────┼─HTTP───┼─►│ web/     │ │ Bearer  │ │ (流式+Range) │ │  │
│  └─────────┘ └────────┘ └─────────┘        │  隧道   │  └──────────┘ └─────────┘ └──────┬──────┘ │  │
│        ▲            ▲          ▲           │        │                                  ▼        │  │
│        └── WebSocket 实时进度/预览图 ────────┼────────┼────────────────── WS 代理 ────────────────┼──┤
└────────────────────────────────────────────┘        │  ┌──────────────────────────────────────────┐│  │
                                                       │  │ ComfyUI  http://127.0.0.1:8188           │◄┘
                                                       │  │ 本机回环，不对公网开放                      │
                                                       │  └──────────────────────────────────────────┘
                                                       └────────────────────────────────────────────┘
```

核心决策：

1. **网关不动 ComfyUI 一行代码**：ComfyUI 保持 `127.0.0.1` 监听，网关是它唯一对外的门面。
2. **移动端只做一层壳**：手机 PWA 与 ComfyUI 之间没有私有协议，全部通过网关代理 ComfyUI 原生 HTTP/WS API，因此天然覆盖全部功能，且 ComfyUI 升级不需要改客户端。
3. **"表单模式"是本地推导**：由前端解析工作流 JSON + `object_info` 节点 schema，自动生成参数表单；推导失败时降级为"节点参数卡片"模式，再降级为 JSON 编辑器。三层兜底保证任何工作流都能改参数。

---

## 3. 技术选型

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 网关 | Node.js 原生 `http`/`https` + `ws` + `qrcode`，ESM | 零框架依赖面小、流式代理可控；`ws` 是 Node 唯一成熟的 WS 服务端；`qrcode` 用于终端打印配对二维码 |
| 移动端 | 原生 ES Module + 原生 Web Components 风格函数式渲染，**无构建步骤** | 免维护打包链；单文件 CSS；手机直接加载源码 |
| PWA | 手写 `manifest.webmanifest` + `sw.js`（App Shell 缓存） | 免工具链，可安装到主屏幕 |
| 测试 | Node 内置 `node --test` + 自建模拟 ComfyUI | 无第三方断言库依赖，可离线 CI |
| 广域网隧道 | 推荐 Tailscale（首选）/ frp / cloudflared / 路由器端口转发+TLS | 见 §7 |

UI 文案：简体中文优先，代码内字符串集中在 `web/js/lib/i18n.js`，便于后续多语言。

---

## 4. ComfyUI API 依赖清单（实测 0.37.0）

| 端点 | 方法 | 用途 | 实测 |
| --- | --- | --- | --- |
| `/system_stats` | GET | 服务器状态、GPU/VRAM、ComfyUI 版本 | ✅ 200 |
| `/object_info` | GET | 全量节点 schema（约数 MB，避免整页拉取） | ✅ |
| `/object_info/{class_type}` | GET | 单节点 schema（按需） | ✅ 200 |
| `/prompt` | POST/GET | 提交工作流入队 / 查询队列 | ✅ |
| `/interrupt` | POST | 中断当前执行 | ✅ |
| `/queue` | GET/POST | 队列查询 / `{delete:[id]}` 删除队列项 | ✅ |
| `/history` | GET (`max_items`) | 历史与输出清单 | ✅ |
| `/view` | GET | 读取输出/临时媒体，**原生支持 Range（206）与 Content-Disposition** | ✅ 206 |
| `/userdata?dir=workflows&recurse=true&split=false` | GET | 列出工作流文件 | ✅ |
| `/userdata/workflows/{file}` | GET/POST | 读取/保存工作流（`?overwrite=true`） | ✅ |
| `/models/{folder}` | GET | 列出模型文件夹内文件（checkpoints/loras/vae/…） | ✅ 200 |
| `/upload/image` | POST (multipart) | 上传图片（图生图/换背景等输入） | ✅ |
| `/ws?clientId={uuid}` | WS | 执行事件流 + 二进制预览图（前 8 字节头：事件类型 u32 + 图片类型 u32） | ✅ |
| `/api/...` 前缀 | — | 0.37.0 同时接受裸路径与 `/api` 前缀 | ✅ 200 |

约定：客户端**只用裸路径**（新旧版本兼容面更大）；网关按原样透传。

### 4.1 历史输出的媒体类型识别

`history[prompt_id].outputs.{nodeId}` 下可能出现的媒体数组键与扩展名：

| 键 | 类型 | 常见扩展名 |
| --- | --- | --- |
| `images` | 图片 | png / jpg / webp |
| `gifs` / `video` | 视频 | mp4 / webm / gif |
| `audio` | 音频 | mp3 / wav / flac / ogg |

按扩展名归一化为 `image|video|audio`，统一渲染为图库条目。

---

## 5. 网关服务器设计（`server/`）

### 5.1 目录与模块

```
server/
  src/                  # 同下；package.json 位于项目根目录（单包，deps: ws、qrcode）
    index.js            # 入口：解析参数 → 配置 → 启动
    config.js           # config.json 读写、首次生成随机 token、CLI/env 覆盖
    gateway.js          # http(s) 服务器、路由分发、鉴权中间件、限流
    proxy.js            # API 反向代理（流式、头过滤、Range 透传）
    wsproxy.js          # /ws WebSocket 双向代理
    static.js           # 静态资源（web/）+ MIME 表
    media.js            # 媒体类型判定、Content-Disposition、上传大小限制
  test/
    *.test.js           # 见 §9
```

### 5.2 配置（`server/config.json`，首次启动自动生成）

```json
{
  "port": 8899,
  "upstream": "http://127.0.0.1:8188",
  "token": "<64 位随机 hex>",
  "tls": { "cert": "", "key": "" },
  "maxUploadMB": 512,
  "rateLimitPerMin": 60,
  "tunnel": false,
  "cloudflared": ""
}
```

- `tunnel` 取值：`false` | `quick`（cloudflared 快速隧道，地址随机）| `serve`（Tailscale 仅 tailnet）| `funnel`（Tailscale 公网）| `named`（cloudflared 命名隧道）；`true` 等价 `quick`。
- Tailscale 模式执行 `tailscale serve|funnel --bg --https=<端口> http://127.0.0.1:<网关端口>`；该配置**持久化在 Tailscale 侧**，因此网关重启后地址不变。启动时解析 `status` 输出给出当前地址（`parseTailscaleStatus` 按本机端口匹配，避免误用其他规则）。
- `quick` 模式启动 cloudflared 快速隧道（`server/src/tunnel.js`）：spawn `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate`，从输出解析 `https://*.trycloudflare.com` 公网地址并打印横幅 + 二维码 + 可复制链接。
- `cloudflared` 可执行文件定位顺序：配置项/`COMFY_MOBILE_CLOUDFLARED` 环境变量 → PATH（`where`/`which`，结果必须通过 `existsSync` 校验以淘汰 ANSI→UTF-8 解码产生的乱码路径）→ 常见安装位置 → 项目根。
- CLI 参数与 `COMFY_MOBILE_*` 环境变量可覆盖同名配置项。
- `token` 生成用 `crypto.randomBytes(32).toString('hex')`；比较用 `crypto.timingSafeEqual`。
- 启动时打印：本机各网卡访问 URL（含 `?token=` 的一次性配对链接）+ 终端二维码；日志中一律脱敏 token。

### 5.3 路由与鉴权

| 路径 | 鉴权 | 行为 |
| --- | --- | --- |
| `/health` | 免 | `{ok:true}`（无敏感信息，供探活） |
| `/`, `/app/*`, 静态资源 | 免 | 返回 `web/` 静态文件（壳无数据，泄露无害） |
| 其余全部 | **必须** | 反向代理到 `upstream`，透传方法/查询/请求体 |
| `/ws` (Upgrade) | **必须**（query token） | WS 代理 |

Token 传递方式（客户端按序尝试）：`Authorization: Bearer` → `?token=` → Cookie `cm_token`。
首次通过配对链接进入后，前端立即把 token 存入 `localStorage` 并 `history.replaceState` 清除 URL 中的 token。

### 5.4 代理行为细节

- 请求体**流式**转发（上传大图不落盘、不占内存）；`Content-Length` 超过 `maxUploadMB` 直接 413；**chunked 无长度请求**累计计数超限即断开（防绕过预检）。
- 响应**流式**转发；透传 `Content-Type / Content-Length / Accept-Ranges / Content-Range / ETag / Last-Modified / Content-Disposition`，剔除逐跳头；上游缺失 `Content-Type` 时按扩展名补齐（否则手机 `<video>/<audio>` 无法播放）。
- Range：透传客户端 `Range` 头；上游 0.37.0 已原生支持 206（实测 §4），网关默认直通不缓冲；另提供 `rangeFallbackMB`（默认关闭）——老版本上游不支持 Range 时，对不超过该值的媒体落盘临时文件并回 206。
- `/view` 的 `filename` 参数在网关侧再做一层穿越校验（拒绝 `\`、`..`、盘符、绝对路径、控制字符），纵深防御。
- 上游连接失败 → 502 + JSON 错误体（前端据此显示"ComfyUI 未运行"卡片）。

### 5.5 WS 代理

- 客户端 `GET /ws?clientId=…&token=…` → 鉴权 → 与上游 `/ws?clientId=…` 建连 → 双向 pipe。
- 上游断开时向下游发 `{type:"gw_upstream_closed"}` 再关闭；下游心跳 30s。
- 预览图（二进制帧）原样转发，不解析，避免 CPU 开销。

### 5.6 限流与防爆破

- 写操作（`/prompt`、`/upload/image`、`/userdata` 非只读）令牌桶限流：每分钟 `rateLimitPerMin` 次（默认 60），按 token 全局计（单用户场景最简且防脚本刷爆显卡队列）；只读端点不限。
- **鉴权失败限流**：同一 IP 每分钟鉴权失败超过 30 次封禁 5 分钟（防 token 暴力穷举），封禁期间一律 429。
- 启动时若未配置 TLS：打印"当前为 HTTP 明文，建议配合隧道或启用 tls 配置"的醒目警告。

---

## 6. 移动端 Web 应用设计（`web/`）

### 6.1 目录

```
web/
  index.html              # 单页应用入口
  manifest.webmanifest    # PWA
  sw.js                   # App Shell 缓存（仅静态，不缓存 API）
  icons/                  # SVG + 192/512 PNG
  css/app.css             # 移动优先样式，暗色为默认主题
  js/
    app.js                # 路由 + 底部导航 + 登录
    lib/api.js            # fetch 封装(自动带 token) + WS 封装(自动重连)
    lib/i18n.js           # 文案表
    lib/workflow-form.js  # ★ 表单模式推导器（可被 Node 单测直接运行）
    lib/graph.js          # 节点图布局与 SVG 渲染
    lib/media.js          # 媒体分类、URL 构建、保存/分享
    views/
      login.js workflows.js run.js queue.js gallery.js more.js
      node-editor.js settings.js
```

### 6.2 页面与导航（移动优先）

底部 Tab 导航 5 个入口；顶部常驻状态栏（连接状态点、GPU/显存、队列数、中断按钮）。

| Tab | 页面 | 内容 |
| --- | --- | --- |
| 工作流 | workflows | 工作流列表（`/userdata`）、打开、重命名、删除、新建空白、**快速运行**入口 |
| 快速运行 | run | 表单模式（§6.3）；顶部工作流名 + 原始参数/JSON 切换；上传图片控件；「生成」大按钮 |
| 图库 | gallery | 历史结果瀑布流（懒加载，一次拉取 `max_items` 条、本地分组分页渲染，设置页可调，默认 100），按类型过滤，点开大图/视频播放器/音频播放器，**保存/分享** |
| 队列 | queue | 运行中（实时进度条+预览图）与待执行列表，删除/清空/中断 |
| 更多 | more | 模型浏览（按文件夹分组）、节点图查看器、设置、关于 |

### 6.3 表单模式推导规则（`lib/workflow-form.js`）

输入：API 格式工作流 JSON + 相关节点的 `object_info/{class}` schema。

1. **角色识别**（基于 `class_type` 与连线拓扑）：
   - 采样器：`KSampler / KSamplerAdvanced / SamplerCustom / SamplerCustomAdvanced` 等类名含 `Sampler`。
   - 正/负提示词：从采样器 `positive`/`negative` 输入沿 `CONDITIONING` 连线回溯到 `CLIPTextEncode`（或 `text` 输入节点）。
   - 分辨率/批量：从 `latent_image` 连线回溯 `Empty*LatentImage` 系（含 SD3/Hunyuan/Wan 等），取 `width/height/batch_size`。
   - 模型选择：widget 名匹配映射表（`ckpt_name→checkpoints`、`unet_name→diffusion_models`、`lora_name→loras`、`vae_name→vae`、`clip_name→text_encoders|clip`、`control_net_name→controlnet`、`upscale_model_name→upscale_models` 等），下拉选项实时来自 `/models/{folder}`。
2. **控件类型**：由 `object_info` 的输入声明决定 —— `INT/FLOAT`（min/max/step → number 滑条+微调）、`STRING`（multiline → textarea）、`BOOLEAN`（开关）、combo（下拉）、名字含 `seed`/`noise_seed` → 数字 + 🎲随机按钮。
3. **产出结构**：`{heroes: [...], advanced: [{nodeId, title, fields: [...]}]}` —— 主参数（提示词/分辨率/采样器/种子/步数）平铺，其余每个节点的 widget 收进"高级参数"折叠组；`input_order` 保持展示顺序。
4. **三层兜底**：表单推导失败 → 节点参数卡片（列出全部节点全部 widget）；仍未覆盖 → JSON 源码编辑器。保存与"生成"提交前把表单值写回工作流 JSON 再 `POST /prompt`。
5. **改参不改文件**：表单中修改的值默认只作用于本次运行（不回写原工作流文件）；需要持久化时使用显式的"另存为…"或"保存覆盖"（带确认弹窗），避免原工作流被悄悄改动。
6. **格式支持**：完整支持 API 格式（`{"1":{"class_type":...}}`）；UI 导出格式（`{"nodes":[...],"links":[...]}`）为**实验特性**——基于 schema 尽力转换，失败时明确报错并提示"桌面端菜单 Workflow → Export (API)"，绝不静默提交错误数据。
7. **提交校验**：`POST /prompt` 响应中的 `node_errors` 非空时，按节点展示错误详情卡片。

### 6.4 节点图查看器（`lib/graph.js`）

- API 格式工作流无坐标 → 按拓扑层级自动布局（源节点靠左，SaveImage 类靠右）；UI 格式工作流带 `nodes[].pos` → 直接使用。
- SVG 渲染：节点矩形 + 标题 + widget 值预览 + 输入输出圆点，贝塞尔连线；双指捏合缩放、单指拖动、双击复位；点按节点 → 底部抽屉编辑该节点全部 widget（与表单控件复用）。

### 6.5 实时进度（WS）

- 连接 `/ws?clientId=<随机uuid>`；提交 `/prompt` 时带上同一 `clientId`。
- 文本事件：`status`（队列数）、`execution_start`、`executing`（当前节点）、`progress`（0-100）、`executed`、`execution_error`（解析 `exception_message` 展示错误卡片）、`execution_success`。
- 二进制帧：8 字节头（事件类型 u32LE=1 预览图、图片类型 u32LE=1 JPEG/2 PNG）+ 图片字节 → Blob URL 实时预览缩略图。
- 断线指数退避重连（1s→2s→4s…上限 30s）；页面 `visibilitychange` 恢复时立即重连。

### 6.6 结果打开与保存（`lib/media.js`）

- 图片：`<img>` + 点击全屏查看（双指缩放）。
- 视频：`<video controls playsinline>`（Range 由 ComfyUI 原生支持，已实测）。
- 音频：`<audio controls>`。
- 保存：同源 `<a download>`（iOS Safari 13+/Android Chrome 均支持）触发"存储到文件/相册"；支持 Web Share API 的设备显示"分享"按钮。
- 文件名：沿用 ComfyUI 输出原始文件名。

### 6.7 PWA 与离线

- `sw.js`：HTML/JS/CSS 用 **network-first**（改动立即生效，离线退回缓存壳）；icons/manifest 用 cache-first；`/view` 与所有 API 一律 network-only（结果新鲜度优先）。
- 安装引导：设置页显示"添加到主屏幕"说明 + `beforeinstallprompt` 触发按钮。

### 6.8 功能 ↔ ComfyUI 桌面菜单覆盖映射

| ComfyUI 桌面功能 | 手机端对应 | 完整度 |
| --- | --- | --- |
| Workflow: New / Open / Save / Save As / Rename / Delete | 工作流 Tab：新建 / 打开 / 保存覆盖(确认) / 另存为 / 重命名 / 删除 | 全量 |
| Queue Prompt / 队列按钮 | 快速运行页「生成」大按钮 | 全量 |
| 队列面板（运行中/待执行/删除/清空/中断） | 队列 Tab | 全量 |
| 历史/结果预览 | 图库 Tab（含视频/音频） | 全量 |
| 节点画布编辑 | 更多→节点图：查看 + 单节点参数编辑 + JSON 源码编辑 | 部分（连线编辑不做，JSON 兜底） |
| 加载模型下拉 | 表单模式模型选择器（实时读 `/models/{folder}`） | 全量 |
| 上传图片（LoadImage） | 表单内图片上传控件（相册/拍照） | 全量 |
| 执行时报错展示 | WS `execution_error` 解析 + node_errors 卡片 | 全量 |
| 实时预览图 | WS 二进制预览帧渲染 | 全量 |
| Settings（主题等） | 设置 Tab（主题/图库分页/服务器信息/关于） | 部分（客户端相关项） |
| Extensions/Manager | 不提供（管理操作建议桌面完成） | 非目标 |

---

## 7. 广域网接入方案

| 方案 | 安全性 | 难度 | 说明 |
| --- | --- | --- | --- |
| **Tailscale Funnel（推荐，永久地址）** | 高（令牌 + 自动 HTTPS） | 低 | `--tunnel=funnel`；地址绑定机器名 `https://<机器>.<tailnet>.ts.net:8443`，重启不变；无需域名；手机无需装任何 App；公网多节点实测 200 |
| **Tailscale Serve（永久，仅 tailnet）** | 最高（不暴露公网） | 低 | `--tunnel=serve`；同一永久地址；手机需登录同一 Tailscale 账号；速度更快 |
| cloudflared 快速隧道（临时） | 高（令牌 + 自动 HTTPS） | 低 | `--tunnel=quick`；免账号/公网 IP；**地址每次重启随机变化**，适合临时使用；WS/媒体全链路实测可用 |
| **Tailscale** | 高（WireGuard 点对点，无需公网端口） | 低 | 电脑与手机装客户端，手机访问 `http://<电脑的ts-ip>:8899`；网关 token 仍生效，双保险 |
| frp / 自建 VPS 反代 | 高（建议 TLS） | 中 | 国内云服务器场景；`frpc` 转发 8899 |
| cloudflared 命名隧道 | 高 | 中 | 固定域名；`cloudflared tunnel` 手动配置后无需网关内置隧道 |
| 路由器端口转发 + 网关 TLS | 中 | 中 | 家庭宽带有公网 IP 时；必须启用网关内置 HTTPS（自签或 Let's Encrypt） |

网关仅监听 `0.0.0.0:8899`，**永远不直接暴露 ComfyUI 端口**；无论哪种隧道，鉴权层始终生效。

---

## 8. 安全设计

威胁模型：公网上的任意扫描者 / 中间人。

1. **令牌**：64 hex 随机；Bearer/query/Cookie 三通道；`timingSafeEqual` 比较防时序侧信道；日志与错误信息脱敏。
2. **传输**：支持网关内置 TLS（cert/key 配置）；或由隧道层终结 TLS。
3. **路径穿越**：`/view`、`/userdata` 参数网关侧二次校验（拒绝 `..`、反斜杠、盘符、控制字符）。
4. **上传**：大小硬限制（默认 512MB，可配）；Content-Type 白名单校验放给 ComfyUI（它已有校验），网关负责体积与限流。
5. **限流**：写操作令牌桶，默认 60 次/分钟。
6. **WS**：Upgrade 请求同样必须带 token。
7. **失败即响**：配置错误（如 TLS 文件缺失、upstream 不可达）启动/首请求时立即报错，不静默降级。
8. **页面加固**：`index.html` 设置 `<meta name="referrer" content="no-referrer">` 与仅同源的 CSP（无任何第三方资源），token 不经 Referer 外泄。

---

## 9. 测试计划

| 层级 | 内容 | 工具 |
| --- | --- | --- |
| 单元 | token 生成/比较、媒体类型与 Content-Disposition（含中文名 RFC 5987）、路径校验拒绝用例、**表单推导器**（多类工作流 fixture：SD 文生图、SDXL/SD3、视频 VHS、音频、LoRA 链）、UI/API 格式识别 | `node --test` 直接跑 `web/js/lib/*.js`（纯函数 ESM） |
| 集成 | **模拟 ComfyUI**（`scripts/mock-comfy.js`，实现 §4 全部端点 + 假执行流 + Range + WS 事件）；网关起在 mock 上：401/鉴权、代理透传、队列提交→历史→/view 字节一致、Range 206、userdata 读写删、multipart 上传、chunked 上传超限、WS 消息与二进制帧、鉴权失败封禁、写操作限流、穿越攻击用例 | `node --test` |
| GUI 冒烟 | 浏览器自动化：登录 → 工作流列表 → 打开表单 → 改提示词 → 生成 → 进度 → 图库出现结果 → 保存按钮存在 | ZCode 浏览器控制 |
| 真实联调 | 网关指向本机 0.37.0：`/system_stats`、`/object_info/KSampler`、`/userdata` 列表、`/view` Range 206 | curl/浏览器 |

测试不依赖真实 ComfyUI 或显卡，可在 CI 离线运行。

---

## 10. 里程碑

| 阶段 | 交付物 | 验收 |
| --- | --- | --- |
| M1 | 开发文档 | 本文 |
| M2 | 网关（鉴权/代理/WS/静态/限流/配置）+ 单元测试 | `node --test server/test` 全绿 |
| M3 | 模拟 ComfyUI + 集成测试 | 同上全绿 |
| M4 | 移动端应用全部页面 + 表单推导器 + 单测 | 同上全绿 |
| M5 | GUI 冒烟 + 真实联调 | 冒烟通过 + §4 实测记录 |
| M6 | README、启动脚本、git 提交 | 交付说明可复现 |

---

## 11. 风险与对策

| 风险 | 对策 |
| --- | --- |
| ComfyUI 未来版本 API 变动 | 客户端只依赖 §4 稳定端点；`/api` 前缀与裸路径兼容；版本号在"关于"页展示便于排查 |
| UI 格式（非 API 格式）工作流无法直接提交 | 检测格式并提示"用桌面端导出 (API) 格式"或尝试基于 schema 的尽力转换，失败时明确报错而非静默出错 |
| `object_info` 全量过大（数 MB） | 只按节点类名惰性拉取 `/object_info/{class}` 并 localStorage 缓存 |
| 手机端大图/长视频流量与内存 | 图库分页懒加载（默认 20 条/页）、`loading=lazy`、点开才取原图 |
| iOS `download` 属性兼容性 | 同源下载已满足；另提供 Web Share API 分享路径 |
| 并发保存工作流互相覆盖 | 保存前提示覆盖确认；userdata 无乐观锁，文档明示单用户假设 |
| `/userdata` 删除/移动端点随版本差异 | 删除用 `DELETE /userdata/{path}`；重命名实现为"读+新写+删旧"三步，不依赖 move 端点；失败时提示用户到桌面端手动处理 |
| 明文 HTTP 部署（无隧道直端口转发） | 启动检测无 TLS 时醒目警告；文档强制建议 Tailscale 等加密隧道 |
| 显卡被公网恶意刷任务 | 限流 + token + 队列页可见所有任务 |
