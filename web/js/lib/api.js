/**
 * API 客户端：自动携带令牌、401 统一处理、可重连 WebSocket、单节点 schema 缓存。
 */
const TOKEN_KEY = 'cm_token';
const CLIENT_KEY = 'cm_client_id';
const OBJINFO_KEY = 'cm_objinfo';

export const bus = new EventTarget();

export class ApiError extends Error {
  constructor(status, message, data = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  // 媒体请求（<img>/<a download>）无法带 Bearer 头，用 Cookie 通道兜底
  document.cookie = `cm_token=${encodeURIComponent(token ?? '')}; Path=/; SameSite=Lax; Max-Age=${token ? 31536000 : 0}`;
}

export const CLIENT_ID = (() => {
  let v = localStorage.getItem(CLIENT_KEY);
  if (!v) {
    v = crypto.randomUUID();
    localStorage.setItem(CLIENT_KEY, v);
  }
  return v;
})();

/** 基础请求：失败抛 ApiError；401 触发 cm:unauthorized。 */
export async function api(path, opts = {}) {
  const headers = new Headers(opts.headers ?? {});
  if (getToken()) headers.set('Authorization', `Bearer ${getToken()}`);
  let res;
  try {
    res = await fetch(path, { ...opts, headers });
  } catch (err) {
    throw new ApiError(0, `网络错误：${err.message}`);
  }
  if (res.status === 401) {
    bus.dispatchEvent(new CustomEvent('cm:unauthorized'));
    throw new ApiError(401, '未登录或令牌失效');
  }
  if (res.status === 429) {
    // 封禁（鉴权失败过多）与写限流都返回 429，只有封禁需要客户端停轮询退避
    const hint = await res.clone().json().catch(() => null);
    if (hint?.error === 'banned') bus.dispatchEvent(new CustomEvent('cm:banned'));
  }
  return res;
}

/** 请求并解析 JSON；错误体中的 message 优先展示，完整错误体挂在 err.data。 */
export async function apiJson(path, opts = {}) {
  const res = await api(path, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON 响应体按原文处理
  }
  if (!res.ok) {
    const message = data?.message
      ?? (typeof data?.error === 'string' ? data.error : data?.error?.message)
      ?? (text ? text.slice(0, 200) : `${res.status} ${res.statusText}`);
    throw new ApiError(res.status, message, data);
  }
  return data;
}

export function wsUrl() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws?clientId=${encodeURIComponent(CLIENT_ID)}&token=${encodeURIComponent(getToken())}`;
}

/**
 * 可重连 WebSocket：指数退避（上限 30s），页面回到前台立即重连。
 * JSON 消息派发 bus 'cm:ws' 事件，二进制预览帧解码后派发 'cm:preview'。
 */
export function connectSocket() {
  let ws = null;
  let attempt = 0;
  let closedByUser = false;
  let timer = null;

  function open() {
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      schedule();
      return;
    }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      attempt = 0;
      bus.dispatchEvent(new CustomEvent('cm:ws-state', { detail: 'open' }));
    };
    ws.onclose = () => {
      bus.dispatchEvent(new CustomEvent('cm:ws-state', { detail: 'closed' }));
      if (!closedByUser) schedule();
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg = null;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        bus.dispatchEvent(new CustomEvent('cm:ws', { detail: msg }));
      } else if (ev.data instanceof ArrayBuffer) {
        const url = decodePreview(ev.data);
        if (url) bus.dispatchEvent(new CustomEvent('cm:preview', { detail: url }));
      }
    };
  }

  function schedule() {
    const delay = Math.min(30_000, 1000 * 2 ** attempt++);
    timer = setTimeout(open, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!ws || ws.readyState > WebSocket.OPEN) && !closedByUser) {
      clearTimeout(timer);
      open();
    }
  });

  open();

  return {
    send(obj) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    close() {
      closedByUser = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}

/** ComfyUI 二进制帧：前 8 字节 = 事件类型 u32LE + 图片类型 u32LE（1=JPEG 2=PNG）。 */
function decodePreview(buf) {
  if (buf.byteLength <= 8) return null;
  const dv = new DataView(buf);
  const eventType = dv.getUint32(0, true);
  if (eventType !== 1) return null;
  const imageType = dv.getUint32(4, true);
  const mime = imageType === 2 ? 'image/png' : 'image/jpeg';
  return URL.createObjectURL(new Blob([buf.slice(8)], { type: mime }));
}

// ---------------- object_info 按类缓存 ----------------

let objInfoCache = null;

function loadObjInfo() {
  if (objInfoCache) return objInfoCache;
  try {
    objInfoCache = JSON.parse(localStorage.getItem(OBJINFO_KEY) ?? '{}');
  } catch {
    objInfoCache = {};
  }
  return objInfoCache;
}

function persistObjInfo() {
  try {
    localStorage.setItem(OBJINFO_KEY, JSON.stringify(objInfoCache));
  } catch {
    // 超出配额只影响下次冷启动缓存
  }
}

/**
 * 取回一组节点类的 schema（缺类返回 null 值，不抛错）。
 * @param {string[]} classTypes 节点类名
 * @param {{force?: boolean}} options force 时忽略缓存重新拉取
 */
export async function ensureSchemas(classTypes, options = {}) {
  const cache = loadObjInfo();
  const missing = [...new Set(classTypes)].filter((c) => options.force || !(c in cache));
  await Promise.all(missing.map(async (c) => {
    try {
      const data = await apiJson(`/object_info/${encodeURIComponent(c)}`);
      cache[c] = data?.[c] ?? null;
    } catch {
      cache[c] = null;
    }
  }));
  if (missing.length) persistObjInfo();
  return cache;
}

/** 清空 schema 缓存（设置页“清除缓存”用）。 */
export function clearSchemas() {
  objInfoCache = {};
  persistObjInfo();
}

// ---------------- 媒体上传 ----------------

/** 上传媒体（带压缩与进度）。 */
/** 全量 object_info 内存缓存（约 5MB，仅在内存中保留）。 */
let fullObjInfo = null;

/** 上传事件总线（上传成功后广播，供选择器刷新列表）。 */
export const uploadEvents = new EventTarget();

/** 全量 object_info（约 5MB，节点搜索用），仅在内存缓存。 */
export async function ensureFullObjectInfo() {
  if (fullObjInfo) return fullObjInfo;
  fullObjInfo = await apiJson('/object_info');
  return fullObjInfo;
}

/**
 * 上传媒体到 ComfyUI input 目录（图片/音频/视频统一走 /upload/image）。
 * 图片默认先压缩（移动端相册常见 HEIC/大图，既慢又可能被服务端拒绝）；
 * 用 XHR 以便显示上传进度。
 * @param {File} file
 * @param {{compress?: boolean, maxDim?: number, onProgress?: (sent: number, total: number) => void}} options
 * @returns {Promise<{name: string, subfolder: string, type: string, compressed: boolean, originalSize: number, size: number}>}
 */
export async function uploadMedia(file, options = {}) {
  const attemptUpload = async (compressOpts) => {
    let payload = file;
    let name = file.name;
    let compressed = false;
    let info = null;
    if (compressOpts && (file.type || '').startsWith('image/')) {
      const { compressImage } = await import('./media.js');
      const result = await compressImage(file, compressOpts);
      payload = result.blob;
      name = result.name;
      compressed = result.compressed;
      info = result;
    }
    const body = new FormData();
    body.append('image', payload, name);
    const token = getToken();
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/upload/image');
      if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) options.onProgress?.(ev.loaded, ev.total);
      };
      xhr.onload = () => {
        const text = xhr.responseText ?? '';
        // 隧道/网关异常时返回的是 HTML 错误页而非 JSON
        if (text.trimStart().startsWith('<')) {
          reject(new ApiError(xhr.status, '网络中断（服务器返回错误页，通常是图片过大或网速过慢）'));
          return;
        }
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
        if (xhr.status >= 200 && xhr.status < 300 && parsed) resolve(parsed);
        else reject(new ApiError(xhr.status, parsed?.message ?? parsed?.error ?? ('HTTP ' + xhr.status)));
      };
      xhr.onerror = () => reject(new ApiError(0, '网络错误（上传中断，可能是网速过慢）'));
      xhr.send(body);
    });
    invalidateSchemaCache();
    uploadEvents.dispatchEvent(new CustomEvent('upload', { detail: { name } }));
    return { ...data, name: data.name ?? name, compressed, originalSize: file.size, size: info?.size ?? file.size };
  };

  const compressOpts = options.compress === false ? null : {
    maxDim: options.maxDim,
    targetMB: options.targetMB,
  };
  try {
    return await attemptUpload(compressOpts);
  } catch (err) {
    // 首次失败：加强压缩后自动重试一次（弱网/大图场景）
    if (!compressOpts || err.status === 401 || err.status === 413) throw err;
    options.onProgress?.(0, 0);
    const retryOpts = { maxDim: Math.min(compressOpts.maxDim ?? 2048, 1280), targetMB: Math.min(compressOpts.targetMB ?? 0.9, 0.45) };
    return attemptUpload(retryOpts);
  }
}

/** 清空按类缓存（上传/删除文件后调用，使下拉里的文件列表立即更新）。 */
export function invalidateSchemaCache() {
  objInfoCache = {};
  try { localStorage.removeItem(OBJINFO_KEY); } catch { /* 忽略存储异常 */ }
}

/**
 * 无条件拉取某节点的最新 schema（用于媒体选择器刷新文件列表）。
 * @param {string} classType
 */
export async function fetchFreshSchema(classType) {
  const data = await apiJson(`/object_info/${encodeURIComponent(classType)}`);
  const schema = data?.[classType] ?? null;
  if (schema) {
    const cache = loadObjInfo();
    cache[classType] = schema;
    persistObjInfo();
  }
  return schema;
}
