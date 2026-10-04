/** 模板库视图：官方模板（/templates）+ 自定义节点示例（/api/workflow_templates），支持全局搜索。 */
import { apiJson, api, ensureSchemas } from '../lib/api.js';
import { el, clear, toast } from '../lib/ui.js';
import { setWorkflow } from '../lib/state.js';
import { t, tf } from '../lib/i18n.js';
import { detectFormat, convertUiToApi } from '../lib/workflow-form.js';

/** 与工作流页一致：解析文本 →（UI 格式先转换）→ 存入状态 → 跳运行页。 */
export async function openWorkflowFromText(text, name) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    toast(t('不是合法 JSON 工作流'));
    return false;
  }
  const format = detectFormat(json);
  if (format === 'api') {
    setWorkflow({ name, path: null, json, format: 'api' });
    location.hash = '/run';
    return true;
  }
  if (format === 'ui') {
    toast(t('正在转换模板…'));
    const uiTypes = new Set();
    for (const n of json.nodes ?? []) if (n.type) uiTypes.add(n.type);
    for (const sg of json.definitions?.subgraphs ?? []) {
      for (const n of sg.nodes ?? []) if (n.type) uiTypes.add(n.type);
    }
    const schemas = await ensureSchemas([...uiTypes]);
    const { workflow, warnings } = convertUiToApi(json, schemas);
    if (!Object.keys(workflow).length) {
      toast(t('转换失败：请在桌面端用 Workflow → Export (API) 导出后重试'));
      return false;
    }
    setWorkflow({ name, path: null, json: workflow, format: 'api', sourceFormat: 'ui', warnings });
    location.hash = '/run';
    return true;
  }
  toast(t('无法识别的工作流格式'));
  return false;
}

export async function templatesView(container) {
  const modeChips = el('div', { class: 'chips' });
  const searchWrap = el('div', { class: 'field' });
  const chips = el('div', { class: 'chips' });
  const list = el('div', {});
  let mode = 'official';
  let officialIndex = null;
  let nodeTemplates = null;
  let officialCategory = null;
  let nodePack = null;
  let query = '';

  const searchInput = el('input', { type: 'text', placeholder: t('🔍 搜索模板（名称/描述/分类）…') });
  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase();
    renderList();
  });
  searchWrap.append(searchInput);

  container.append(
    el('div', { class: 'row wrap', style: { marginBottom: '10px' } },
      el('button', { class: 'btn small', text: t('← 返回工作流'), onclick: () => { location.hash = '/workflows'; } }),
    ),
    modeChips,
    searchWrap,
    chips,
    list,
  );

  modeChips.append(
    el('button', { class: 'chip active', text: t('官方模板'), onclick: () => switchMode('official') }),
    el('button', { class: 'chip', text: t('节点示例'), onclick: () => switchMode('node') }),
  );

  async function switchMode(m) {
    mode = m;
    for (const c of modeChips.children) c.classList.toggle('active', (m === 'official') === c.textContent.includes('官方'));
    await renderChips();
    await renderList();
  }

  async function loadOfficial() {
    if (officialIndex) return;
    officialIndex = await apiJson('/templates/index.json');
  }

  async function loadNodeTemplates() {
    if (nodeTemplates) return;
    nodeTemplates = await apiJson('/workflow_templates');
  }

  async function renderChips() {
    clear(chips).append(el('span', { class: 'muted', text: t('加载中…') }));
    try {
      if (mode === 'official') {
        await loadOfficial();
        clear(chips);
        if (officialCategory == null) officialCategory = officialIndex?.[0]?.category;
        for (const mod of officialIndex ?? []) {
          chips.append(el('button', {
            class: 'chip' + (mod.category === officialCategory ? ' active' : ''),
            text: tf('{name}（{n}）', { name: mod.title ?? mod.category, n: (mod.templates ?? []).length }),
            onclick: (ev) => {
              officialCategory = mod.category;
              for (const c of chips.children) c.classList.toggle('active', c === ev.currentTarget);
              renderList();
            },
          }));
        }
      } else {
        await loadNodeTemplates();
        clear(chips);
        nodePack = nodePack ?? Object.keys(nodeTemplates).find((p) => nodeTemplates[p].length) ?? Object.keys(nodeTemplates)[0];
        for (const pack of Object.keys(nodeTemplates)) {
          chips.append(el('button', {
            class: 'chip' + (pack === nodePack ? ' active' : ''),
            text: tf('{name}（{n}）', { name: pack.replace(/^ComfyUI-/i, ''), n: nodeTemplates[pack].length }),
            onclick: (ev) => {
              nodePack = pack;
              for (const c of chips.children) c.classList.toggle('active', c === ev.currentTarget);
              renderList();
            },
          }));
        }
      }
    } catch (err) {
      clear(chips).append(el('span', { class: 'muted', text: t('加载失败：') + err.message }));
    }
  }

  function officialCard(mod, tpl) {
    return el('div', { class: 'list-item', style: { alignItems: 'flex-start' } },
      el('div', { class: 'grow' },
        el('div', { class: 'title', text: tpl.title ?? tpl.name }),
        tpl.description ? el('div', { class: 'muted', style: { marginTop: '4px' }, text: tpl.description.slice(0, 80) }) : null,
        el('div', { class: 'muted', style: { fontSize: '11px' }, text: mod.title ?? mod.category }),
      ),
      el('button', { class: 'btn small primary', text: t('打开'), onclick: () => openOfficial(tpl) }),
    );
  }

  function nodeCard(pack, title) {
    return el('div', { class: 'list-item' },
      el('div', { class: 'grow' },
        el('div', { class: 'title', style: { fontSize: '14px' }, text: title }),
        el('div', { class: 'muted', style: { fontSize: '11px' }, text: pack }),
      ),
      el('button', { class: 'btn small primary', text: t('打开'), onclick: () => openNodeExample(pack, title) }),
    );
  }

  function renderSearchResults() {
    let count = 0;
    // 官方模板全量搜索
    for (const mod of officialIndex ?? []) {
      for (const tpl of mod.templates ?? []) {
        if (count >= 60) break;
        const hay = `${tpl.title ?? ''} ${tpl.name ?? ''} ${tpl.description ?? ''}`.toLowerCase();
        if (!hay.includes(query)) continue;
        list.append(officialCard(mod, tpl));
        count++;
      }
    }
    // 节点示例搜索
    for (const [pack, titles] of Object.entries(nodeTemplates ?? {})) {
      for (const title of titles) {
        if (count >= 60) break;
        if (`${title} ${pack}`.toLowerCase().includes(query)) {
          list.append(nodeCard(pack, title));
          count++;
        }
      }
    }
    if (!count) list.append(el('div', { class: 'muted', text: t('没有匹配的模板') }));
    else list.append(el('div', { class: 'muted', style: { textAlign: 'center' }, text: count >= 60 ? '仅显示前 60 条，请 refine 搜索词' : `共 ${count} 条` }));
  }

  async function renderList() {
    clear(list).append(el('div', { class: 'muted', text: t('加载中…') }));
    if (query) {
      try {
        if (mode === 'official') await loadOfficial();
        else await loadNodeTemplates();
        if ((mode === 'official' && !officialIndex) || (mode === 'node' && !nodeTemplates)) return;
        clear(list);
        renderSearchResults();
      } catch (err) {
        clear(list).append(el('div', { class: 'muted', text: t('加载失败：') + err.message }));
      }
      return;
    }
    clear(list);
    try {
      if (mode === 'official') {
        const mod = (officialIndex ?? []).find((m) => m.category === officialCategory);
        for (const tpl of mod?.templates ?? []) list.append(officialCard(mod, tpl));
        if (!(mod?.templates ?? []).length) list.append(el('div', { class: 'muted', text: t('该分类暂无模板') }));
      } else {
        for (const title of nodeTemplates[nodePack] ?? []) list.append(nodeCard(nodePack, title));
        if (!(nodeTemplates[nodePack] ?? []).length) list.append(el('div', { class: 'muted', text: t('该节点包没有示例') }));
      }
    } catch (err) {
      clear(list).append(el('div', { class: 'muted', text: t('加载失败：') + err.message }));
    }
  }

  async function openOfficial(tpl) {
    toast(t('打开模板：') + (tpl.title ?? tpl.name));
    const res = await api(`/templates/${encodeURIComponent(tpl.name)}.json`);
    await openWorkflowFromText(await res.text(), `${tpl.title ?? tpl.name}.json`);
  }

  async function openNodeExample(pack, title) {
    toast(t('打开示例：') + title);
    const res = await api(`/api/workflow_templates/${encodeURIComponent(pack)}/${encodeURIComponent(title)}.json`);
    await openWorkflowFromText(await res.text(), `${title}.json`);
  }

  await renderChips();
  await renderList();
}
