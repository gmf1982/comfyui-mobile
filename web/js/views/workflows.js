/** 工作流视图：列表、打开、重命名、删除、下载、新建。 */
import { api, apiJson, ensureSchemas } from '../lib/api.js';
import { el, clear, toast, showSheet, hideSheet, confirmDialog, promptDialog } from '../lib/ui.js';
import { detectFormat, convertUiToApi, starterWorkflow, listApiNodes } from '../lib/workflow-form.js';
import { setWorkflow, addOpenWorkflow, openWorkflows, removeOpenWorkflow, favorites, isFavorite, toggleFavorite } from '../lib/state.js';
import { downloadText } from '../lib/media.js';
import { apiToUi } from '../lib/graph.js';
import { t } from '../lib/i18n.js';

function basename(path) {
  return path.split('/').pop();
}

// ComfyUI 的 /userdata/{path} 路由将整段路径按单参数匹配：
// 斜杠必须整体编码为 %2F（与官方前端一致），路径需带 workflows/ 前缀。
export function encodeUserdataPath(path) {
  return encodeURIComponent(`workflows/${path}`);
}

/**
 * 读取并载入工作流（不跳转页面时用于跨刷新恢复与图库“用作图片输入”）。
 * @param {string} path userdata 内的相对路径
 * @param {{navigate?: boolean, silent?: boolean}} options
 * @returns {Promise<boolean>} 是否成功载入
 */
export async function loadWorkflowFromPath(path, options = {}) {
  const { navigate = true, silent = false } = options;
  const res = await api(`/userdata/${encodeUserdataPath(path)}`);
  if (!res.ok) {
    if (!silent) toast(t('读取失败：') + 'HTTP ' + res.status);
    return false;
  }
  let json;
  try {
    json = JSON.parse(await res.text());
  } catch {
    if (!silent) toast(t('该文件不是合法 JSON 工作流'));
    return false;
  }
  const format = detectFormat(json);
  if (format === 'api') {
    setWorkflow({ name: basename(path), path, json, format: 'api' });
    addOpenWorkflow({ path, name: basename(path) });
    if (navigate) location.hash = '/run';
    return true;
  }
  if (format === 'ui') {
    if (!silent) toast(t('检测到桌面端 UI 格式，正在转换…'));
    const uiTypes = new Set();
    for (const n of json.nodes ?? []) if (n.type) uiTypes.add(n.type);
    for (const sg of json.definitions?.subgraphs ?? json.subgraphs ?? []) {
      for (const n of sg.nodes ?? []) if (n.type) uiTypes.add(n.type);
    }
    const schemas = await ensureSchemas([...uiTypes]);
    const { workflow, warnings } = convertUiToApi(json, schemas);
    if (!Object.keys(workflow).length) {
      if (!silent) toast(t('转换失败：请在桌面端用 Workflow → Export (API) 导出后重试'));
      return false;
    }
    setWorkflow({ name: basename(path), path, json: workflow, format: 'api', sourceFormat: 'ui', warnings });
    addOpenWorkflow({ path, name: basename(path) });
    if (navigate) location.hash = '/run';
    return true;
  }
  if (!silent) toast(t('无法识别的工作流格式'));
  return false;
}

/** 打开工作流：解析格式 →（UI 格式先转换）→ 存入全局状态 → 跳运行页。 */
export async function openWorkflowByName(path) {
  await loadWorkflowFromPath(path, { navigate: true });
}

export async function workflowsView(container) {
  const list = el('div', {});
  let onlyFav = false;
  const favChip = el('button', { class: 'chip', text: t('⭐ 只看收藏'), onclick: () => { onlyFav = !onlyFav; favChip.classList.toggle('active', onlyFav); renderRows(); } });
  container.append(
    el('div', { class: 'row wrap', style: { marginBottom: '12px' } },
      el('button', { class: 'btn primary small', text: `＋ ${t('新建工作流')}`, onclick: createWorkflow }),
      el('button', { class: 'btn small', text: t('📚 模板库'), onclick: () => { location.hash = '/templates'; } }),
      el('button', { class: 'btn small', text: t('刷新'), onclick: () => load() }),
    ),
    el('div', { class: 'chips' }, favChip),
    list,
  );

  let cachedPaths = [];

  /** 用缓存的路径列表渲染（收藏切换后即时置顶，无需重新请求）。 */
  function renderRows() {
    clear(list);
    if (!cachedPaths.length) {
      list.append(el('div', { class: 'empty' }, el('div', { class: 'big', text: '🗂️' }), el('div', { text: t('还没有工作流，点击上方「新建工作流」') })));
      return;
    }
    const favs = favorites();
    const sorted = [...cachedPaths].sort((a, b) => {
      const fa = favs.includes(a) ? 0 : 1;
      const fb = favs.includes(b) ? 0 : 1;
      return fa - fb || a.localeCompare(b);
    });
    const shown = onlyFav ? sorted.filter((p) => favs.includes(p)) : sorted;
    if (!shown.length) {
      list.append(el('div', { class: 'muted', style: { padding: '20px 4px' }, text: t('还没有收藏的工作流：点左侧 ☆ 即可收藏。') }));
      return;
    }
    for (const path of shown) list.append(row(path));
  }

  async function load() {
    clear(list).append(el('div', { class: 'muted', text: t('加载中…') }));
    let paths;
    try {
      paths = await apiJson('/userdata?dir=workflows&recurse=true&split=false');
    } catch (err) {
      clear(list).append(el('div', { class: 'card error-card' }, el('p', { text: t('无法获取工作流列表：') + err.message })));
      return;
    }
    cachedPaths = Array.isArray(paths) ? paths : [];
    renderRows();
  }

  function row(path) {
    const open = el('div', { class: 'grow' },
      el('div', { class: 'title', text: basename(path) }),
      path.includes('/') ? el('div', { class: 'muted', text: path }) : null,
    );
    open.addEventListener('click', () => openWorkflowByName(path));
    const star = el('button', {
      class: 'icon-btn star' + (isFavorite(path) ? ' on' : ''),
      title: isFavorite(path) ? t('取消收藏') : t('收藏'),
      text: isFavorite(path) ? '★' : '☆',
    });
    star.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const on = toggleFavorite(path);
      star.textContent = on ? '★' : '☆';
      star.classList.toggle('on', on);
      toast(on ? t('已收藏（置顶）') : t('已取消收藏'));
      renderRows();
    });
    return el('div', { class: 'list-item' },
      star,
      open,
      el('button', { class: 'icon-btn', text: '⋯', onclick: (ev) => { ev.stopPropagation(); actionsSheet(path); } }),
    );
  }

  function actionsSheet(path) {
    const name = basename(path);
    showSheet(el('div', {},
      el('h3', { text: name }),
      el('button', { class: 'btn', style: { width: '100%', marginBottom: '8px' }, text: t('打开'), onclick: () => { hideSheet(); openWorkflowByName(path); } }),
      el('button', { class: 'btn', style: { width: '100%', marginBottom: '8px' }, text: t('下载'), onclick: async () => {
        hideSheet();
        const res = await api(`/userdata/${encodeUserdataPath(path)}`);
        downloadText(name, await res.text());
      } }),
      el('button', { class: 'btn', style: { width: '100%', marginBottom: '8px' }, text: t('重命名'), onclick: async () => {
        hideSheet();
        const newName = await promptDialog(t('新文件名'), name);
        if (!newName || newName === name) return;
        try {
          const res = await api(`/userdata/${encodeUserdataPath(path)}`);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const content = await res.text();
          const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
          await apiJson(`/userdata/${encodeURIComponent(`workflows/${dir + newName}`)}?overwrite=true`, { method: 'POST', body: content });
          const del = await api(`/userdata/${encodeUserdataPath(path)}`, { method: 'DELETE' });
          if (!del.ok) throw new Error('HTTP ' + del.status);
          // 多开列表同步改名，否则旧路径变死条目（运行页切换时才被动清理）
          const wasOpen = openWorkflows().some((e) => e.path === path);
          removeOpenWorkflow(path);
          if (wasOpen) addOpenWorkflow({ path: dir + newName, name: newName });
          toast(t('已重命名'));
        } catch (err) {
          toast(t('重命名失败：') + err.message);
        }
        load();
      } }),
      el('button', { class: 'btn danger', style: { width: '100%' }, text: t('删除'), onclick: async () => {
        hideSheet();
        if (!(await confirmDialog(t('确定删除') + name + t('？该操作不可恢复。')))) return;
        try {
          const res = await api(`/userdata/${encodeUserdataPath(path)}`, { method: 'DELETE' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          removeOpenWorkflow(path); // 运行页多开列表同步清理，避免残留死条目
          toast(t('已删除'));
        } catch (err) {
          toast(t('删除失败：') + err.message);
        }
        load();
      } }),
    ));
  }

  async function createWorkflow() {
    const name = await promptDialog(t('工作流名称'), t('我的工作流.json'));
    if (!name) return;
    const fileName = name.endsWith('.json') ? name : `${name}.json`;
    try {
      const starter = starterWorkflow();
      // 落盘用桌面 UI 图格式：桌面 ComfyUI 可直接打开；内存状态仍是 API 格式
      const classes = listApiNodes(starter).map((n) => n.class_type);
      const payload = JSON.stringify(apiToUi(starter, await ensureSchemas(classes)), null, 2);
      await apiJson(`/userdata/${encodeURIComponent(`workflows/${fileName}`)}?overwrite=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      toast(t('已创建'));
      setWorkflow({ name: fileName, path: fileName, json: starter, format: 'api' });
      addOpenWorkflow({ path: fileName, name: fileName });
      location.hash = '/run';
    } catch (err) {
      toast(t('创建失败：') + err.message);
    }
  }

  await load();
}
