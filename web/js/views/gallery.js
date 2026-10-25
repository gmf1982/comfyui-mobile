/**
 * 图库视图：直读网关 output 目录（与 ComfyUI 运行状态解耦，重启不再清空）。
 * 分页懒加载（IntersectionObserver）、服务端排序/过滤、多选批量删除与下载、详情浮层。
 */
import { apiJson } from '../lib/api.js';
import { el, clear, toast, confirmDialog } from '../lib/ui.js';
import { outputFileUrl, outputThumbUrl, humanSize } from '../lib/media.js';
import { openMediaOverlay } from '../lib/media-actions.js';
import { t, tf } from '../lib/i18n.js';

const PAGE_SIZE = 60;
const PREFS_KEY = 'cm_gallery_prefs';

const TYPE_FILTERS = [
  { key: 'all', label: t('全部') },
  { key: 'image', label: t('图片') },
  { key: 'video', label: t('视频') },
  { key: 'audio', label: t('音频') },
];
const SORTS = [
  { key: 'mtime', label: t('日期') },
  { key: 'name', label: t('名称') },
  { key: 'size', label: t('大小') },
];

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {};
    return {
      sort: SORTS.some((s) => s.key === p.sort) ? p.sort : 'mtime',
      order: p.order === 'asc' ? 'asc' : 'desc',
      filter: TYPE_FILTERS.some((f) => f.key === p.filter) ? p.filter : 'all',
      dir: typeof p.dir === 'string' ? p.dir : '',
    };
  } catch {
    return { sort: 'mtime', order: 'desc', filter: 'all', dir: '' };
  }
}

export async function galleryView(container) {
  const prefs = loadPrefs();
  let sort = prefs.sort;
  let order = prefs.order;
  let filter = prefs.filter;
  let dir = prefs.dir;

  let items = [];      // 已加载条目（当前过滤/排序下，与网格渲染顺序一致）
  let total = 0;
  let loaded = false;
  let loading = false;
  let gen = 0;         // 重载代数：丢弃过期分页响应
  let selectMode = false;
  const selected = new Set();
  /** 浮层翻页要求 item 引用稳定：按 path 缓存适配后的媒体条目 */
  const overlayItems = new Map();

  // ---------- 工具栏 ----------
  const chips = el('div', { class: 'chips' });
  const sortChips = el('div', { class: 'chips' });
  const orderBtn = el('button', {
    class: 'btn small', title: t('切换升序/降序'), 'aria-label': t('切换升序/降序'),
    text: order === 'desc' ? '↓' : '↑',
    onclick: () => { order = order === 'desc' ? 'asc' : 'desc'; orderBtn.textContent = order === 'desc' ? '↓' : '↑'; savePrefs(); reload(); },
  });
  const selectBtn = el('button', { class: 'btn small', text: t('多选'), onclick: () => setSelectMode(!selectMode) });
  const count = el('span', { class: 'muted' });
  const folderSelect = el('select', {
    class: 'folder-select', title: t('文件夹'), 'aria-label': t('文件夹'),
    onchange: () => { dir = folderSelect.value; savePrefs(); reload(); },
  });

  for (const f of TYPE_FILTERS) {
    chips.append(el('button', {
      class: 'chip' + (f.key === filter ? ' active' : ''),
      'data-filter': f.key,
      text: f.label,
      onclick: () => {
        filter = f.key;
        for (const c of chips.children) c.classList.toggle('active', c.dataset.filter === filter);
        savePrefs();
        reload();
      },
    }));
  }
  for (const s of SORTS) {
    sortChips.append(el('button', {
      class: 'chip' + (s.key === sort ? ' active' : ''),
      'data-sort': s.key,
      text: s.label,
      onclick: () => {
        // 点已选中的排序键 = 翻转升降序；点新键 = 切换排序字段（保持当前方向）
        if (sort === s.key) {
          order = order === 'desc' ? 'asc' : 'desc';
          orderBtn.textContent = order === 'desc' ? '↓' : '↑';
        } else {
          sort = s.key;
          for (const c of sortChips.children) c.classList.toggle('active', c.dataset.sort === sort);
        }
        savePrefs();
        reload();
      },
    }));
  }

  // ---------- 网格与懒加载 ----------
  const grid = el('div', { class: 'gallery-grid' });
  const sentinel = el('div', { class: 'gallery-sentinel' });
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadMore();
  }, { rootMargin: '800px' });
  observer.observe(sentinel);

  // ---------- 多选操作栏 ----------
  const selCount = el('span', { class: 'grow', style: { fontSize: '14px' } });
  const selAllBtn = el('button', { class: 'btn small', text: t('全选'), onclick: toggleSelectAll });
  const selDownloadBtn = el('button', { class: 'btn small primary', text: t('下载'), onclick: downloadSelected });
  const selDeleteBtn = el('button', { class: 'btn small danger', text: t('删除'), onclick: deleteSelected });
  const selExitBtn = el('button', { class: 'btn small', text: t('完成'), onclick: () => setSelectMode(false) });
  const selectBar = el('div', { class: 'card select-bar', style: { display: 'none' } },
    el('div', { class: 'row' }, selCount, selAllBtn, selDownloadBtn, selDeleteBtn, selExitBtn));

  container.append(
    el('div', { class: 'row', style: { marginBottom: '8px' } },
      el('button', { class: 'btn small', text: t('刷新'), onclick: () => reload(true) }),
      el('div', { class: 'grow' }),
      folderSelect,
      count,
      selectBtn,
    ),
    chips,
    el('div', { class: 'row', style: { marginBottom: '8px', alignItems: 'center' } }, sortChips, orderBtn),
    grid,
    sentinel,
    selectBar,
  );

  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ sort, order, filter, dir })); } catch { /* 隐私模式等场景忽略 */ }
  }

  /** 拉取含媒体的子目录清单填充下拉；当前选中目录已不存在时回退到根目录。 */
  async function refreshDirs(refresh = false) {
    let list;
    try {
      const data = await apiJson(`/gw/output-dirs${refresh ? '?refresh=1' : ''}`);
      list = data.dirs ?? [];
    } catch {
      return; // 目录清单失败不阻断图库，保留下拉原状
    }
    if (!list.includes(dir)) {
      dir = '';
      savePrefs();
    }
    folderSelect.replaceChildren(el('option', { value: '', text: t('全部文件夹') }));
    for (const d of list) folderSelect.append(el('option', { value: d, text: d }));
    folderSelect.value = dir;
  }

  function fetchPage(offset, refresh = false) {
    const q = new URLSearchParams({
      offset: String(offset), limit: String(PAGE_SIZE), sort, order, filter, dir,
    });
    if (refresh) q.set('refresh', '1');
    return apiJson(`/gw/output-list?${q}`);
  }

  async function reload(refresh = false) {
    gen++;
    const myGen = gen;
    items = [];
    total = 0;
    loaded = false;
    if (selectMode) setSelectMode(false);
    clear(grid).append(el('div', { class: 'muted', style: { padding: '12px' }, text: t('加载中…') }));
    refreshDirs(refresh); // 目录清单与首页并行拉取，失败不影响列表
    try {
      const data = await fetchPage(0, refresh);
      if (myGen !== gen) return;
      total = data.total;
      items = data.items ?? [];
      loaded = true;
      renderLoaded();
    } catch (err) {
      if (myGen === gen) showError(err);
    }
  }

  async function loadMore() {
    if (!loaded || loading || items.length >= total) return;
    loading = true;
    const myGen = gen;
    try {
      const data = await fetchPage(items.length);
      if (myGen !== gen) return;
      total = data.total;
      const next = data.items ?? [];
      items.push(...next);
      for (const item of next) grid.append(renderTile(item));
      updateCount();
      updateEmpty();
      // sentinel 仍在视口内时 IntersectionObserver 不会再次触发，重挂以续拉
      observer.unobserve(sentinel);
      observer.observe(sentinel);
    } catch (err) {
      if (myGen === gen) toast(t('加载列表失败：') + err.message);
    } finally {
      loading = false;
    }
  }

  function renderLoaded() {
    clear(grid);
    for (const item of items) grid.append(renderTile(item));
    updateCount();
    updateEmpty();
  }

  function updateCount() {
    count.textContent = loaded && total ? tf('共 {n} 项', { n: total }) : '';
  }

  function updateEmpty() {
    const empty = grid.querySelector('.gallery-empty');
    if (loaded && !items.length) {
      if (empty) return;
      grid.append(el('div', { class: 'empty gallery-empty', style: { gridColumn: '1 / -1' } },
        el('div', { class: 'big', text: '🖼️' }),
        el('div', { text: dir ? t('该文件夹暂无文件')
          : filter === 'all' ? t('输出目录还没有文件，去「运行」页生成一个吧') : t('该类型暂无文件') }),
      ));
    } else if (empty) {
      empty.remove();
    }
  }

  function showError(err) {
    clear(grid);
    const msg = err?.status === 501
      ? t('网关未配置 outputDir，无法列出输出目录')
      : t('加载列表失败：') + err.message;
    grid.append(el('div', { class: 'card error-card', style: { gridColumn: '1 / -1' } },
      el('p', { text: msg }),
      el('button', { class: 'btn small', text: t('重试'), onclick: () => reload() }),
    ));
  }

  // ---------- 磁贴 ----------
  function renderTile(item) {
    const tile = el('div', { class: 'tile', 'data-path': item.path });
    tile.append(el('div', { class: 'tile-check', text: '✓' }));
    if (item.kind === 'image') {
      tile.append(el('img', { loading: 'lazy', decoding: 'async', src: outputThumbUrl(item.path, 448, 62), alt: item.name }));
    } else if (item.kind === 'video') {
      tile.append(el('div', { class: 'tile-ico', text: '🎬' }));
      // 首选 ffmpeg 抽帧封面；网关无 ffmpeg 时回退 <video> 首帧（仅预载元数据，流量极小）
      const img = el('img', { loading: 'lazy', decoding: 'async', src: outputThumbUrl(item.path, 448, 62), alt: item.name });
      img.addEventListener('error', () => {
        img.replaceWith(el('video', {
          class: 'tile-video', preload: 'metadata', muted: '', playsinline: '',
          src: outputFileUrl(item.path) + '#t=0.1',
        }));
      });
      tile.append(img);
    } else {
      tile.append(el('div', { class: 'tile-ico', text: '🎵' }));
    }
    tile.append(el('div', { class: 'tile-name', text: `${item.name} · ${humanSize(item.size)}` }));
    attachLongPress(tile);
    tile.addEventListener('click', () => {
      if (tile._lpFired) { tile._lpFired = false; return; }
      if (selectMode) toggleSelect(item.path, tile);
      else openDetail(item);
    });
    return tile;
  }

  /** 长按 450ms 进入多选并选中当前磁贴；移动超 10px 视为滚动，取消计时。 */
  function attachLongPress(tile) {
    let timer = null;
    let sx = 0;
    let sy = 0;
    tile.addEventListener('pointerdown', (e) => {
      if (selectMode || (e.pointerType === 'mouse' && e.button !== 0)) return;
      sx = e.clientX;
      sy = e.clientY;
      timer = setTimeout(() => {
        timer = null;
        tile._lpFired = true;
        setSelectMode(true);
        toggleSelect(tile.dataset.path, tile, true);
      }, 450);
    });
    tile.addEventListener('pointermove', (e) => {
      if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) {
        clearTimeout(timer);
        timer = null;
      }
    });
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    tile.addEventListener('pointerup', cancel);
    tile.addEventListener('pointercancel', cancel);
  }

  // ---------- 多选 ----------
  function setSelectMode(on) {
    selectMode = on;
    grid.classList.toggle('selecting', on);
    selectBtn.textContent = on ? t('退出多选') : t('多选');
    selectBtn.classList.toggle('primary', on);
    selectBar.style.display = on ? '' : 'none';
    if (!on) {
      selected.clear();
      for (const tile of grid.querySelectorAll('.tile.selected')) tile.classList.remove('selected');
    }
    updateSelectBar();
  }

  function toggleSelect(path, tile, forceOn = false) {
    const on = forceOn || !selected.has(path);
    if (on) selected.add(path);
    else selected.delete(path);
    tile.classList.toggle('selected', on);
    updateSelectBar();
  }

  function toggleSelectAll() {
    const allSelected = items.length > 0 && items.every((i) => selected.has(i.path));
    if (allSelected) {
      selected.clear();
      for (const tile of grid.querySelectorAll('.tile.selected')) tile.classList.remove('selected');
    } else {
      for (const item of items) {
        selected.add(item.path);
        const tile = grid.querySelector(`.tile[data-path="${CSS.escape(item.path)}"]`);
        if (tile) tile.classList.add('selected');
      }
    }
    updateSelectBar();
  }

  function updateSelectBar() {
    selCount.textContent = tf('已选 {n} 项', { n: selected.size });
    const allSelected = loaded && items.length > 0 && items.every((i) => selected.has(i.path));
    selAllBtn.textContent = allSelected ? t('取消全选') : t('全选');
  }

  async function downloadSelected() {
    const picked = items.filter((i) => selected.has(i.path));
    if (!picked.length) {
      toast(t('未选择任何文件'));
      return;
    }
    toast(tf('开始下载 {n} 个文件…', { n: picked.length }));
    // 服务端带 Content-Disposition: attachment，浏览器下载管理器立即接管（流式，不必等整文件进内存）
    for (const item of picked) {
      const a = document.createElement('a');
      a.href = outputFileUrl(item.path, true);
      a.download = item.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 400)); // 连续触发下载需间隔，避免被浏览器拦截
    }
  }

  async function deleteSelected() {
    const paths = items.filter((i) => selected.has(i.path)).map((i) => i.path);
    if (!paths.length) {
      toast(t('未选择任何文件'));
      return;
    }
    const ok = await confirmDialog(tf('删除选中的 {n} 个文件？\n磁盘文件将被删除，此操作不可恢复。', { n: paths.length }));
    if (!ok) return;
    try {
      const res = await apiJson('/gw/output-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      removeItems((res.results ?? []).filter((r) => r.ok).map((r) => r.path));
      const failed = (res.results?.length ?? 0) - (res.deleted ?? 0);
      toast(failed ? tf('已删除 {n} 个文件，{m} 个失败', { n: res.deleted, m: failed }) : tf('已删除 {n} 个文件', { n: res.deleted }));
    } catch (err) {
      toast(t('删除失败：') + err.message);
    }
  }

  async function deleteOne(path) {
    const item = items.find((i) => i.path === path);
    const label = item?.name ?? path;
    const ok = await confirmDialog(tf('删除 {name}？\n磁盘文件将被删除，此操作不可恢复。', { name: label }));
    if (!ok) return;
    try {
      await apiJson('/gw/output-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [path] }),
      });
      removeItems([path]);
      toast(tf('已删除 {name}', { name: label }));
    } catch (err) {
      toast(t('删除失败：') + err.message);
    }
  }

  /** 从列表与网格中移除已删除条目；未加载满时补拉下一页。 */
  function removeItems(paths) {
    const gone = new Set(paths);
    if (!gone.size) return;
    items = items.filter((i) => !gone.has(i.path));
    for (const p of gone) selected.delete(p);
    for (const tile of [...grid.querySelectorAll('.tile[data-path]')]) {
      if (gone.has(tile.dataset.path)) tile.remove();
    }
    total = Math.max(items.length, total - gone.size);
    updateCount();
    updateEmpty();
    if (selectMode) updateSelectBar();
    if (items.length < total) loadMore();
  }

  // ---------- 详情浮层 ----------
  function toOverlayItem(item) {
    let ov = overlayItems.get(item.path);
    if (!ov) {
      ov = {
        filename: item.name,
        name: item.name,
        mediaType: item.kind,
        fileUrl: outputFileUrl(item.path),
        downloadUrl: outputFileUrl(item.path, true),
        path: item.path,
        size: item.size,
        mtimeMs: item.mtimeMs,
      };
      overlayItems.set(item.path, ov);
    }
    return ov;
  }

  /** PNG 元数据里的提示词按路径缓存（含「确认没有」的结果），同一文件只读一次 */
  const promptCache = new Map();
  function fetchPrompt(path) {
    if (!promptCache.has(path)) {
      promptCache.set(path, apiJson(`/gw/output-prompt?path=${encodeURIComponent(path)}`)
        .then((d) => d.prompt ?? null)
        .catch(() => null));
    }
    return promptCache.get(path);
  }

  function openDetail(item) {
    openMediaOverlay(toOverlayItem(item), {
      getPromptJson: (media) => fetchPrompt(media.path),
      onDelete: (media) => deleteOne(media.path),
      list: items.map((i) => ({ item: toOverlayItem(i), onDelete: () => deleteOne(i.path) })),
    });
  }

  await reload();
}
