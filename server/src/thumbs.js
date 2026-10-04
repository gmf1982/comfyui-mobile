/**
 * 网关本地缩略图：/view 带 preview=webp 的图片请求在网关侧直接读盘生成小尺寸 WebP。
 * ComfyUI 的 preview 参数只转码不降分辨率，全分辨率 WebP 在手机弱网链路上仍有数百 KB；
 * 网关与 ComfyUI 同机，本地读文件 + sharp 缩放把缩略图压到几十 KB 量级，并落盘缓存避免重复编码。
 * inputDir/outputDir 未配置、源文件不存在、非静态图片或 sharp 不可用时返回 false，交回代理走上游。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { extOf } from './media.js';

/** 适合单帧缩略图的静态图片扩展名（动图 gif 与视频/音频不适用）。 */
const THUMB_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'tiff']);

/** 浏览器缓存时长：与 proxy.js 的媒体缓存分级一致（output 视为不可变；input 靠前端 v=mtime 版本参数防陈旧，1 小时兜底）。 */
const CACHE_CONTROL = { output: 'public, max-age=86400', input: 'public, max-age=3600' };

const DEFAULT_MAX_DIM = 512;

function clampInt(raw, min, max, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 按 key 落盘缓存；写入失败只影响下次重新生成，不影响本次响应。 */
async function writeCacheAtomic(cachePath, body) {
  const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, cachePath);
  } catch {
    try {
      await fsp.unlink(tmp);
    } catch {
      // tmp 未落盘成功时无需清理
    }
  }
}

/**
 * 创建 /view 缩略图响应器。
 * @param {object} cfg 网关配置（inputDir/outputDir/thumbCacheDir）
 * @returns {(req: import('node:http').IncomingMessage, url: URL, res: import('node:http').ServerResponse) => Promise<boolean>}
 *   true 表示已响应；false 表示不适用，调用方继续走代理
 */
export function createThumbnailResponder(cfg) {
  let sharpPromise = null;

  /** sharp 缺失/加载失败时缩略图整体退化为代理透传，只告警一次。 */
  function loadSharp() {
    if (!sharpPromise) {
      sharpPromise = import('sharp').then(
        (m) => m.default,
        (err) => {
          console.warn(`[comfyui-mobile] sharp 加载失败，缩略图退化为代理透传：${err.message}`);
          return null;
        },
      );
    }
    return sharpPromise;
  }

  return async function respondThumbnail(req, url, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const [format, qualityRaw] = (url.searchParams.get('preview') ?? '').split(';');
    if (format !== 'webp') return false;
    const filename = url.searchParams.get('filename') ?? '';
    if (!THUMB_EXTS.has(extOf(filename))) return false;
    const type = url.searchParams.get('type') ?? 'output';
    const root = type === 'input' ? cfg.inputDir : type === 'output' ? cfg.outputDir : '';
    if (!root) return false;

    const subfolder = url.searchParams.get('subfolder') ?? '';
    const absRoot = path.resolve(root);
    const target = path.resolve(absRoot, subfolder, filename);
    if (target !== absRoot && !target.startsWith(absRoot + path.sep)) return false;

    let stat;
    try {
      stat = await fsp.stat(target);
      if (!stat.isFile()) return false;
    } catch {
      // 文件不存在/不可读：交给上游 ComfyUI 给出标准响应
      return false;
    }

    const quality = clampInt(qualityRaw, 30, 95, 70);
    const maxDim = clampInt(url.searchParams.get('w'), 16, 2048, DEFAULT_MAX_DIM);
    // mtime+size 进缓存键：电脑端手动替换同名文件后自动失效重生成
    const key = crypto.createHash('sha1')
      .update([type, subfolder, filename, stat.mtimeMs, stat.size, maxDim, quality].join('\u0000'))
      .digest('hex');
    // ETag=缓存键：max-age 过期（或被系统逐出）后浏览器带 If-None-Match 回来，
    // 未变只回 304，不再整张重下——文件没动过时 mtime/size 不变，键稳定
    const etag = `"${key}"`;
    const headers = {
      'Content-Type': 'image/webp',
      'Cache-Control': CACHE_CONTROL[type] ?? CACHE_CONTROL.input,
      ETag: etag,
    };

    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && String(ifNoneMatch).split(',').map((candidate) => candidate.trim()).some((candidate) => candidate === etag || candidate === `W/${etag}` || candidate === '*')) {
      res.writeHead(304, { 'Cache-Control': headers['Cache-Control'], ETag: etag });
      res.end();
      return true;
    }

    const cachePath = path.join(cfg.thumbCacheDir, `${key}.webp`);

    const send = (body) => {
      res.writeHead(200, { ...headers, 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    try {
      send(await fsp.readFile(cachePath));
      return true;
    } catch {
      // 缓存未命中：走生成流程
    }

    const sharp = await loadSharp();
    if (!sharp) return false;

    let body;
    try {
      // rotate() 按 EXIF 方向摆正（手机照片常见）；fit inside 保证不放大
      body = await sharp(target, { failOn: 'error' })
        .rotate()
        .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
        .webp({ quality })
        .toBuffer();
    } catch (err) {
      // 解码失败（损坏/不支持的变体）：退回上游响应，保持与无网关缩略图时一致
      console.warn(`[comfyui-mobile] 缩略图生成失败（${filename}）：${err.message}`);
      return false;
    }
    await writeCacheAtomic(cachePath, body);
    send(body);
    return true;
  };
}
