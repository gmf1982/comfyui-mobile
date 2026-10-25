/**
 * 图库直读 output 目录：把图库数据源与 ComfyUI 运行状态解耦。
 * ComfyUI 重启会清空 /history，但磁盘文件还在——这里直接扫 outputDir 提供列表、
 * 文件流（Range/下载）、缩略图（图片 sharp / 视频 ffmpeg 抽帧）与批量删除。
 * 所有路径必须位于 outputDir 子树内且为媒体扩展名，防止越权读写。
 */
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { extOf, mediaTypeOf, mimeOfFilename, contentDisposition } from './media.js';

const SCAN_TTL_MS = 5000;
const MAX_PAGE = 200;
const SORT_KEYS = new Set(['mtime', 'name', 'size']);
const FILTER_KEYS = new Set(['all', 'image', 'video', 'audio']);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function clampInt(raw, min, max, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 校验目录相对路径（POSIX 分隔）并解析出必须位于 root 内的绝对路径。 */
function resolveRel(root, relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.length > 1024) return null;
  if (relPath.includes('\\') || relPath.includes('\u0000')) return null;
  const segs = relPath.split('/').filter(Boolean);
  if (!segs.length || segs.some((s) => s === '.' || s === '..' || s.startsWith('.'))) return null;
  const absRoot = path.resolve(root);
  const target = path.resolve(absRoot, ...segs);
  if (target !== absRoot && !target.startsWith(absRoot + path.sep)) return null;
  return { absRoot, target, name: segs[segs.length - 1] };
}

/** 校验目录相对路径（用于 dir 前缀过滤），非法返回 null；空串表示根目录。 */
function validRelDir(dirPath) {
  if (dirPath == null || dirPath === '') return '';
  if (typeof dirPath !== 'string' || dirPath.length > 1024) return null;
  if (dirPath.includes('\\') || dirPath.includes('\u0000')) return null;
  const segs = dirPath.split('/').filter(Boolean);
  if (segs.some((s) => s === '.' || s === '..' || s.startsWith('.'))) return null;
  return segs.join('/');
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** tEXt：keyword\0text */
function pngTextValue(data, nul) {
  return nul === -1 ? null : data.toString('utf8', nul + 1);
}

/** iTXt：keyword\0 压缩标记(1) 压缩方法(1) 语言标签\0 翻译关键词\0 text；仅支持未压缩 */
function pngItxtValue(data, nul) {
  if (nul === -1 || data[nul + 1] !== 0) return null;
  let p = nul + 2;
  let nuls = 0;
  while (p < data.length && nuls < 2) {
    if (data[p] === 0) nuls++;
    p++;
  }
  return nuls === 2 ? data.toString('utf8', p) : null;
}

/**
 * 从 PNG 头部缓冲里提取 ComfyUI 嵌入的 prompt（API 格式 JSON）。
 * 文本块写在图像数据（IDAT）之前，扫到 IDAT 还没找到即可放弃——
 * 大图的图像数据动辄数 MB，绝不能扫进去。
 */
function extractPngPrompt(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const start = off + 8;
    if (start + len > buf.length) return null; // 读取窗口截断：文本块应在更靠前位置
    if (type === 'tEXt' || type === 'iTXt') {
      const data = buf.subarray(start, start + len);
      const nul = data.indexOf(0);
      const keyword = nul === -1 ? '' : data.toString('latin1', 0, nul);
      if (keyword === 'prompt') {
        const text = type === 'tEXt' ? pngTextValue(data, nul) : pngItxtValue(data, nul);
        if (text) {
          try { return JSON.parse(text); } catch { return null; }
        }
      }
    } else if (type === 'IDAT' || type === 'IEND') {
      return null;
    }
    off = start + len + 4; // 跳过数据与 CRC
  }
  return null;
}

/** 递归收集 outputDir 下的媒体文件（跳过隐藏文件/目录），逐个 stat 出排序用的元数据。 */
async function scanAll(root) {
  const rels = [];
  async function walk(rel) {
    let entries;
    try {
      entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return; // 子目录读取失败（权限/被占用）时跳过，不拖垮整个列表
    }
    for (const de of entries) {
      if (de.name.startsWith('.')) continue;
      const child = rel ? `${rel}/${de.name}` : de.name;
      if (de.isDirectory()) {
        await walk(child);
        continue;
      }
      if (de.isFile() && mediaTypeOf(de.name) !== 'other') rels.push(child);
    }
  }
  await walk('');
  const items = [];
  const BATCH = 128;
  for (let i = 0; i < rels.length; i += BATCH) {
    const stats = await Promise.all(rels.slice(i, i + BATCH).map(async (rel) => {
      try {
        const st = await fsp.stat(path.join(root, rel));
        if (!st.isFile()) return null;
        const name = rel.slice(rel.lastIndexOf('/') + 1);
        return { path: rel, name, kind: mediaTypeOf(name), size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        return null; // stat 间隙被删除：本次列表不收录
      }
    }));
    items.push(...stats.filter(Boolean));
  }
  return items;
}

/**
 * 创建 output 目录图库处理器（每个网关实例一份，扫描/ffmpeg 探测结果在闭包内缓存）。
 * @param {object} cfg 网关配置（outputDir/thumbCacheDir/ffmpegPath）
 */
export function createOutputGallery(cfg) {
  /** @type {{at: number, items: Array}|null} */
  let cache = null;
  /** @type {Promise|null} 进行中的扫描，并发请求共享同一次结果 */
  let pending = null;
  /** @type {Promise<string|null>|null} ffmpeg 可执行文件；null=不可用 */
  let ffmpegProbe = null;

  async function getItems(force = false) {
    if (force || !cache || Date.now() - cache.at > SCAN_TTL_MS) {
      if (!pending) {
        pending = scanAll(path.resolve(cfg.outputDir))
          .then((items) => { cache = { at: Date.now(), items }; pending = null; })
          .catch((err) => { pending = null; throw err; });
      }
      await pending;
    }
    return cache.items;
  }

  function invalidate() { cache = null; }

  // ---------- GET /gw/output-list ----------
  async function list(url, res, lang) {
    if (!cfg.outputDir) {
      return json(res, 501, { error: 'output_dir_unconfigured', message: lang === 'en' ? 'outputDir is not configured on the gateway' : '网关未配置 outputDir' });
    }
    const sort = SORT_KEYS.has(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'mtime';
    const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';
    const filter = FILTER_KEYS.has(url.searchParams.get('filter')) ? url.searchParams.get('filter') : 'all';
    const offset = clampInt(url.searchParams.get('offset'), 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = clampInt(url.searchParams.get('limit'), 1, MAX_PAGE, 60);
    const dir = validRelDir(url.searchParams.get('dir') ?? '');
    if (dir === null) {
      return json(res, 400, { error: 'invalid_path', message: lang === 'en' ? 'Invalid folder path' : '文件夹路径不合法' });
    }
    try {
      const all = await getItems(url.searchParams.get('refresh') === '1');
      let filtered = filter === 'all' ? all : all.filter((i) => i.kind === filter);
      if (dir) filtered = filtered.filter((i) => i.path.startsWith(`${dir}/`));
      const sign = order === 'asc' ? 1 : -1;
      const cmp = sort === 'name'
        ? (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        : sort === 'size' ? (a, b) => a.size - b.size : (a, b) => a.mtimeMs - b.mtimeMs;
      filtered.sort((a, b) => cmp(a, b) * sign || a.path.localeCompare(b.path));
      json(res, 200, { total: filtered.length, offset, limit, items: filtered.slice(offset, offset + limit) });
    } catch (err) {
      json(res, 500, { error: 'scan_failed', message: err.message });
    }
  }

  // ---------- GET /gw/output-dirs（含媒体的子目录清单，供文件夹下拉） ----------
  async function dirs(url, res, lang) {
    if (!cfg.outputDir) {
      return json(res, 501, { error: 'output_dir_unconfigured', message: lang === 'en' ? 'outputDir is not configured on the gateway' : '网关未配置 outputDir' });
    }
    try {
      const all = await getItems(url.searchParams.get('refresh') === '1');
      const set = new Set();
      for (const item of all) {
        const segs = item.path.split('/');
        segs.pop();
        let acc = '';
        for (const s of segs) {
          acc = acc ? `${acc}/${s}` : s;
          set.add(acc);
        }
      }
      json(res, 200, { dirs: [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })) });
    } catch (err) {
      json(res, 500, { error: 'scan_failed', message: err.message });
    }
  }

  // ---------- GET /gw/output-file（预览流 + ?download=1 直下） ----------
  async function file(req, url, res, lang) {
    if (!cfg.outputDir) {
      return json(res, 501, { error: 'output_dir_unconfigured', message: lang === 'en' ? 'outputDir is not configured on the gateway' : '网关未配置 outputDir' });
    }
    const resolved = resolveRel(cfg.outputDir, url.searchParams.get('path') ?? '');
    if (!resolved || mediaTypeOf(resolved.name) === 'other') {
      return json(res, 400, { error: 'invalid_path', message: lang === 'en' ? 'Invalid file path' : '文件路径不合法' });
    }
    let st;
    try {
      st = await fsp.stat(resolved.target);
      if (!st.isFile()) throw new Error('not_file');
    } catch {
      return json(res, 404, { error: 'not_found', message: lang === 'en' ? 'File not found (it may have been deleted)' : '文件不存在（可能已被删除）' });
    }
    const download = url.searchParams.get('download') === '1';
    const etag = `"o${st.size}-${st.mtimeMs}"`;
    const headers = {
      'Content-Type': mimeOfFilename(resolved.name) || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Cache-Control': download ? 'no-store' : 'public, max-age=86400',
      'Last-Modified': st.mtime.toUTCString(),
    };
    if (download) {
      headers['Content-Disposition'] = contentDisposition(resolved.name, true);
    } else if ((req.headers['if-none-match'] ?? '').split(',').map((s) => s.trim())
      .some((s) => s === etag || s === `W/${etag}` || s === '*')) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'] });
      res.end();
      return;
    }

    // Range：视频拖动进度条必需；只处理单区间，畸形/多区间回退全量
    let range = null;
    const rangeHeader = !download ? req.headers.range : null;
    if (typeof rangeHeader === 'string' && /^bytes=\d*-\d*$/.test(rangeHeader.trim())) {
      const [startRaw, endRaw] = rangeHeader.trim().slice(6).split('-');
      let start;
      let end;
      if (startRaw === '') {
        const n = Number(endRaw); // 后缀区间：取末尾 N 字节
        if (!n) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          res.end();
          return;
        }
        start = Math.max(0, st.size - n);
        end = st.size - 1;
      } else {
        start = Number(startRaw);
        end = endRaw === '' ? st.size - 1 : Math.min(Number(endRaw), st.size - 1);
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return;
      }
      range = { start, end };
    }

    const code = range ? 206 : 200;
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${st.size}`;
      headers['Content-Length'] = range.end - range.start + 1;
    } else {
      headers['Content-Length'] = st.size;
    }
    res.writeHead(code, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fsSync.createReadStream(resolved.target, range ? { start: range.start, end: range.end } : undefined);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  // ---------- GET /gw/output-thumb（图片 sharp 缩放 / 视频 ffmpeg 抽帧，落盘缓存同 thumbs.js） ----------
  function loadSharp() {
    if (!loadSharp.promise) {
      loadSharp.promise = import('sharp').then(
        (m) => m.default,
        (err) => {
          console.warn(`[comfyui-mobile] sharp 加载失败，图库缩略图不可用：${err.message}`);
          return null;
        },
      );
    }
    return loadSharp.promise;
  }

  function getFfmpeg() {
    if (!ffmpegProbe) {
      const bin = cfg.ffmpegPath || 'ffmpeg';
      ffmpegProbe = new Promise((resolve) => {
        const child = spawn(bin, ['-version'], { windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(() => { child.kill(); resolve(null); }, 8000);
        child.once('error', () => { clearTimeout(timer); resolve(null); });
        child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0 ? bin : null); });
      });
    }
    return ffmpegProbe;
  }

  /** 抽一帧到 stdout（PNG 流）；seek 失败（超短视频）时由调用方不带 -ss 重试。 */
  function posterPng(ffmpeg, target, seek) {
    const args = seek ? ['-hide_banner', '-loglevel', 'error', '-ss', '0.1', '-i', target, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']
      : ['-hide_banner', '-loglevel', 'error', '-i', target, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'];
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = [];
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
      child.stdout.on('data', (c) => chunks.push(c));
      child.once('error', (err) => { clearTimeout(timer); reject(err); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        if (code === 0 && buf.length) resolve(buf);
        else reject(new Error(`ffmpeg_exit_${code}`));
      });
    });
  }

  async function thumb(req, url, res, lang) {
    if (!cfg.outputDir || !cfg.thumbCacheDir) return json(res, 404, { error: 'no_thumb' });
    const resolved = resolveRel(cfg.outputDir, url.searchParams.get('path') ?? '');
    if (!resolved) return json(res, 400, { error: 'invalid_path', message: lang === 'en' ? 'Invalid file path' : '文件路径不合法' });
    const kind = mediaTypeOf(resolved.name);
    if (kind === 'audio' || kind === 'other') return json(res, 404, { error: 'no_thumb' });
    let st;
    try {
      st = await fsp.stat(resolved.target);
      if (!st.isFile()) throw new Error('not_file');
    } catch {
      return json(res, 404, { error: 'not_found' });
    }
    const quality = clampInt(url.searchParams.get('q'), 30, 95, 62);
    const maxDim = clampInt(url.searchParams.get('w'), 16, 1024, 448);
    const key = crypto.createHash('sha1')
      .update(['og', url.searchParams.get('path') ?? '', st.mtimeMs, st.size, maxDim, quality].join('\u0000'))
      .digest('hex');
    const etag = `"${key}"`;
    const cacheHeaders = { 'Cache-Control': 'public, max-age=86400', ETag: etag };
    if ((req.headers['if-none-match'] ?? '').split(',').map((s) => s.trim())
      .some((s) => s === etag || s === `W/${etag}` || s === '*')) {
      res.writeHead(304, cacheHeaders);
      res.end();
      return;
    }
    const cachePath = path.join(cfg.thumbCacheDir, `${key}.webp`);
    let body;
    try {
      body = await fsp.readFile(cachePath);
    } catch {
      const sharp = await loadSharp();
      if (!sharp) return json(res, 404, { error: 'no_thumb' });
      try {
        let source;
        if (kind === 'image') {
          source = resolved.target;
        } else {
          const ffmpeg = await getFfmpeg();
          if (!ffmpeg) return json(res, 404, { error: 'no_ffmpeg' });
          source = await posterPng(ffmpeg, resolved.target, true)
            .catch(() => posterPng(ffmpeg, resolved.target, false)); // 极短视频 0.1s 处可能无帧
        }
        // rotate() 按 EXIF 方向摆正；fit inside 保证不放大
        body = await sharp(source, { failOn: 'error' })
          .rotate()
          .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
          .webp({ quality })
          .toBuffer();
      } catch (err) {
        return json(res, 404, { error: 'thumb_failed', message: err.message });
      }
      // 缓存写失败只影响下次重新生成
      try {
        const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
        await fsp.mkdir(path.dirname(cachePath), { recursive: true });
        await fsp.writeFile(tmp, body);
        await fsp.rename(tmp, cachePath);
      } catch { /* 忽略 */ }
    }
    res.writeHead(200, { 'Content-Type': 'image/webp', ...cacheHeaders, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // ---------- GET /gw/output-prompt（从 PNG 元数据提取 ComfyUI prompt，供复制提示词/重跑） ----------
  async function prompt(req, url, res, lang) {
    if (!cfg.outputDir) {
      return json(res, 501, { error: 'output_dir_unconfigured', message: lang === 'en' ? 'outputDir is not configured on the gateway' : '网关未配置 outputDir' });
    }
    const resolved = resolveRel(cfg.outputDir, url.searchParams.get('path') ?? '');
    if (!resolved || extOf(resolved.name) !== 'png') return json(res, 404, { error: 'no_prompt' });
    let head;
    try {
      const fh = await fsp.open(resolved.target, 'r');
      try {
        const len = Math.min(512 * 1024, (await fh.stat()).size);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, 0);
        head = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch {
      return json(res, 404, { error: 'no_prompt' });
    }
    const promptJson = extractPngPrompt(head);
    if (!promptJson) return json(res, 404, { error: 'no_prompt' });
    json(res, 200, { prompt: promptJson });
  }

  // ---------- POST /gw/output-delete（批量） ----------
  function readJson(req, maxBytes) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          reject(new Error('body_too_large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch { reject(new Error('invalid_json')); }
      });
      req.once('error', reject);
    });
  }

  async function batchDelete(req, res, lang) {
    if (!cfg.outputDir) {
      return json(res, 501, { error: 'output_dir_unconfigured', message: lang === 'en' ? 'outputDir is not configured on the gateway' : '网关未配置 outputDir' });
    }
    let payload;
    try {
      payload = await readJson(req, 256 * 1024);
    } catch {
      return json(res, 400, { error: 'invalid_json', message: lang === 'en' ? 'Request body is not valid JSON' : '请求体不是合法 JSON' });
    }
    const paths = Array.isArray(payload.paths) ? payload.paths.filter((p) => typeof p === 'string').slice(0, 500) : [];
    if (!paths.length) {
      return json(res, 400, { error: 'empty_paths', message: lang === 'en' ? 'No file paths given' : '未指定要删除的文件' });
    }
    const results = await Promise.all(paths.map(async (p) => {
      const resolved = resolveRel(cfg.outputDir, p);
      if (!resolved || mediaTypeOf(resolved.name) === 'other') return { path: p, ok: false, error: 'invalid_path' };
      try {
        const st = await fsp.stat(resolved.target);
        if (!st.isFile()) return { path: p, ok: false, error: 'not_a_file' };
      } catch {
        return { path: p, ok: false, error: 'not_found' };
      }
      try {
        await fsp.unlink(resolved.target);
        return { path: p, ok: true };
      } catch (err) {
        return { path: p, ok: false, error: err.code === 'EPERM' ? 'in_use' : 'delete_failed' };
      }
    }));
    if (results.some((r) => r.ok)) invalidate();
    json(res, 200, { ok: true, deleted: results.filter((r) => r.ok).length, results });
  }

  return { list, dirs, file, thumb, prompt, delete: batchDelete, invalidate };
}
