/** 应用入口：路由、底部导航、顶栏状态、WS 接入、token 配对。 */
import { getToken, setToken, connectSocket, bus, apiJson } from './lib/api.js';
import { el, clear, toast } from './lib/ui.js';
import { state, isPendingRun, clearPendingRun, rememberedWorkflow, pullPrefs } from './lib/state.js';
import { t, tf, getLang } from './lib/i18n.js';
import { loginView } from './views/login.js';
import { workflowsView } from './views/workflows.js';
import { runView } from './views/run.js';
import { queueView } from './views/queue.js';
import { galleryView } from './views/gallery.js';
import { moreView } from './views/more.js';
import { nodeEditorView } from './views/node-editor.js';
import { settingsView } from './views/settings.js';
import { templatesView } from './views/templates.js';

const view = document.getElementById('view');
const bottomnav = document.getElementById('bottomnav');
const topbar = document.getElementById('topbar');

const routes = {
  login: loginView,
  workflows: workflowsView,
  run: runView,
  gallery: galleryView,
  queue: queueView,
  more: moreView,
  editor: nodeEditorView,
  templates: templatesView,
  settings: settingsView,
};

function currentRoute() {
  const name = (location.hash.replace(/^#\/?/, '') || 'workflows').split(/[?#]/)[0];
  return name in routes ? name : 'workflows';
}

async function render() {
  const name = currentRoute();
  if (!getToken() && name !== 'login') {
    location.hash = '/login';
    return;
  }
  if (state.cleanup) {
    state.cleanup();
    state.cleanup = null;
  }
  view.className = 'view';
  clear(view);
  bottomnav.classList.toggle('hidden', name === 'login');
  topbar.classList.toggle('hidden', name === 'login');
  for (const btn of bottomnav.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.nav === name);
  }
  try {
    await routes[name](view);
  } catch (err) {
    clear(view).append(el('div', { class: 'card error-card' },
      el('h3', { text: t('页面加载失败') }),
      el('p', { class: 'muted', text: String(err?.message ?? err) }),
    ));
  }
}

window.addEventListener('hashchange', render);
bus.addEventListener('cm:unauthorized', () => {
  if (unsubscribed) return;
  unsubscribed = true;
  setToken('');
  stopBackgroundPolling();
  toast(t('登录已失效（令牌可能已更换），请重新打开电脑端提供的链接'), 6000);
  location.hash = '/login';
  render();
});

// 被封禁（鉴权失败过多）：停掉后台轮询，避免封禁期内持续刷请求
bus.addEventListener('cm:banned', () => {
  if (!backgroundPolling) return;
  stopBackgroundPolling();
  toast(t('已被限流（鉴权失败次数过多），暂停自动刷新；重新打开页面可恢复'), 6000);
});

// 登录成功后恢复轮询
bus.addEventListener('cm:login', async () => {
  unsubscribed = false;
  resumeBackgroundPolling();
  if (await pullPrefs().catch(() => false)) { applyTheme(); render(); }
});

// 底部导航
bottomnav.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-nav]');
  if (btn) location.hash = `/${btn.dataset.nav}`;
});

// 顶栏：中断按钮 + 连接状态 + 队列数
document.getElementById('btn-interrupt').addEventListener('click', async () => {
  try {
    await apiJson('/interrupt', { method: 'POST' });
    toast(t('已发送中断请求'));
  } catch (err) {
    toast(t('中断失败：') + err.message);
  }
});

let queueRemaining = null;
let gpuLabel = '';

function updateTopbarInfo() {
  const parts = [];
  if (queueRemaining != null && queueRemaining > 0) parts.push(tf('队列 {n}', { n: queueRemaining }));
  if (gpuLabel) parts.push(gpuLabel);
  document.getElementById('topbar-info').textContent = parts.join(' · ');
}

bus.addEventListener('cm:ws-state', (ev) => {
  document.getElementById('conn-dot').className = `dot ${ev.detail === 'open' ? 'on' : 'off'}`;
});

bus.addEventListener('cm:ws', (ev) => {
  const msg = ev.detail;
  if (msg?.type === 'status' && msg.data?.status) {
    queueRemaining = msg.data.status.exec_info?.queue_remaining ?? 0;
    updateTopbarInfo();
  }
});

/** 后台轮询开关：未授权时关闭，避免持续触发鉴权失败而被封禁。 */
let backgroundPolling = true;
let unsubscribed = false;

function stopBackgroundPolling() {
  backgroundPolling = false;
  if (pendingWatchTimer) {
    clearInterval(pendingWatchTimer);
    pendingWatchTimer = null;
  }
}

function resumeBackgroundPolling() {
  backgroundPolling = true;
  pollSystemStats();
  watchPendingRun();
}

async function pollSystemStats() {
  if (!backgroundPolling) return;
  try {
    const stats = await apiJson('/system_stats');
    const device = stats?.devices?.[0];
    gpuLabel = device?.name ? device.name.replace(/\(.*\)/, '').trim().slice(0, 24) : '';
    updateTopbarInfo();
  } catch {
    // 无 GPU 信息不影响使用
  }
}

// ---------------- 启动 ----------------

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme ?? 'dark';
}

function acceptPairingToken() {
  const q = new URLSearchParams(location.search);
  const token = q.get('token');
  if (token) {
    setToken(token);
    // 从地址栏清除 token，避免进入历史记录/分享泄露
    history.replaceState(null, '', location.pathname);
    toast(t('配对成功 ✓'));
  }
}

window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  state.installPrompt = ev;
});

// 长按媒体上的浏览器菜单会盖掉应用自己的长按预览（且菜单里“下载图片”
// 存下来的是 webp;q70 缩略图——把它再当输入图上传正是生成出黑斑的原因）。
// Android 走 contextmenu 事件拦截；iOS 的长按呼出用 CSS touch-callout 关闭。
document.addEventListener('contextmenu', (ev) => {
  if (ev.target instanceof Element && ev.target.closest('.media-cell, .tile, .overlay, .quick-preview, .preview-img')) {
    ev.preventDefault();
  }
});

// 生成完成 → 自动跳转图库：轮询队列（不依赖 WebSocket 是否可用）
let pendingWatchTimer = null;
function watchPendingRun() {
  if (pendingWatchTimer) return;
  pendingWatchTimer = setInterval(async () => {
    if (!backgroundPolling || !isPendingRun()) return;
    try {
      const q = await apiJson('/queue');
      const remaining = (q?.queue_running ?? []).length + (q?.queue_pending ?? []).length;
      if (remaining > 0) return;
      clearPendingRun();
      // 常驻轮询：空闲时仅一次 flag 判断（不发请求），成功后不自杀
      // 不再自动跳转图库：队列页会就地展示结果（避免每次重载全部历史与图片）
      toast(t('生成完成'));
    } catch {
      // 网络抖动：下一轮继续
    }
  }, 2500);
}
watchPendingRun();

// 云端偏好同步：收藏/设置/多开列表跨域名（Tailscale 与 cloudflared 是不同 origin）共享
(async () => {
  if (!getToken()) return;
  if (await pullPrefs().catch(() => false)) { applyTheme(); render(); }
})();

// 跨刷新恢复上次打开的工作流（静默，不跳转页面）
(async () => {
  if (state.workflow) return;
  const last = rememberedWorkflow();
  if (!last?.path) return;
  const hashAtStart = location.hash;
  try {
    const { loadWorkflowFromPath } = await import('./views/workflows.js');
    const ok = await loadWorkflowFromPath(last.path, { navigate: false, silent: true });
    // 恢复完成时用户仍停留在恢复前的页面 → 重渲染（否则 /run 一直显示「尚未打开」、
    // /editor 显示「请先打开工作流」）
    if (ok && location.hash === hashAtStart) render();
  } catch {
    // 工作流已被删除/重命名：忽略，用户重新选择即可
  }
})();

// 静态 DOM 里的文案（底部导航标签）按当前语言替换
for (const node of document.querySelectorAll('[data-i18n]')) {
  node.textContent = t(node.dataset.i18n);
}
if (getLang() === 'en') document.documentElement.lang = 'en';

applyTheme();
acceptPairingToken();
connectSocket();
setInterval(() => { if (backgroundPolling) pollSystemStats(); }, 30_000);
pollSystemStats();
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
