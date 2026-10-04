/**
 * 网关 HTTP 服务器：路由分发（health / 静态壳 / 鉴权代理）、鉴权、限流、防爆破封禁。
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import fsSync from 'node:fs';
import { tokenMatches } from './config.js';
import { isSafeMediaName } from './media.js';
import { serveStatic } from './static.js';
import { createUpstreamRequester } from './proxy.js';
import { createThumbnailResponder } from './thumbs.js';
import { enhanceWithLlm } from './enhance.js';
import { comfyStatus, startComfyUI, restartComfyUI } from './comfy-process.js';
import { attachWebSocketProxy } from './wsproxy.js';

/**
 * 取客户端真实地址，用于限流与封禁。
 *
 * 经隧道访问时网关看到的对端是隧道进程（127.0.0.1），所有手机共用同一地址；
 * 若按它封禁会「一封封一片」（2026-09-27 实际发生过：手机被自身重试封禁）。
 * 因此来自回环的请求优先采用隧道注入的客户端地址头。
 * @param {import('node:http').IncomingMessage} req
 * @returns {string} 用于限流的客户端标识
 */
export function clientAddress(req) {
  const peer = req.socket.remoteAddress ?? 'unknown';
  const isLoopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (isLoopback) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) return cf.trim();
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  }
  return peer;
}

/** 可删除/列出的媒体扩展名（/gw/output-file 与 /gw/input-file 共用）。 */
const MEDIA_EXTS = [
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif',
  'mp4', 'webm', 'mkv', 'mov', 'm4v',
  'mp3', 'wav', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'opus',
];

/** 输出文件删除与输入文件列表/删除共用的 200 JSON 响应。 */
function jsonRes(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** 读取请求体为 UTF-8 字符串（超限断开连接，防内存滥用）。 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 校验 {filename, subfolder} 并解析出必须位于 root 内的媒体文件绝对路径。 */
function resolveMediaTarget(root, filename, subfolder) {
  if (!isSafeMediaName(filename) || subfolder.split('/').some((p) => p === '..')) return { error: '文件名或子目录不合法' };
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (!MEDIA_EXTS.includes(ext)) return { error: '仅允许媒体文件' };
  const absRoot = path.resolve(root);
  const target = path.resolve(absRoot, subfolder, filename);
  if (target !== absRoot && !target.startsWith(absRoot + path.sep)) return { error: '路径越界' };
  return { target, absRoot };
}

/**
 * 删除输出目录下的媒体文件。仅当配置了 outputDir 时可用；解析后的绝对路径必须
 * 位于该目录内，且扩展名限定为媒体类型，防止越权删除任意文件。
 * @param {object} cfg 网关配置
 * @param {URL} url 请求 URL（filename/subfolder/type）
 * @param {import('node:http').ServerResponse} res
 */
function handleDeleteOutputFile(cfg, url, res) {
  if (!cfg.outputDir) {
    return jsonRes(res, 501, { error: 'output_dir_unconfigured', message: '网关未配置 outputDir，无法删除磁盘文件（历史记录已可单独删除）' });
  }
  const filename = url.searchParams.get('filename') ?? '';
  const subfolder = url.searchParams.get('subfolder') ?? '';
  const type = url.searchParams.get('type') ?? 'output';
  if (type !== 'output') return jsonRes(res, 400, { error: 'invalid_type', message: '仅支持删除 output 目录文件' });
  const resolved = resolveMediaTarget(cfg.outputDir, filename, subfolder);
  if (resolved.error) return jsonRes(res, 400, { error: 'invalid_path', message: resolved.error });
  const { target } = resolved;
  try {
    const stat = fsSync.statSync(target);
    if (!stat.isFile()) return jsonRes(res, 400, { error: 'not_a_file', message: '目标不是文件' });
  } catch {
    return jsonRes(res, 404, { error: 'not_found', message: '文件不存在（可能已被删除）' });
  }
  try {
    fsSync.unlinkSync(target);
    return jsonRes(res, 200, { ok: true, deleted: filename });
  } catch (err) {
    return jsonRes(res, 500, { error: 'delete_failed', message: String(err.message) });
  }
}

/**
 * 列出 input 目录下的媒体文件（名称/体积/修改时间），供选择器按最新时间排序。
 * 仅根目录（与 LoadImage 等 combo 的可见范围一致）；未配置 inputDir 时返回 501。
 */
function handleListInputFiles(cfg, res) {
  if (!cfg.inputDir) {
    return jsonRes(res, 501, { error: 'input_dir_unconfigured', message: '网关未配置 inputDir，无法列出输入目录（排序将退化为按名称）' });
  }
  let dirents;
  try {
    dirents = fsSync.readdirSync(cfg.inputDir, { withFileTypes: true });
  } catch (err) {
    return jsonRes(res, 500, { error: 'list_failed', message: `读取 input 目录失败：${err.message}` });
  }
  const files = [];
  for (const entry of dirents) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).slice(1).toLowerCase();
    if (!MEDIA_EXTS.includes(ext)) continue;
    try {
      const stat = fsSync.statSync(path.join(cfg.inputDir, entry.name));
      files.push({ name: entry.name, size: stat.size, mtime: Math.round(stat.mtimeMs) });
    } catch {
      // 并发删除等瞬时错误：跳过该文件
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  jsonRes(res, 200, { files });
}

/** 删除 input 目录下的媒体文件（需配置 inputDir，仅限该目录子树）。 */
function handleDeleteInputFile(cfg, url, res) {
  if (!cfg.inputDir) {
    return jsonRes(res, 501, { error: 'input_dir_unconfigured', message: '网关未配置 inputDir，无法删除输入文件' });
  }
  const filename = url.searchParams.get('filename') ?? '';
  const subfolder = url.searchParams.get('subfolder') ?? '';
  const resolved = resolveMediaTarget(cfg.inputDir, filename, subfolder);
  if (resolved.error) return jsonRes(res, 400, { error: 'invalid_path', message: resolved.error });
  const { target } = resolved;
  try {
    const stat = fsSync.statSync(target);
    if (!stat.isFile()) return jsonRes(res, 400, { error: 'not_a_file', message: '目标不是文件' });
  } catch {
    return jsonRes(res, 404, { error: 'not_found', message: '文件不存在（可能已被删除）' });
  }
  try {
    fsSync.unlinkSync(target);
    return jsonRes(res, 200, { ok: true, deleted: filename });
  } catch (err) {
    return jsonRes(res, 500, { error: 'delete_failed', message: String(err.message) });
  }
}

/** 应用版本号（package.json，启动后缓存一次）。 */
let appVersion = null;
function getAppVersion() {
  if (appVersion == null) {
    try {
      appVersion = JSON.parse(fsSync.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '';
    } catch {
      appVersion = ''; // 版本文件缺失只影响关于页展示
    }
  }
  return appVersion;
}

export function createGateway(cfg, webRoot) {
  const proxyRequest = createUpstreamRequester(cfg);
  const respondThumbnail = createThumbnailResponder(cfg);

  /** 鉴权失败滑动窗口：ip → 时间戳数组 */
  const authFails = new Map();
  /** 写操作滑动窗口：全局 key → 时间戳数组 */
  const writeHits = [];

  function pruneWithin(list, windowMs, now) {
    while (list.length && now - list[0] > windowMs) list.shift();
  }

  function isBanned(ip) {
    const list = authFails.get(ip);
    if (!list) return false;
    const now = Date.now();
    // 数组元素为 {t: 失败时间, banUntil: 累计封禁截止}（仅末尾可能带封禁）
    const last = list[list.length - 1];
    return Boolean(last && last.banUntil && now < last.banUntil);
  }

  function onAuthFail(ip) {
    const now = Date.now();
    const list = authFails.get(ip) ?? [];
    pruneWithin(list, 60_000, now);
    list.push({ t: now });
    if (list.length > cfg.authFailsPerMin) {
      list[list.length - 1].banUntil = now + cfg.banMinutes * 60_000;
    }
    authFails.set(ip, list);
  }

  function tokenOk(url) {
    return tokenMatches(cfg.token, url.searchParams.get('token') ?? '');
  }

  /** 请求是否携带了令牌（用于区分「令牌错误」与「未登录」）。 */
  function tokenProvided(req, url) {
    const header = req.headers.authorization;
    if (typeof header === 'string' && /^Bearer\s+\S/i.test(header)) return true;
    if (url.searchParams.get('token')) return true;
    const cookie = req.headers.cookie;
    if (typeof cookie === 'string' && /(?:^|;\s*)cm_token=([^;]*\S)/.test(cookie)) return true;
    return false;
  }

  /**
   * 三通道鉴权：Bearer 头 → 查询参数 → Cookie。
   * @returns {boolean}
   */
  function requestAuthorized(req, url) {
    const header = req.headers.authorization;
    if (typeof header === 'string' && /^Bearer\s+(.+)$/i.test(header)) {
      return tokenMatches(cfg.token, header.replace(/^Bearer\s+/i, '').trim());
    }
    if (tokenOk(url)) return true;
    const cookie = req.headers.cookie;
    if (typeof cookie === 'string') {
      const match = /(?:^|;\s*)cm_token=([^;]+)/.exec(cookie);
      if (match) return tokenMatches(cfg.token, decodeURIComponent(match[1]));
    }
    return false;
  }

  function isWrite(req) {
    return req.method === 'POST' || req.method === 'DELETE' || req.method === 'PUT';
  }

  function rateLimited() {
    const now = Date.now();
    pruneWithin(writeHits, 60_000, now);
    if (writeHits.length >= cfg.rateLimitPerMin) return true;
    writeHits.push(now);
    return false;
  }

  async function handler(req, res) {
    // 以 // 开头的请求路径会被 new URL 当作协议相对引用解析成“主机名”，先规范化
    const rawUrl = req.url.replace(/^\/{2,}/, '/');
    let url;
    try {
      url = new URL(rawUrl, 'http://local');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const pathname = url.pathname;
    const started = Date.now();
    res.on('finish', () => {
      const clean = pathname === '/ws' ? '/ws' : `${pathname}${url.search.replace(/([?&])token=[^&]*/g, '$1token=***')}`;
      console.log(`${req.method} ${clean} → ${res.statusCode} (${Date.now() - started}ms)`);
    });

    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, version: getAppVersion() }));
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (serveStatic(webRoot, pathname, res)) return;
      if (pathname === '/') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('web 资源缺失：请确认 webDir 配置正确');
        return;
      }
      // 未命中的 GET 路径（如 /prompt、/history、/view）落入下方鉴权代理
    }

    const ip = clientAddress(req);
    if (isBanned(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'banned', message: '鉴权失败次数过多，请稍后再试' }));
      return;
    }
    if (!requestAuthorized(req, url)) {
      // 只有「带了令牌但不对」才计入防爆破；未登录/已清空令牌的请求不计，
      // 避免客户端轮询把自己封死（令牌轮换后正是这种情况）
      if (tokenProvided(req, url)) onAuthFail(ip);
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'unauthorized', message: '缺少或错误的访问令牌' }));
      return;
    }
    // 写操作限流：保护 ComfyUI 不被脚本刷爆（上传/提交/改历史）。
    // /gw/* 是网关本机的文件操作（输入文件夹批量删除等），便宜且已有令牌与封禁保护，不计入。
    if (isWrite(req) && !pathname.startsWith('/gw/') && rateLimited()) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'rate_limited', message: `写操作超过每分钟 ${cfg.rateLimitPerMin} 次限制` }));
      return;
    }

    // 纵深防御：/view 文件名与 /userdata 路径在网关侧二次校验（URL 已解码后判定）
    if (pathname === '/view' && !isSafeMediaName(url.searchParams.get('filename') ?? '')) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'invalid_filename', message: '文件名不合法' }));
      return;
    }
    if (pathname.startsWith('/userdata/')) {
      let decodedPath = '';
      try {
        decodedPath = decodeURIComponent(pathname);
      } catch {
        decodedPath = '\u0000'; // 解码失败视为非法
      }
      if (decodedPath.includes('..') || decodedPath.includes('\\')) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'invalid_path', message: '路径不合法' }));
        return;
      }
    }

    // 测速端点：返回指定大小的随机数据，用于对比各接入路径（tailnet/隧道）吞吐
    if (pathname === '/gw/speedtest' && (req.method === 'GET' || req.method === 'HEAD')) {
      const mb = Math.max(0.1, Math.min(64, Number(url.searchParams.get('mb') ?? 4)));
      const bytes = Math.round(mb * 1024 * 1024);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': bytes,
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      // 分块写入，避免一次性占用大内存
      const chunk = Buffer.alloc(64 * 1024, 7);
      let sent = 0;
      const pump = () => {
        while (sent < bytes) {
          const left = bytes - sent;
          const buf = left >= chunk.length ? chunk : chunk.subarray(0, left);
          sent += buf.length;
          if (!res.write(buf)) { res.once('drain', pump); return; }
        }
        res.end();
      };
      pump();
      return;
    }

    // LLM 提示词增强：转发到 config.promptLlm 配置的 OpenAI 兼容端点（智谱/Ollama/llama.cpp…）。
    // 未配置回 501，手机端回退内置规则增强；端点故障回 502 并带原因。
    if (pathname === '/gw/enhance-prompt' && req.method === 'POST') {
      const llm = cfg.promptLlm ?? {};
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      if (!llm.enabled || !llm.models?.length) {
        json(501, { error: 'llm_not_configured', message: '网关未启用智能增强（server/config.json 的 promptLlm）' });
        return;
      }
      const raw = await readBody(req, 64 * 1024);
      let payload;
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        json(400, { error: 'invalid_json', message: '请求体不是合法 JSON' });
        return;
      }
      const text = String(payload.text ?? '').trim();
      if (!text) {
        json(400, { error: 'empty_text', message: '缺少提示词内容' });
        return;
      }
      // 手机端可指定模型（name 或 model 任一匹配）；未指定/未命中用 default
      const requested = String(payload.model ?? '').trim();
      const entry = llm.models.find((m) => m.name === requested || m.model === requested)
        ?? llm.models.find((m) => m.name === llm.default)
        ?? llm.models[0];
      try {
        const out = await enhanceWithLlm(entry, {
          text,
          profileKey: String(payload.profileKey ?? 'generic'),
          mode: String(payload.mode ?? 't2i'),
        });
        json(200, { text: out.text, source: 'llm', model: entry.model, name: entry.name });
      } catch (err) {
        json(502, { error: 'llm_failed', message: `增强失败：${err.message}` });
      }
      return;
    }

    // 已配置的增强模型列表：只下发名称与模型标识（绝不返回 baseUrl/apiKey），供手机端下拉切换
    if (pathname === '/gw/enhance-models' && req.method === 'GET') {
      const llm = cfg.promptLlm ?? {};
      const enabled = Boolean(llm.enabled && llm.models?.length);
      jsonRes(res, 200, {
        enabled,
        default: enabled ? llm.default : null,
        models: enabled ? llm.models.map((m) => ({ name: m.name, model: m.model })) : [],
      });
      return;
    }

    // 图库删除：移除 ComfyUI 输出目录下的媒体文件（需配置 outputDir，仅限该目录子树）
    if (pathname === '/gw/output-file' && req.method === 'DELETE') {
      handleDeleteOutputFile(cfg, url, res);
      return;
    }

    // 输入目录：列出（选择器按最新时间排序）与删除（需配置 inputDir，仅限该目录子树）
    if (pathname === '/gw/input-files' && (req.method === 'GET' || req.method === 'HEAD')) {
      handleListInputFiles(cfg, res);
      return;
    }
    if (pathname === '/gw/input-file' && req.method === 'DELETE') {
      handleDeleteInputFile(cfg, url, res);
      return;
    }

    // ComfyUI 进程管理：status 探测 + start/restart 按本地 comfyuiLaunch 配置管理 ComfyUI 进程。
    // 启动命令只来自本机 server/config.json，请求体不参与——接口无法被用来执行任意命令；
    // 15 秒拉起防抖在 comfy-process 内部（/gw/* 不计写限流，防抖即此处的洪峰保护）。
    const comfyLogsDir = path.resolve(webRoot, '..', 'logs');
    if (pathname === '/gw/comfyui/status' && req.method === 'GET') {
      jsonRes(res, 200, await comfyStatus(cfg));
      return;
    }
    if (pathname === '/gw/comfyui/start' && req.method === 'POST') {
      const result = await startComfyUI(cfg, { logsDir: comfyLogsDir });
      jsonRes(res, result.ok ? 200 : result.code, result.ok
        ? { status: result.status, ...(result.pid ? { pid: result.pid } : {}) }
        : { error: result.error, message: result.message });
      return;
    }
    if (pathname === '/gw/comfyui/restart' && req.method === 'POST') {
      const result = await restartComfyUI(cfg, { logsDir: comfyLogsDir });
      jsonRes(res, result.ok ? 200 : result.code, result.ok
        ? { status: result.status, ...(result.pid ? { pid: result.pid } : {}) }
        : { error: result.error, message: result.message });
      return;
    }

    // /view 图片缩略图：配置了对应目录且文件在盘上时本地生成，未命中继续走代理
    if (pathname === '/view' && await respondThumbnail(req, url, res)) return;

    proxyRequest(req, res);
  }

  const server = cfg.tls
    ? https.createServer({ cert: fs.readFileSync(cfg.tls.cert), key: fs.readFileSync(cfg.tls.key) }, handler)
    : http.createServer(handler);

  server.keepAliveTimeout = 120_000;
  attachWebSocketProxy(server, cfg, { tokenOk, onAuthFail, isBanned });

  return { server, close: () => new Promise((resolve) => server.close(resolve)) };
}
