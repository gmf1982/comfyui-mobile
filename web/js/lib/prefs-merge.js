/**
 * 偏好云同步的收藏合并算法（纯函数，无 DOM，可被 node --test 直接导入）。
 *
 * 背景（2026-10-20 用户收藏的工作流被抹掉事故）：prefs.json 是整包 last-writer-wins，
 * 一台 origin 的 localStorage 收藏列表为空时（新域名、或测试会话），一次防抖推送
 * 就会把另一台设备攒了很久的云端收藏整体覆盖。这里改为逐条合并（GCounter + 墓碑）：
 * favTimes 每项为 [最近点亮时间, 最近取消时间]（0=未知）；点亮晚于取消才保留。
 * 旧数据只有列表没有时间：缺失的点亮时间回退为「云端 updatedAt - 回看窗」，
 * 保证另一侧「刚取消」的墓碑仍能胜出，而列表里其它设备的收藏不会误丢。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const KNOWN_ADD_LOOKBACK_MS = 180 * DAY_MS;
export const TOMBSTONE_RETENTION_MS = 180 * DAY_MS;

/**
 * 归一一侧的（列表 + 时间图）为 path → [add, remove]。
 * 兼容历史符号写法：正数=点亮时间，负数=取消时间。
 */
function normalizeTimes(raw, favoritesList, knownAdd) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const p of new Set([...favoritesList, ...Object.keys(src)])) {
    let add = 0;
    let rm = 0;
    const v = src[p];
    if (Array.isArray(v)) {
      add = Number(v[0]) > 0 ? Number(v[0]) : 0;
      rm = Number(v[1]) > 0 ? Number(v[1]) : 0;
    } else {
      const t = Number(v);
      if (Number.isFinite(t) && t > 0) add = t;
      else if (Number.isFinite(t) && t < 0) rm = -t;
    }
    if (!add && favoritesList.includes(p)) add = knownAdd;
    if (add || rm) out[p] = [add, rm];
  }
  return out;
}

/**
 * @param {{favorites?: string[], favTimes?: object, updatedAt?: number, prefsUpdatedAt?: number}} local
 * @param {{favorites?: string[], favTimes?: object, updatedAt?: number}} remote
 * @returns {{favorites: string[], favTimes: Record<string, [number, number]>}}
 */
export function mergePrefsFavorites(local, remote) {
  const lFavs = Array.isArray(local?.favorites) ? local.favorites.filter((p) => typeof p === 'string') : [];
  const rFavs = Array.isArray(remote?.favorites) ? remote.favorites.filter((p) => typeof p === 'string') : [];
  const now = Date.now();
  const lKnown = (Number(local?.updatedAt) || Number(local?.prefsUpdatedAt) || now) - KNOWN_ADD_LOOKBACK_MS;
  const rKnown = (Number(remote?.updatedAt) || now) - KNOWN_ADD_LOOKBACK_MS;
  const lTimes = normalizeTimes(local?.favTimes, lFavs, lKnown);
  const rTimes = normalizeTimes(remote?.favTimes, rFavs, rKnown);
  const times = {};
  for (const p of new Set([...Object.keys(lTimes), ...Object.keys(rTimes)])) {
    const l = lTimes[p] ?? [0, 0];
    const r = rTimes[p] ?? [0, 0];
    times[p] = [Math.max(l[0], r[0]), Math.max(l[1], r[1])];
  }
  const cutoff = now - TOMBSTONE_RETENTION_MS;
  const favorites = [];
  const kept = {};
  for (const [p, [add, rm]] of Object.entries(times)) {
    if (rm && rm <= cutoff) continue;
    if (add > rm) favorites.push(p);
    if (add || rm) kept[p] = [add, rm];
  }
  return { favorites, favTimes: kept };
}

/**
 * 合并结果里是否含有远端缺的条目（本机独有收藏、其它设备还没见过的墓碑）。
 * pullPrefs 据此决定是否补推：云端已包含合并结果时再推一次只是放大云写频率
 * （ComfyUI userdata 原子保存被占用即 WinError 5 失败，高频写会互相抢锁）。
 * 只比条目不比时间戳：时间图的细微更新不值得为它多发一次整包推送。
 */
export function mergeHasRemoteMissing(merged, remote) {
  const rFavs = new Set(Array.isArray(remote?.favorites)
    ? remote.favorites.filter((p) => typeof p === 'string') : []);
  const rTimes = remote?.favTimes && typeof remote.favTimes === 'object' && !Array.isArray(remote.favTimes)
    ? remote.favTimes : {};
  for (const p of merged?.favorites ?? []) {
    if (!rFavs.has(p)) return true;
  }
  for (const p of Object.keys(merged?.favTimes ?? {})) {
    if (!(p in rTimes)) return true;
  }
  return false;
}
