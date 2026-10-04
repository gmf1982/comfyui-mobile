/**
 * 媒体与静态资源的类型判定、Content-Disposition 构造、路径安全校验。
 */

/** ComfyUI 输出媒体按扩展名归类；图库与播放器据此选择渲染方式。 */
const MEDIA_EXT_TYPES = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', avif: 'image', bmp: 'image',
  mp4: 'video', webm: 'video', mkv: 'video', mov: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', oga: 'audio', m4a: 'audio', aac: 'audio', opus: 'audio',
};

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', m4v: 'video/x-m4v',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus',
};

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

export function extOf(name) {
  const dot = String(name).lastIndexOf('.');
  return dot === -1 ? '' : String(name).slice(dot + 1).toLowerCase();
}

/** @returns {'image'|'video'|'audio'|'other'} */
export function mediaTypeOf(filename) {
  return MEDIA_EXT_TYPES[extOf(filename)] ?? 'other';
}

export function mimeOfFilename(filename) {
  return MIME_BY_EXT[extOf(filename)] ?? '';
}

export function mimeOfStatic(filename) {
  return STATIC_MIME['.' + extOf(filename)] ?? 'application/octet-stream';
}

/**
 * 构造 RFC 6266/5987 Content-Disposition（中文等非 ASCII 文件名用 filename* 编码）。
 * @param {string} filename 原始文件名
 * @param {boolean} attachment true=提示下载；false=内联展示
 */
export function contentDisposition(filename, attachment = false) {
  const type = attachment ? 'attachment' : 'inline';
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename)
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * 校验 `/view` 的 filename 等用户可控媒体路径（纵深防御，ComfyUI 之外的第二层）。
 * URL 已解码后调用：拒绝空名、控制字符、反斜杠、`..`、盘符与绝对路径。
 * @returns {boolean} 合法返回 true
 */
export function isSafeMediaName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  if (name.includes('\\') || name.includes('..')) return false;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  return true;
}
