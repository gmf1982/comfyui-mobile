/**
 * 增强模型实时探测：兼容 OpenAI 的 /v1/models 与 Ollama 的 /api/tags。
 * 只探测 server/config.json 里已配置的端点；API Key 不会离开服务端。
 * 结果缓存 30 秒，手机端点「刷新模型」可强制重探。
 */
const CACHE_TTL_MS = 30_000;

/** baseUrl → { at, models }。key 不落盘，只在进程内。 */
const cache = new Map();

/** 同时尝试 OpenAI 兼容与 Ollama 原生路径；baseUrl 带不带 /v1 都覆盖。 */
export function discoveryUrls(baseUrl) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const urls = new Set([`${base}/models`]);
  if (!/\/v1$/i.test(base)) urls.add(`${base}/v1/models`);
  urls.add(`${base.replace(/\/v1$/i, '')}/api/tags`);
  return [...urls];
}

/** 解析 OpenAI / Ollama 两种响应；其他形状返回空数组。 */
export function parseModelList(data) {
  if (Array.isArray(data?.data)) return data.data.map((m) => m?.id).filter(Boolean);
  if (Array.isArray(data?.models)) return data.models.map((m) => m?.name ?? m?.model).filter(Boolean);
  if (Array.isArray(data)) return data.map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter(Boolean);
  return [];
}

async function fetchModelList(url, entry, timeoutMs) {
  const headers = { Accept: 'application/json' };
  if (entry.apiKey) headers.Authorization = `Bearer ${entry.apiKey}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return parseModelList(data);
}

/**
 * 探测一个端点的可用模型。
 * @param {{baseUrl: string, apiKey?: string}} entry 配置里的端点
 * @param {{timeoutMs?: number, fresh?: boolean}} [options]
 * @returns {Promise<string[]>} 去重排序后的模型 ID；失败返回空数组
 */
export async function discoverModels(entry, { timeoutMs = 2500, fresh = false } = {}) {
  const key = `${entry.baseUrl}\n${entry.apiKey ?? ''}`;
  const now = Date.now();
  if (!fresh) {
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.models;
  }
  const results = await Promise.allSettled(
    discoveryUrls(entry.baseUrl).map((url) => fetchModelList(url, entry, timeoutMs)),
  );
  const models = [...new Set(results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])))]
    .filter((id) => typeof id === 'string' && id.trim())
    .sort((a, b) => a.localeCompare(b));
  cache.set(key, { at: now, models });
  return models;
}

/** 测试/配置热更新用：清空探测缓存。 */
export function clearModelDiscoveryCache() {
  cache.clear();
}
