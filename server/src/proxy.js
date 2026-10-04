/**
 * ComfyUI 反向代理：请求/响应全流式，头过滤透传，Range 直通，上传体积硬限制。
 */
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { mimeOfFilename } from './media.js';

const REQ_HEADER_ALLOW = new Set([
  'content-type', 'content-length', 'range', 'accept', 'accept-encoding',
  'if-none-match', 'if-modified-since', 'user-agent',
]);
const RES_HEADER_ALLOW = new Set([
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'etag',
  'last-modified', 'content-disposition', 'content-encoding', 'cache-control',
]);

/** 从请求 URL 与响应头推断应补齐的 Content-Type（aiohttp 对部分媒体不返回类型）。 */
function inferContentType(reqUrl, upstreamHeaders) {
  if (upstreamHeaders['content-type']) return upstreamHeaders['content-type'];
  let url;
  try {
    url = new URL(reqUrl, 'http://local');
  } catch {
    return '';
  }
  const filename = url.searchParams.get('filename') || url.pathname;
  const mime = mimeOfFilename(filename);
  return mime || (url.pathname === '/upload/image' ? 'application/json' : '');
}

/** 浏览器缓存时长：输出文件名由 ComfyUI 唯一化（同名自动加序号），内容视为不可变；
 * input 目录文件由前端在 URL 上附加 mtime 版本参数防陈旧（media.js inputMediaUrl），
 * 未带版本参数的请求（网关未配 inputDir 等场景）由 1 小时短缓存兜底。 */
const MEDIA_CACHE_CONTROL = { output: 'public, max-age=86400', input: 'public, max-age=3600' };

/**
 * 创建上游请求执行器。
 * @param {object} cfg 网关配置（upstream、maxUploadMB）
 */
export function createUpstreamRequester(cfg) {
  const upstream = new URL(cfg.upstream);
  const agent = new (upstream.protocol === 'https:' ? https : http).Agent({ keepAlive: true });
  const limitBytes = cfg.maxUploadMB * 1024 * 1024;

  /**
   * 将客户端请求代理到上游并回写响应。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  return function proxyRequest(req, res) {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (REQ_HEADER_ALLOW.has(name.toLowerCase())) headers[name] = value;
    }
    const declaredLength = Number(req.headers['content-length'] ?? NaN);
    const precheck = Number.isFinite(declaredLength) && declaredLength > limitBytes;
    if (precheck) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'payload_too_large', message: `上传超过 ${cfg.maxUploadMB}MB 限制` }));
      return;
    }

    const url = new URL(req.url, upstream);
    const upstreamReq = (url.protocol === 'https:' ? https : http).request(url, {
      method: req.method,
      headers,
      agent,
    });

    let forwarded = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      forwarded += chunk.length;
      if (forwarded > limitBytes) {
        aborted = true;
        upstreamReq.destroy();
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'payload_too_large', message: `上传超过 ${cfg.maxUploadMB}MB 限制` }));
        } else {
          res.destroy();
        }
        return;
      }
      upstreamReq.write(chunk);
    });
    req.on('end', () => {
      if (!aborted) upstreamReq.end();
    });
    req.on('error', () => {
      aborted = true;
      upstreamReq.destroy();
    });

    upstreamReq.on('response', (upstreamRes) => {
      const out = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (RES_HEADER_ALLOW.has(name.toLowerCase())) out[name] = value;
      }
      const contentType = inferContentType(req.url, upstreamRes.headers);
      if (contentType) out['Content-Type'] = contentType;
      // JSON 是会变化的状态（工作流文件/历史/队列）：上游不带 Cache-Control，
      // 浏览器会启发式缓存旧副本，保存后重新打开会读到旧内容（2026-09-28 实测）。
      // 统一禁止存储；媒体（image/video/audio）上游也不带缓存头，不补会让图库/队列
      // 每次打开都全量重下（2026-09-29 实测），按 type 分级补缓存。
      if (String(out['Content-Type'] ?? '').includes('application/json')) {
        out['Cache-Control'] = 'no-store';
      } else if (!out['Cache-Control'] && /^(?:image|video|audio)\//.test(String(out['Content-Type'] ?? ''))) {
        out['Cache-Control'] = MEDIA_CACHE_CONTROL[url.searchParams.get('type') ?? 'output'] ?? MEDIA_CACHE_CONTROL.input;
      }
      // /history 列表单独走 ETag 协商缓存：每条记录内嵌完整工作流图，实测 100 条 ≈ 288KB，
      // 图库每次进入都要拉取，no-store 会让手机反复全量重下。改为 no-cache + ETag：
      // 内容未变回 304；新增运行/删除记录都会改变 ETag 返回全量，不存在读到旧内容的问题。
      if (
        req.method === 'GET' && url.pathname === '/history' &&
        (upstreamRes.statusCode ?? 500) === 200 &&
        String(out['Content-Type'] ?? '').includes('application/json')
      ) {
        const chunks = [];
        upstreamRes.on('data', (c) => chunks.push(c));
        upstreamRes.on('end', () => {
          const body = Buffer.concat(chunks);
          const etag = `"h${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
          const inm = String(req.headers['if-none-match'] ?? '')
            .split(',').map((s) => s.trim()).filter(Boolean);
          if (inm.includes(etag) || inm.includes(`W/${etag}`)) {
            res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
            res.end();
            return;
          }
          res.writeHead(200, { ...out, 'Cache-Control': 'no-cache', ETag: etag, 'Content-Length': body.length });
          res.end(body);
        });
        return;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, out);
      upstreamRes.pipe(res);
    });
    upstreamReq.on('error', (err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: 'upstream_unreachable',
        message: `无法连接 ComfyUI（${cfg.upstream}）：${err.message}`,
      }));
    });
  };
}
