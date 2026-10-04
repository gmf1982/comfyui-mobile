/**
 * 内置提示词助手：常用词库 + 我的收藏 + 规则式提示词增强，点选即插入提示词输入框光标处。
 * 纯前端实现，不依赖任何 ComfyUI 插件与 LLM（桌面端的"提示词小助手"扩展 JS 在本 PWA 中无法运行）。
 * 收藏存 state.settings.promptSnippets，随偏好云同步跨设备/跨入口共享。
 * 增强引擎见 prompt-enhancer.js：按当前工作流检测到的模型（Qwen/Z-Image/Krea/H3）套模板扩写。
 */
import { el, showSheet, hideSheet, toast } from './ui.js';
import { state, saveSettings } from './state.js';
import { apiJson } from './api.js';
import { t, tf } from './i18n.js';
import { enhancePrompt, detectModelProfile, detectMode, MODEL_PROFILES } from './prompt-enhancer.js';

const MAX_SNIPPETS = 50;

/** 内置词库：标签是提示词内容（英文原样插入），类别名是界面文案走 i18n。 */
const CATEGORIES = [
  { label: '画质质感', tags: ['masterpiece', 'best quality', 'ultra detailed', 'high resolution', 'sharp focus', '8k uhd', 'intricate details', 'photorealistic'] },
  { label: '风格', tags: ['cinematic', 'oil painting', 'watercolor', 'anime style', '3d render', 'concept art', 'flat illustration', 'cyberpunk', 'steampunk', 'minimalist'] },
  { label: '光影', tags: ['golden hour lighting', 'soft lighting', 'dramatic lighting', 'rim light', 'volumetric lighting', 'backlighting', 'neon lights', 'studio lighting', 'sunset glow'] },
  { label: '构图镜头', tags: ['close-up', 'medium shot', 'wide angle', 'portrait', 'full body shot', 'overhead view', 'depth of field', 'bokeh', 'macro'] },
  { label: '人物细节', tags: ['detailed face', 'expressive eyes', 'flowing hair', 'perfect anatomy', 'delicate skin texture', 'dynamic pose', 'elegant', 'graceful'] },
  { label: '氛围场景', tags: ['dreamy atmosphere', 'misty', 'rainy day', 'snowy', 'cherry blossoms', 'starry night', 'cozy', 'serene', 'epic scene'] },
  { label: '负向通用', tags: ['lowres', 'bad anatomy', 'bad hands', 'extra fingers', 'blurry', 'jpeg artifacts', 'watermark', 'text', 'deformed', 'duplicate'] },
];

const FAV_CAT = '__fav__';

function snippets() {
  const v = state.settings.promptSnippets;
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()) : [];
}

function addSnippet(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (snippets().includes(trimmed)) return false;
  const list = [trimmed, ...snippets()].slice(0, MAX_SNIPPETS);
  state.settings.promptSnippets = list;
  saveSettings();
  return true;
}

function removeSnippet(text) {
  state.settings.promptSnippets = snippets().filter((s) => s !== text);
  saveSettings();
}

/** 在光标处插入词：与前文自动补逗号分隔，触发 input 让 onChange 持久化。 */
function insertAtCursor(ta, text) {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  const sep = before && !/[\s,，\n]$/.test(before) ? ', ' : '';
  ta.value = `${before}${sep}${text}${after}`;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const pos = (before + sep + text).length;
  ta.focus();
  try { ta.setSelectionRange(pos, pos); } catch { /* 个别浏览器不支持，仅影响光标定位 */ }
}

/**
 * 打开提示词助手抽屉。
 * @param {HTMLTextAreaElement} textarea 提示词输入框（插入目标）
 */
export function openPromptAssistant(textarea) {
  let activeCat = snippets().length ? FAV_CAT : CATEGORIES[0].label;
  let query = '';

  const grid = el('div', { class: 'tag-grid' });
  const chipsRow = el('div', { class: 'row wrap', style: { gap: '6px' } });
  const search = el('input', {
    type: 'search',
    placeholder: t('搜索常用词…'),
    style: { marginBottom: '8px' },
  });
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    renderGrid();
  });

  const favBtn = el('button', {
    class: 'btn small', text: '⭐ ' + t('收藏当前内容'),
    onclick: () => {
      if (!textarea.value.trim()) { toast(t('输入框为空，先写点内容再收藏')); return; }
      toast(addSnippet(textarea.value) ? t('已收藏') : t('已在收藏中'));
      renderChips();
      renderGrid();
    },
  });

  // ---- 规则式增强区：按当前工作流模型套模板扩写（不用 LLM） ----
  const profileKey = detectModelProfile(state.workflow?.json);
  const profileLabel = MODEL_PROFILES[profileKey]?.label ?? MODEL_PROFILES.generic.label;
  let mode = detectMode(state.workflow?.json, profileKey);
  const MODE_LABELS = { t2i: '文生图', edit: '图生图·编辑', video: '视频' };

  const modeChips = el('div', { class: 'row wrap', style: { gap: '6px' } });
  function renderModeChips() {
    while (modeChips.firstChild) modeChips.firstChild.remove();
    for (const key of ['t2i', 'edit', 'video']) {
      modeChips.append(el('button', {
        class: 'btn tiny cat-chip' + (mode === key ? ' on' : ''),
        text: t(MODE_LABELS[key]),
        onclick: () => { mode = key; renderModeChips(); },
      }));
    }
  }
  renderModeChips();

  // 增强模型选择：网关配置了多个模型（config.promptLlm.models）时显示下拉，选择随偏好同步。
  // 拉取失败/未启用 → 该行保持隐藏，增强走默认模型或规则回退。
  let modelChoices = null;
  let chosen = typeof state.settings.enhanceModel === 'string' ? state.settings.enhanceModel : '';
  const modelSel = el('select', {
    style: { flex: '1', maxWidth: '280px' },
    onchange: () => {
      chosen = modelSel.value;
      state.settings.enhanceModel = chosen;
      saveSettings();
    },
  });
  const modelRow = el('div', { class: 'row', style: { alignItems: 'center', gap: '8px', marginTop: '10px' } },
    el('span', { class: 'muted', style: { fontSize: '11px', flex: 'none' }, text: t('增强模型') }),
    modelSel,
  );
  modelRow.hidden = true;
  // 下拉首项 = "不用 LLM"：选中后增强直接走内置规则引擎、不发网关请求（选择照常随偏好同步）。
  const RULES_OPT = '__rules__';
  apiJson('/gw/enhance-models').then((r) => {
    if (!r?.enabled || !Array.isArray(r.models) || !r.models.length) return;
    modelChoices = r.models;
    if (chosen !== RULES_OPT && !modelChoices.some((m) => m.name === chosen)) chosen = r.default ?? modelChoices[0].name;
    modelSel.replaceChildren(
      el('option', { value: RULES_OPT, text: t('不用 LLM（内置规则）') }),
      ...modelChoices.map((m) => el('option', { value: m.name, text: m.name })),
    );
    modelSel.value = chosen;
    modelRow.hidden = false;
  }).catch(() => { /* 未配置增强时保持隐藏 */ });

  const enhNotes = el('div', { class: 'muted', style: { fontSize: '11px', margin: '6px 2px 0' } });
  const preview = el('textarea', {
    rows: '5', style: { fontSize: '13px', marginTop: '8px' },
    placeholder: t('点「增强」生成改写结果，可手动修改后再替换'),
  });
  let enhBtn = null;

  /**
   * 两级增强：优先网关 LLM（config.promptLlm 配置的智谱/Ollama 等端点，理解语义、不冲突），
   * 未配置（501）或失败时回退内置规则引擎，来源标注在预览下方。
   */
  async function runEnhance() {
    const src = textarea.value.trim();
    if (!src) { toast(t('输入框为空，先写点提示词')); return; }
    if (chosen === RULES_OPT) {
      const r = enhancePrompt({ text: src, profileKey, mode });
      preview.value = r.text;
      enhNotes.textContent = [t('来源：内置规则（已选择不使用 LLM）'), ...r.notes.map((n) => t(n))].join('；');
      enhResult.hidden = false;
      return;
    }
    if (enhBtn) { enhBtn.disabled = true; enhBtn.textContent = '⏳ ' + t('增强中…'); }
    let out = '';
    let notes = [];
    try {
      const r = await apiJson('/gw/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: src, profileKey, mode, ...(chosen ? { model: chosen } : {}) }),
      });
      out = r.text;
      notes = [tf('来源：智能增强（{m}）', { m: r.name ?? r.model ?? 'LLM' })];
    } catch (err) {
      const r = enhancePrompt({ text: src, profileKey, mode });
      out = r.text;
      notes = [t('来源：内置规则（网关未配置 LLM 或调用失败）'), ...r.notes.map((n) => t(n))];
      if (err?.status !== 501) toast(t('智能增强不可用，已用规则增强'));
    } finally {
      if (enhBtn) { enhBtn.disabled = false; enhBtn.textContent = '⚡ ' + t('增强'); }
    }
    preview.value = out;
    enhNotes.textContent = notes.join('；');
    enhResult.hidden = false;
  }

  const actRow = el('div', { class: 'row wrap', style: { gap: '6px', marginTop: '8px' } },
    el('button', {
      class: 'btn small primary', text: '✓ ' + t('替换输入框'),
      onclick: () => {
        if (!preview.value.trim()) return;
        textarea.value = preview.value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        hideSheet();
        toast(t('已替换提示词'));
      },
    }),
    el('button', {
      class: 'btn small', text: '⊕ ' + t('追加到光标处'),
      onclick: () => {
        if (!preview.value.trim()) return;
        insertAtCursor(textarea, preview.value);
        toast(t('已追加'));
      },
    }),
    el('button', { class: 'btn small', text: '↻ ' + t('换一版'), onclick: () => runEnhance() }),
    el('button', {
      class: 'btn small', text: '⭐ ' + t('收藏此结果'),
      onclick: () => {
        toast(addSnippet(preview.value) ? t('已收藏') : t('已在收藏中'));
        renderChips();
        renderGrid();
      },
    }),
  );
  const enhResult = el('div', { hidden: true }, preview, enhNotes, actRow);

  const content = el('div', {},
    el('div', { class: 'row', style: { alignItems: 'center', marginBottom: '12px' } },
      el('h3', { style: { margin: 0, flex: 1 }, text: t('提示词助手') }),
      favBtn,
    ),
    // 增强区：与下方词库用虚线分隔；模式选择带标签，行间留出呼吸感
    el('div', { class: 'enh-sec' },
      el('div', { class: 'row', style: { alignItems: 'center', gap: '6px', marginBottom: '10px' } },
        enhBtn = el('button', { class: 'btn small primary', text: '⚡ ' + t('增强'), onclick: () => runEnhance() }),
        el('span', { class: 'muted', style: { fontSize: '11px', flex: '1' }, text: tf('模型：{m}', { m: profileLabel }) }),
      ),
      el('div', { class: 'row', style: { alignItems: 'center', gap: '8px' } },
        el('span', { class: 'muted', style: { fontSize: '11px', flex: 'none' }, text: t('模式') }),
        modeChips,
      ),
      modelRow,
      enhResult,
    ),
    search,
    chipsRow,
    el('div', { class: 'muted', style: { fontSize: '11px', margin: '8px 0' }, text: t('点词即插入光标处，可连续点选') }),
    grid,
  );

  function chip(label, key) {
    const active = activeCat === key && !query;
    return el('button', {
      class: 'btn small cat-chip' + (active ? ' on' : ''),
      text: label,
      onclick: () => {
        query = '';
        search.value = '';
        activeCat = key;
        renderChips();
        renderGrid();
      },
    });
  }

  function renderChips() {
    clearChips();
    if (snippets().length) chipsRow.append(chip(`⭐ ${t('我的收藏')}（${snippets().length}）`, FAV_CAT));
    for (const cat of CATEGORIES) chipsRow.append(chip(t(cat.label), cat.label));
  }

  function clearChips() {
    while (chipsRow.firstChild) chipsRow.firstChild.remove();
  }

  function tagCell(text) {
    const cell = el('button', {
      class: 'tag-cell',
      onclick: () => insertAtCursor(textarea, text),
    }, el('span', { class: 'tag-text', text }));
    return cell;
  }

  /** 收藏格：主体点击插入，右上角 ✕ 原位两段式删除（点一下变红"删除"，再点确认，3 秒回弹）。 */
  function favCell(text) {
    const del = el('span', { class: 'tag-del', text: '✕' });
    let armed = false;
    let timer = 0;
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!armed) {
        armed = true;
        del.classList.add('armed');
        del.textContent = t('删除');
        timer = setTimeout(() => {
          armed = false;
          del.classList.remove('armed');
          del.textContent = '✕';
        }, 3000);
        return;
      }
      clearTimeout(timer);
      removeSnippet(text);
      toast(t('已删除'));
      renderChips();
      renderGrid();
    });
    const cell = el('div', { class: 'tag-cell fav' }, el('span', { class: 'tag-text', text }), del);
    cell.addEventListener('click', () => insertAtCursor(textarea, text));
    return cell;
  }

  function renderGrid() {
    while (grid.firstChild) grid.firstChild.remove();
    const q = query.toLowerCase();
    if (q) {
      const hits = [
        ...snippets().filter((s) => s.toLowerCase().includes(q)),
        ...CATEGORIES.flatMap((c) => c.tags).filter((tag) => tag.toLowerCase().includes(q)),
      ];
      for (const tag of [...new Set(hits)]) grid.append(snippets().includes(tag) ? favCell(tag) : tagCell(tag));
      if (!hits.length) grid.append(el('div', { class: 'muted', text: t('没有匹配的常用词') }));
      return;
    }
    if (activeCat === FAV_CAT) {
      const list = snippets();
      for (const s of list) grid.append(favCell(s));
      if (!list.length) grid.append(el('div', { class: 'muted', text: t('还没有收藏，点右上「收藏当前内容」') }));
      return;
    }
    const cat = CATEGORIES.find((c) => c.label === activeCat) ?? CATEGORIES[0];
    for (const tag of cat.tags) grid.append(tagCell(tag));
  }

  renderChips();
  renderGrid();
  showSheet(content);
}
