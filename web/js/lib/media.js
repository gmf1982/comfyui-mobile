/** 媒体 URL 构造、分类、保存与分享（浏览器端）。 */

const EXT_TYPES = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', avif: 'image', bmp: 'image',
  mp4: 'video', webm: 'video', mkv: 'video', mov: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', oga: 'audio', m4a: 'audio', aac: 'audio', opus: 'audio',
};

export function extType(filename) {
  const dot = String(filename).lastIndexOf('.');
  const ext = dot === -1 ? '' : String(filename).slice(dot + 1).toLowerCase();
  return EXT_TYPES[ext] ?? 'other';
}

/** `/view` 媒体直链（鉴权经 Cookie 通道自动携带）。version=运行序号，防文件名复用命中旧缓存。 */
export function viewUrl(item) {
  const q = new URLSearchParams({
    filename: item.filename ?? '',
    subfolder: item.subfolder ?? '',
    type: item.type ?? 'output',
  });
  if (item.version != null) q.set('v', String(item.version));
  return `/view?${q}`;
}

/** 触发浏览器下载（同源 + download 属性，iOS 13+/Android 均支持）。 */
export function downloadMedia(item) {
  const a = document.createElement('a');
  a.href = viewUrl(item);
  a.download = item.filename ?? 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Web Share API 分享；不支持时回退为下载。 */
export async function shareMedia(item) {
  try {
    const res = await fetch(viewUrl(item));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], item.filename ?? 'media', { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return true;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return true;
  }
  downloadMedia(item);
  return false;
}

/** 工作流文件下载（userdata 文本）。 */
export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 移动端相机/相册常见格式，需要转码才能被 ComfyUI 接受。 */
const PASSTHROUGH_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

async function encodeJpeg(bitmap, maxDim, quality) {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  return { blob, width: w, height: h };
}

/**
 * 上传前压缩图片：按最长边缩放并转码为 JPEG，迭代逼近目标体积。
 * 触发条件：文件超过阈值、或格式非 JPEG/PNG/WebP（如 iPhone 的 HEIC）。
 * 隧道/弱网下大图极易超时（Cloudflare 会返回错误页），因此默认压到 targetMB 以内。
 * @param {File} file 原始文件
 * @param {{maxDim?: number, quality?: number, targetMB?: number, thresholdMB?: number}} options
 * @returns {Promise<{blob: Blob, name: string, originalSize: number, size: number, compressed: boolean, width?: number, height?: number, steps: number}>}
 */
export async function compressImage(file, options = {}) {
  const maxDim = options.maxDim ?? 2048;
  const quality = options.quality ?? 0.85;
  const targetBytes = (options.targetMB ?? 0.9) * 1024 * 1024;
  const threshold = (options.thresholdMB ?? 0.9) * 1024 * 1024;
  const passthrough = { blob: file, name: file.name, originalSize: file.size, size: file.size, compressed: false, steps: 0 };
  const needsTypeConvert = !PASSTHROUGH_TYPES.has(file.type || '');
  if (!needsTypeConvert && file.size <= threshold) return passthrough;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // 无法解码（如浏览器不支持该格式）：交给服务端判断，保持原样
    return passthrough;
  }
  // 逐级降质量/降尺寸，直到进入目标体积（最多 4 次尝试）
  const attempts = [
    { dim: maxDim, q: quality },
    { dim: maxDim, q: 0.72 },
    { dim: Math.min(maxDim, 1536), q: 0.7 },
    { dim: Math.min(maxDim, 1024), q: 0.68 },
  ];
  let best = null;
  let steps = 0;
  for (const attempt of attempts) {
    steps++;
    const { blob, width, height } = await encodeJpeg(bitmap, attempt.dim, attempt.q);
    if (!blob) continue;
    best = { blob, width, height };
    if (blob.size <= targetBytes) break;
  }
  bitmap.close?.();
  if (!best?.blob) return passthrough;
  // 压缩后反而更大（原图已是高压缩比）且格式本就兼容，则保留原图
  if (best.blob.size >= file.size && !needsTypeConvert) return { ...passthrough, steps };
  return {
    blob: best.blob,
    name: file.name.replace(/\.[^.]+$/, '') + '.jpg',
    originalSize: file.size,
    size: best.blob.size,
    compressed: true,
    width: best.width,
    height: best.height,
    steps,
  };
}

/** 人类可读体积。 */
export function humanSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * 图库/选择器用的轻量缩略图地址。
 * 网关对 preview=webp 请求本地缩放到 w 参数指定尺寸（缺省 512px）并落盘缓存；
 * 网关未配置目录等场景回退为 ComfyUI 的全分辨率 WebP 转码（体积降 5-10 倍，仍远好于原图）。
 * @param {{filename: string, subfolder?: string, type?: string, version?: number}} item
 * @param {number} quality WebP 质量（30-95）
 * @param {number} maxDim 缩略图最长边
 */
export function thumbUrl(item, quality = 70, maxDim = 512) {
  const q = new URLSearchParams({
    filename: item.filename ?? '',
    subfolder: item.subfolder ?? '',
    type: item.type ?? 'output',
    preview: 'webp;' + quality,
    w: String(maxDim),
  });
  if (item.version != null) q.set('v', String(item.version));
  return '/view?' + q;
}

/** input 目录下的媒体缩略图地址（供选择器预览）。version=mtime，防同名文件被替换后命中旧缓存。 */
export function inputMediaUrl(filename, subfolder = '', quality = null, maxDim = null, version = null) {
  const q = new URLSearchParams({ filename: filename ?? '', subfolder, type: 'input' });
  if (quality) {
    q.set('preview', 'webp;' + quality);
    q.set('w', String(maxDim ?? 512));
  }
  if (version != null) q.set('v', String(version));
  return '/view?' + q;
}
