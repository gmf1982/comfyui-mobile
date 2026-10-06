/** 全局状态：当前工作流、视图清理钩子、持久化设置、PWA 安装事件。 */
import { apiJson, getToken } from './api.js';

const SETTINGS_KEY = 'cm_settings';

function loadSettings() {
  try {
    return { maxItems: 100, theme: 'dark', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { maxItems: 100, theme: 'dark' };
  }
}

/** 当前运行统计：跨 运行页/队列页 共享（提交时开始计时）。 */
export const runStats = { startedAt: null, lastValue: null, lastTime: null, rate: null, eta: null, vramUsed: null, vramTotal: null, winStart: null, winValue: null };

export function resetRunStats() {
  runStats.startedAt = Date.now();
  runStats.lastValue = null;
  runStats.lastTime = null;
  runStats.rate = null;
  runStats.eta = null;
  runStats.winStart = null;
  runStats.winValue = null;
}

/**
 * 记录一次进度采样，用滚动窗口估算速度（步/秒）与剩余时间。
 * ComfyUI 的 progress 事件间隔可能小于 0.2s 或成批到达，逐次差分不可靠。
 * @param {number} value 已完成步数
 * @param {number} max 总步数
 * @returns {{rate: number|null, eta: number|null}}
 */
export function noteProgress(value, max) {
  const now = Date.now();
  const s = runStats;
  if (s.winStart == null || value < (s.lastValue ?? 0)) {
    s.winStart = now;
    s.winValue = value;
  }
  s.lastValue = value;
  s.lastTime = now;
  const dms = now - s.winStart;
  const dv = value - (s.winValue ?? value);
  if (dms >= 1000 && dv > 0) {
    s.rate = dv / (dms / 1000);
    s.winStart = now;
    s.winValue = value;
  } else if (dms >= 4000 && dv === 0) {
    s.rate = 0;
  }
  s.eta = s.rate > 0 && max > value ? Math.round((max - value) / s.rate) : null;
  return { rate: s.rate, eta: s.eta };
}

const PENDING_KEY = 'cm_pending_run';

/** 标记“已提交任务”，用于生成完成后自动跳转图库（跨页面刷新有效）。 */
export function markPendingRun() {
  try { sessionStorage.setItem(PENDING_KEY, '1'); } catch { /* 存储不可用时仅本次会话内不跳转 */ }
}

export function isPendingRun() {
  try { return sessionStorage.getItem(PENDING_KEY) === '1'; } catch { return false; }
}

export function clearPendingRun() {
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* 忽略 */ }
}

const LAST_SUBMIT_KEY = 'cm_last_submit_id';

/**
 * 最近一次提交的 prompt_id（完成与否都保留，直到下次提交覆盖）。
 * 队列页靠它对账 /history：切页/刷新期间错过的 execution_success 推送无法恢复，
 * 只有提交时的 id 是可靠锚点。
 */
export function markLastSubmitted(promptId) {
  try { sessionStorage.setItem(LAST_SUBMIT_KEY, promptId); } catch { /* 存储不可用时仅本次会话内不对账 */ }
}

export function lastSubmittedId() {
  try { return sessionStorage.getItem(LAST_SUBMIT_KEY) || null; } catch { return null; }
}

export const state = {
  /** 当前打开的工作流：{name, path, json, format, warnings?, sourceFormat?} */
  workflow: null,
  /** 当前视图注册的清理函数，render 前调用 */
  cleanup: null,
  /** PWA beforeinstallprompt 事件 */
  installPrompt: null,
  settings: loadSettings(),
};

export function saveSettings() {
  persistSettings();
  pushPrefsSoon();
}

/** 只写本机 localStorage，不触发云端推送（推送成功回写 prefsUpdatedAt 时用，避免递归）。 */
function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    // 存储满只影响偏好持久化，不阻塞使用
  }
}

// ---------------- 偏好云端同步 ----------------
// localStorage 按 origin 隔离：Tailscale 地址与 cloudflared 地址是两个 origin，
// 收藏/设置互不相通（2026-09-28 用户实测）。把偏好存到 ComfyUI userdata
// （cm_sync/prefs.json），登录后拉取合并、变更后防抖推送，实现跨域名/跨设备共享。
// 推送失败不静默丢弃：脏标记落盘 + 退避重试（恢复联网/回前台/下次启动补推），
// 否则本机改动会在下次 pullPrefs 时被旧远端整体回滚（实测过的"排序过段时间又乱"）。

// ComfyUI 的 /userdata/{path} 是单段路由：路径里的 / 必须整段编码成 %2F，
// 字面斜杠一律 405（工作流读写早已如此，prefs 此前漏了导致云同步一直失败）。
const PREFS_PATH = `/userdata/${encodeURIComponent('cm_sync/prefs.json')}`;
const PREFS_DIRTY_KEY = 'cm_prefs_dirty';
let pushPrefsTimer = null;
let prefsRetryTimer = null;
let prefsRetryDelay = 5000;

function markPrefsDirty() {
  try { localStorage.setItem(PREFS_DIRTY_KEY, '1'); } catch { /* 存储不可用时仅本次会话重试 */ }
}

function markPrefsClean() {
  try { localStorage.removeItem(PREFS_DIRTY_KEY); } catch { /* 忽略 */ }
}

export function isPrefsDirty() {
  try { return localStorage.getItem(PREFS_DIRTY_KEY) === '1'; } catch { return false; }
}

function collectPrefs() {
  return {
    v: 1,
    updatedAt: Date.now(),
    favorites: favorites(),
    settings: state.settings,
    openWorkflows: openWorkflows(),
  };
}

/** 推送本地偏好到 userdata（防抖；未登录时静默跳过）。 */
function pushPrefsSoon() {
  if (!getToken()) return;
  // 排队即落脏：防抖窗口内崩溃/关闭，下次启动也能补推
  markPrefsDirty();
  clearTimeout(pushPrefsTimer);
  pushPrefsTimer = setTimeout(() => pushPrefsNow(), 1500);
}

async function pushPrefsNow() {
  if (!getToken()) return;
  clearTimeout(prefsRetryTimer);
  prefsRetryTimer = null;
  try {
    const prefs = collectPrefs();
    await apiJson(`${PREFS_PATH}?overwrite=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    });
    state.settings.prefsUpdatedAt = prefs.updatedAt;
    persistSettings(); // prefsUpdatedAt 必须落盘：只存内存时重启后被旧远端判"更新"回滚
    markPrefsClean();
    prefsRetryDelay = 5000;
  } catch {
    // 离线/服务不可达：退避重试，指数递增封顶 60s
    markPrefsDirty();
    prefsRetryDelay = Math.min(prefsRetryDelay * 2, 60000);
    prefsRetryTimer = setTimeout(() => pushPrefsNow(), prefsRetryDelay);
  }
}

// 恢复联网或回到前台时，把没推成功的偏好补推上去
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { if (isPrefsDirty()) pushPrefsSoon(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isPrefsDirty()) pushPrefsSoon();
  });
}

/**
 * 拉取云端偏好并合并（登录后调用）。
 * 服务端 updatedAt 更新 → 采用服务端的收藏/设置/多开列表（返回 true，调用方需重渲染）；
 * 否则保留本地并顺带把本地推上去。读不到（首次/离线）返回 false。
 */
export async function pullPrefs() {
  if (!getToken()) return false;
  let remote = null;
  try {
    remote = await apiJson(PREFS_PATH);
  } catch {
    pushPrefsSoon();
    return false;
  }
  if (!remote || typeof remote !== 'object') return false;
  if ((remote.updatedAt ?? 0) <= (state.settings.prefsUpdatedAt ?? 0)) {
    if (isPrefsDirty()) pushPrefsSoon();
    return false;
  }
  try {
    if (Array.isArray(remote.favorites)) localStorage.setItem(FAV_KEY, JSON.stringify(remote.favorites));
    if (Array.isArray(remote.openWorkflows)) localStorage.setItem(OPEN_WFS_KEY, JSON.stringify(remote.openWorkflows));
    if (remote.settings && typeof remote.settings === 'object') {
      state.settings = { ...loadSettings(), ...remote.settings };
      saveSettings();
    }
  } catch {
    return false;
  }
  return true;
}

const LAST_WF_KEY = 'cm_last_workflow';

/** 记录/读取上次打开的工作流（仅路径，重新打开时从 ComfyUI 读文件）。 */
export function rememberWorkflow(w) {
  try {
    if (w?.path) localStorage.setItem(LAST_WF_KEY, JSON.stringify({ path: w.path, name: w.name }));
    else localStorage.removeItem(LAST_WF_KEY);
  } catch { /* 存储不可用只影响跨刷新恢复 */ }
}

export function rememberedWorkflow() {
  try {
    const raw = localStorage.getItem(LAST_WF_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setWorkflow(w) {
  state.workflow = w;
  rememberWorkflow(w);
}

// ---------------- 已打开工作流列表（多开 + 下拉切换） ----------------

const OPEN_WFS_KEY = 'cm_open_workflows';
const MAX_OPEN_WORKFLOWS = 10;

/**
 * 已打开工作流的路径列表（最近使用在前），跨刷新持久化。
 * 只存 {path, name}；切换时按 path 重新从 ComfyUI 读文件。
 */
export function openWorkflows() {
  try {
    const raw = localStorage.getItem(OPEN_WFS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.path === 'string') : [];
  } catch {
    return [];
  }
}

function saveOpenWorkflows(list) {
  try {
    localStorage.setItem(OPEN_WFS_KEY, JSON.stringify(list.slice(0, MAX_OPEN_WORKFLOWS)));
  } catch {
    // 存储满只影响多开列表持久化
  }
}

/** 记录一次打开：去重后移到最前（最近使用序）。无 path 的（模板/历史参数）不进列表。 */
export function addOpenWorkflow(w) {
  if (!w?.path) return;
  const list = openWorkflows().filter((e) => e.path !== w.path);
  list.unshift({ path: w.path, name: w.name ?? String(w.path).split('/').pop() });
  saveOpenWorkflows(list);
  pushPrefsSoon();
}

/** 从打开列表移除（下拉里的 ✕ 关闭）。 */
export function removeOpenWorkflow(path) {
  saveOpenWorkflows(openWorkflows().filter((e) => e.path !== path));
  pushPrefsSoon();
}

// ---------------- 每个工作流的表单参数缓存 ----------------
// 运行页表单值按工作流缓存（localStorage）：切换多开/切页签/刷新页面不丢，
// 仅在用户关闭工作流（✕）或应用 JSON 源码修改（JSON 成为新基准）时清除。
// 不进云端偏好同步：表单值可能含提示词等大体积/隐私内容，且只在本机有意义。

const WF_PARAMS_KEY = 'cm_wf_params';

let wfParamsMap = null;
let persistTimer = 0;

/** 缓存键：有 path 用 path；模板/历史参数打开的临时工作流（path 为空）退化为名字。 */
export function wfParamsKey(w) {
  if (w?.path) return w.path;
  if (w?.name) return `@${w.name}`;
  return null;
}

function loadWfParamsMap() {
  if (wfParamsMap) return wfParamsMap;
  try {
    const parsed = JSON.parse(localStorage.getItem(WF_PARAMS_KEY) ?? '{}');
    wfParamsMap = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    wfParamsMap = {};
  }
  return wfParamsMap;
}

function persistWfParamsSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    try {
      localStorage.setItem(WF_PARAMS_KEY, JSON.stringify(wfParamsMap ?? {}));
    } catch {
      // 存储满只影响参数恢复，不影响运行
    }
  }, 250);
}

/** 读取某工作流缓存的表单值（fieldKey → value），无缓存返回空对象。 */
export function loadWorkflowParams(w) {
  const k = wfParamsKey(w);
  if (!k) return {};
  const entry = loadWfParamsMap()[k];
  return entry && typeof entry === 'object' ? { ...entry } : {};
}

/** 缓存单个表单值（onChange 实时调用，防抖写 localStorage）。 */
export function saveWorkflowParam(w, key, value) {
  const k = wfParamsKey(w);
  if (!k) return;
  const map = loadWfParamsMap();
  const entry = map[k] ?? (map[k] = {});
  entry[key] = value;
  persistWfParamsSoon();
}

/** 清空某工作流的表单缓存（关闭工作流、应用 JSON 源码修改时调用）。 */
export function clearWorkflowParams(w) {
  const k = wfParamsKey(w);
  if (!k) return;
  const map = loadWfParamsMap();
  if (!(k in map)) return;
  delete map[k];
  persistWfParamsSoon();
}

/** 保存出真实 path 后迁移表单缓存（模板/另存为场景：旧 key 复制到新 key）。 */
export function migrateWorkflowParams(oldW, newW) {
  const from = wfParamsKey(oldW);
  const to = wfParamsKey(newW);
  if (!from || !to || from === to) return;
  const map = loadWfParamsMap();
  if (map[from]) {
    map[to] = { ...map[to], ...map[from] };
    delete map[from];
    persistWfParamsSoon();
  }
}

// ---------------- 每个工作流的行布局记忆（主/高级区排序） ----------------
// 旧版是全局单份 layoutUnits：所有工作流共用一份排序，工作流间互相污染、
// 换工作流就"顺序乱了"。改为按工作流分 key（与表单缓存同一套 key 规则），
// 存进 settings 随偏好云同步（行 key 只有角色/节点类名，无提示词内容）。

const MAX_LAYOUT_ENTRIES = 40;

/**
 * 读取某工作流的行布局记忆。
 * 没有专属记忆时回退旧版全局 layoutUnits：老用户已排好的顺序不丢，
 * 首次拖拽后才落成该工作流自己的记忆。
 */
export function loadLayoutUnits(w) {
  const k = wfParamsKey(w);
  const byWf = state.settings.layoutUnitsByWf;
  if (k && byWf && typeof byWf === 'object' && byWf[k]) {
    const u = byWf[k];
    if (Array.isArray(u.main) && Array.isArray(u.advanced)) {
      return { main: [...u.main], advanced: [...u.advanced] };
    }
  }
  const legacy = state.settings.layoutUnits;
  if (legacy && Array.isArray(legacy.main) && Array.isArray(legacy.advanced)) {
    return { main: [...legacy.main], advanced: [...legacy.advanced] };
  }
  return { main: [], advanced: [] };
}

/** 保存某工作流的行布局（拖拽松手调用），随偏好云同步；超过 40 个工作流按最久未用淘汰。 */
export function saveLayoutUnits(w, units) {
  const k = wfParamsKey(w);
  if (!k) return;
  const byWf = state.settings.layoutUnitsByWf;
  const map = byWf && typeof byWf === 'object' ? byWf : (state.settings.layoutUnitsByWf = {});
  delete map[k]; // 先删再插：常用工作流沉到对象尾部，超限时从头部淘汰最久未用的
  map[k] = {
    main: Array.isArray(units?.main) ? units.main.filter(Boolean) : [],
    advanced: Array.isArray(units?.advanced) ? units.advanced.filter(Boolean) : [],
  };
  const keys = Object.keys(map);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_LAYOUT_ENTRIES))) delete map[old];
  saveSettings();
}

// ---------------- 工作流收藏 ----------------

const FAV_KEY = 'cm_fav_workflows';

/** 收藏的工作流路径列表。 */
export function favorites() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function isFavorite(path) {
  return favorites().includes(path);
}

/** 切换收藏状态，返回切换后的结果。 */
export function toggleFavorite(path) {
  const list = favorites();
  const idx = list.indexOf(path);
  if (idx === -1) list.push(path);
  else list.splice(idx, 1);
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(list));
  } catch { /* 存储不可用时仅本次会话有效 */ }
  pushPrefsSoon();
  return idx === -1;
}
