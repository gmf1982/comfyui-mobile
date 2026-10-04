/* ComfyUI Mobile App Shell Service Worker
 * HTML/JS/CSS：network-first（改动立即生效，离线退回缓存壳）。
 * icons/manifest：cache-first。API 与 /view：一律 network-only。
 * v21：模型/长下拉加搜索与刷新；采样器选项改用 object_info 真实列表；保存保留桌面 pos/size。
 * v22：下拉选择改「值按钮 + 底部抽屉」：搜索框在抽屉顶部、输入即过滤（用户反馈表单内搜索框不直观）。
 * v23：底部抽屉加顶部下拉手柄（点按/下拖关闭，sticky 常驻）。
 * v24：设置页服务器卡新增 ComfyUI 远程启动（/gw/comfyui/status + /start，网关配置 comfyuiLaunch 后出现）。
 * v25：按钮常驻——运行中显示「重启 ComfyUI」（/gw/comfyui/restart，杀 upstream 端口进程树后重新拉起），启动/重启均需二次确认。
 */
const CACHE = 'cm-shell-v25';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/lib/api.js',
  '/js/lib/i18n.js',
  '/js/lib/media.js',
  '/js/lib/state.js',
  '/js/lib/ui.js',
  '/js/lib/text-history.js',
  '/js/lib/workflow-form.js',
  '/js/lib/graph.js',
  '/js/views/login.js',
  '/js/views/workflows.js',
  '/js/views/run.js',
  '/js/views/queue.js',
  '/js/views/gallery.js',
  '/js/views/more.js',
  '/js/views/node-editor.js',
  '/js/views/settings.js',
  '/js/views/templates.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 媒体与 API：直接走网络，绝不缓存
  if (!url.pathname.startsWith('/icons/') && url.pathname !== '/manifest.webmanifest') {
    return;
  }

  const cacheFirst = url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest';
  if (cacheFirst) {
    event.respondWith(
      caches.match(req).then((hit) => hit ?? fetch(req)),
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit ?? Response.error())),
  );
});
