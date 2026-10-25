/**
 * 内置提示词助手：智能增强（图生图模式附带当前图片给视觉 LLM 读图）+ 分类收藏。
 * 收藏存 state.settings.promptFavorites（[{name, items:[{name,text}]}]）：
 * 分类与条目都默认折叠，分类点标题展开、条目点行展开正文（点正文插入）；
 * 旧的扁平 promptSnippets 与字符串条目首次读取时自动迁移。
 * 规则式回退引擎见 prompt-enhancer.js：按当前工作流检测到的模型套模板扩写。
 */
import { el, showSheet, hideSheet, toast } from './ui.js';
import { state, saveSettings, loadWorkflowParams } from './state.js';
import { apiJson } from './api.js';
import { t, tf } from './i18n.js';
import { enhancePrompt, detectModelProfile, detectMode, promptLang, MODEL_PROFILES } from './prompt-enhancer.js';

const MAX_SNIPPETS = 50;
const DEFAULT_FOLDER = '默认收藏';

// ---------------- 收藏存储（分类 + 条目 {name, text} + 总量上限） ----------------

/** 条目默认名称：取正文前 24 字，超长加省略号。 */
function shortName(text) {
  const s = String(text).trim();
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}

/** 兼容三种历史/当前形态：纯字符串（旧）、{text} 对象、完整 {name,text}。 */
function normalizeItem(it) {
  if (typeof it === 'string') {
    const text = it.trim();
    return text ? { name: shortName(text), text } : null;
  }
  if (it && typeof it.text === 'string' && it.text.trim()) {
    const text = it.text.trim();
    return { name: (typeof it.name === 'string' && it.name.trim()) || shortName(text), text };
  }
  return null;
}

/** 读取分类收藏（返回深拷贝，改完必须 setFolders 落盘）。 */
function folders() {
  const v = state.settings.promptFavorites;
  const legacy = Array.isArray(state.settings.promptSnippets)
    ? state.settings.promptSnippets.map(normalizeItem).filter(Boolean)
    : [];
  // 云同步可能先推来空的 promptFavorites：只要本机旧列表还有内容就仍要迁移，否则旧收藏会被"遮住"
  if (Array.isArray(v) && (v.length || !legacy.length)) {
    return v
      .filter((f) => f && typeof f.name === 'string' && Array.isArray(f.items))
      .map((f) => ({ name: f.name, items: f.items.map(normalizeItem).filter(Boolean) }));
  }
  const list = legacy.length ? [{ name: t(DEFAULT_FOLDER), items: legacy.slice(0, MAX_SNIPPETS) }] : [];
  setFolders(list);
  return clone(list);
}

function clone(list) {
  return list.map((f) => ({ name: f.name, items: f.items.map((i) => ({ ...i })) }));
}

function setFolders(list) {
  state.settings.promptFavorites = list;
  state.settings.promptSnippets = [];
  saveSettings();
}

function totalItems(list) {
  return list.reduce((n, f) => n + f.items.length, 0);
}

/** 收藏到指定分类；按正文全库查重、超上限从最旧分类尾部丢弃。@returns {boolean} 是否新增 */
function addFav(folderName, text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const list = folders();
  if (list.some((f) => f.items.some((i) => i.text === trimmed))) return false;
  let folder = list.find((f) => f.name === folderName);
  if (!folder) {
    folder = { name: folderName, items: [] };
    list.push(folder);
  }
  folder.items.unshift({ name: shortName(trimmed), text: trimmed });
  while (totalItems(list) > MAX_SNIPPETS) {
    const donor = [...list].reverse().find((f) => f.items.length);
    if (!donor) break;
    donor.items.pop();
  }
  setFolders(list);
  return true;
}

function removeFav(text) {
  const list = folders();
  for (const f of list) f.items = f.items.filter((i) => i.text !== text);
  setFolders(list);
}

/** 把收藏条目移到另一个分类（按正文匹配）。@returns {boolean} 是否移动成功 */
function moveFav(text, toFolder) {
  const list = folders();
  const dest = list.find((f) => f.name === toFolder);
  if (!dest) return false;
  for (const f of list) {
    if (f.name === toFolder) continue;
    const idx = f.items.findIndex((i) => i.text === text);
    if (idx >= 0) {
      dest.items.unshift(f.items.splice(idx, 1)[0]);
      setFolders(list);
      return true;
    }
  }
  return false;
}

// ---------------- 图生图：定位当前输入图片 ----------------

/** 找工作流第一个有值的图片输入（表单缓存优先于 JSON），返回 /view 定位参数。 */
function currentInputImage() {
  const json = state.workflow?.json ?? {};
  const params = loadWorkflowParams(state.workflow);
  for (const [id, node] of Object.entries(json)) {
    const classType = String(node?.class_type ?? '');
    if (!/loadimage/i.test(classType)) continue;
    const raw = params[`${id}:image`] ?? node?.inputs?.image;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const value = raw.trim();
    const slash = value.lastIndexOf('/');
    return {
      filename: slash === -1 ? value : value.slice(slash + 1),
      subfolder: slash === -1 ? '' : value.slice(0, slash),
      type: /loadimageoutput/i.test(classType) ? 'output' : 'input',
    };
  }
  return null;
}

/**
 * 打开提示词助手抽屉。
 * @param {HTMLTextAreaElement} textarea 提示词输入框（插入目标）
 */
export function openPromptAssistant(textarea, anchor) {
  const favWrap = el('div', { style: { marginTop: '14px' } });
  const expanded = new Set();
  const openItems = new Set();

  /** 在光标处插入词：与前文自动补逗号分隔，触发 input 让 onChange 持久化。 */
  function insertAtCursor(text) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const sep = before && !/[\s,，\n]$/.test(before) ? ', ' : '';
    textarea.value = `${before}${sep}${text}${after}`;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const pos = (before + sep + text).length;
    textarea.focus();
    try { textarea.setSelectionRange(pos, pos); } catch { /* 个别浏览器不支持，仅影响光标定位 */ }
  }

  // ---- 增强区：按当前工作流 + 表单里的模型选择套模板扩写 ----
  const wfParams = loadWorkflowParams(state.workflow);
  const profileKey = detectModelProfile(state.workflow?.json, wfParams);
  const profileLabel = t(MODEL_PROFILES[profileKey]?.label ?? MODEL_PROFILES.generic.label);
  let mode = detectMode(state.workflow?.json, profileKey);
  const MODE_LABELS = { t2i: '文生图', edit: '图生图·编辑', video: '视频' };

  const imgHint = el('div', { class: 'muted', style: { fontSize: '11px', marginTop: '6px' } });
  imgHint.hidden = true;

  const modeChips = el('div', { class: 'row wrap', style: { gap: '6px' } });
  function renderModeChips() {
    while (modeChips.firstChild) modeChips.firstChild.remove();
    for (const key of ['t2i', 'edit', 'video']) {
      modeChips.append(el('button', {
        class: 'btn tiny cat-chip' + (mode === key ? ' on' : ''),
        text: t(MODE_LABELS[key]),
        onclick: () => { mode = key; renderModeChips(); renderImgHint(); },
      }));
    }
  }
  function renderImgHint() {
    if (mode !== 'edit') { imgHint.hidden = true; return; }
    const img = currentInputImage();
    imgHint.hidden = false;
    imgHint.textContent = img
      ? tf('增强时附带当前图片：{f}（需支持视觉的模型）', { f: img.filename })
      : t('未找到图片输入，将按纯文本增强');
  }
  renderModeChips();
  renderImgHint();

  // 增强模型选择：打开助手时实时探测端点上的模型；配置变化/新装模型可点 ↻ 重探。
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
  const modelRefresh = el('button', {
    class: 'btn tiny', text: '↻', title: t('重新探测模型'),
    onclick: () => loadEnhanceModels(true),
  });
  const modelHint = el('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } });
  modelHint.hidden = true;
  const modelRow = el('div', { style: { marginTop: '10px' } },
    el('div', { class: 'row', style: { alignItems: 'center', gap: '8px' } },
      el('span', { class: 'muted', style: { fontSize: '11px', flex: 'none' }, text: t('增强模型') }),
      modelSel,
      modelRefresh,
    ),
    modelHint,
  );
  modelRow.hidden = true;
  // 下拉首项 = "不用 LLM"：选中后增强直接走内置规则引擎、不发网关请求（选择照常随偏好同步）。
  const RULES_OPT = '__rules__';

  async function loadEnhanceModels(fresh = false) {
    modelRefresh.disabled = true;
    try {
      const r = await apiJson(`/gw/enhance-models${fresh ? '?refresh=1' : ''}`);
      if (!r?.enabled || !Array.isArray(r.models) || !r.models.length) {
        modelRow.hidden = true;
        return;
      }
      modelChoices = r.models;
      if (chosen !== RULES_OPT && !modelChoices.some((m) => m.key === chosen)) chosen = r.default ?? modelChoices[0].key;
      modelSel.replaceChildren(
        el('option', { value: RULES_OPT, text: t('不用 LLM（内置规则）') }),
        ...modelChoices.map((m) => el('option', { value: m.key, text: m.name })),
      );
      modelSel.value = chosen;
      modelRow.hidden = false;
      modelHint.hidden = r.live !== false;
      modelHint.textContent = r.live === false ? t('端点不可达，显示配置中的模型') : '';
      if (fresh) toast(t('模型列表已更新'));
    } catch {
      if (fresh) toast(t('探测失败，已保留原列表'));
    } finally {
      modelRefresh.disabled = false;
    }
  }
  loadEnhanceModels();

  const enhNotes = el('div', { class: 'muted', style: { fontSize: '11px', margin: '6px 2px 0' } });
  const preview = el('textarea', {
    rows: '5', style: { fontSize: '13px', marginTop: '8px' },
    placeholder: t('点「增强」生成改写结果，可手动修改后再替换'),
  });
  let enhBtn = null;

  /**
   * 两级增强：优先网关 LLM（config.promptLlm 配置的智谱/Ollama 等端点，理解语义、不冲突），
   * 未配置（501）或失败时回退内置规则引擎，来源标注在预览下方。
   * 图生图·编辑模式附带当前输入图，让视觉模型看着图写编辑指令；
   * 带图失败（模型不支持视觉/取图失败）自动去图重试一次，仍失败才回退规则。
   */
  async function runEnhance() {
    const src = textarea.value.trim();
    if (!src) { toast(t('输入框为空，先写点提示词')); return; }
    if (chosen === RULES_OPT) {
      const r = enhancePrompt({ text: src, profileKey, mode });
      preview.value = r.text;
      enhNotes.textContent = [t('来源：内置规则（已选择不使用 LLM）'), ...r.notes.map((n) => t(n))].join(t('；'));
      enhResult.hidden = false;
      return;
    }
    if (enhBtn) { enhBtn.disabled = true; enhBtn.textContent = '⏳ ' + t('增强中…'); }
    const img = mode === 'edit' ? currentInputImage() : null;
    const request = (image) => {
      const selected = modelChoices?.find((m) => m.key === chosen);
      return apiJson('/gw/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: src, mode, lang: promptLang(src),
          ...(selected ? { model: selected.model, route: selected.route } : {}),
          ...(image ? { image } : {}),
        }),
      });
    };
    let out = '';
    let notes = [];
    try {
      let r;
      try {
        r = await request(img);
      } catch (err) {
        if (!img) throw err;
        r = await request(null);
        notes.push(t('模型未能读取图片，已按纯文本增强'));
      }
      out = r.text;
      notes = [tf('来源：智能增强（{m}）', { m: r.name ?? r.model ?? 'LLM' }), ...notes];
      if (img && r.image && !notes.some((n) => n.includes(t('模型未能读取图片，已按纯文本增强')))) notes.push(t('已读取当前图片'));
    } catch (err) {
      const r = enhancePrompt({ text: src, profileKey, mode });
      out = r.text;
      notes = [t('来源：内置规则（网关未配置 LLM 或调用失败）'), ...r.notes.map((n) => t(n))];
      if (err?.status !== 501) toast(t('智能增强不可用，已用规则增强'));
    } finally {
      if (enhBtn) { enhBtn.disabled = false; enhBtn.textContent = '⚡ ' + t('增强'); }
    }
    preview.value = out;
    enhNotes.textContent = notes.join(t('；'));
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
        insertAtCursor(preview.value);
        toast(t('已追加'));
      },
    }),
    el('button', { class: 'btn small', text: '↻ ' + t('换一版'), onclick: () => runEnhance() }),
    el('button', {
      class: 'btn small', text: '⭐ ' + t('收藏此结果'),
      onclick: () => {
        toast(addFav(targetFolder(), preview.value) ? t('已收藏') : t('已在收藏中'));
        renderFavs();
      },
    }),
  );
  const enhResult = el('div', { hidden: true }, preview, enhNotes, actRow);

  // ---- 收藏区：分类折叠，点标题展开/收起 ----
  let target = '';

  /** 收藏落到的分类：优先下拉里选中的，其次第一个分类，都没有则用默认分类名。 */
  function targetFolder() {
    const list = folders();
    if (target && list.some((f) => f.name === target)) return target;
    return list[0]?.name ?? t(DEFAULT_FOLDER);
  }

  const favBtn = el('button', {
    class: 'btn small', text: '⭐ ' + t('收藏当前内容'),
    onclick: () => {
      if (!textarea.value.trim()) { toast(t('输入框为空，先写点内容再收藏')); return; }
      toast(addFav(targetFolder(), textarea.value) ? t('已收藏') : t('已在收藏中'));
      renderFavs();
    },
  });

  /** 收藏条目行：默认折叠只显示名称，点行展开正文（点正文插入光标处）；✎ 改名称，✕ 两段式删除。 */
  function favItem(item) {
    const open = openItems.has(item.text);
    const arrow = el('span', { text: open ? '▾' : '▸', style: { flex: 'none', fontSize: '11px' } });
    const name = el('span', {
      style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      text: item.name,
    });
    const row = el('div', {
      class: 'row',
      style: { alignItems: 'center', gap: '6px', padding: '7px 4px', cursor: 'pointer', borderBottom: '1px solid rgba(128, 128, 128, 0.15)' },
      onclick: () => {
        if (openItems.has(item.text)) openItems.delete(item.text);
        else openItems.add(item.text);
        renderFavs();
      },
    }, arrow, name);

    row.append(el('button', {
      class: 'btn tiny', text: '✎', title: t('重命名收藏'),
      onclick: (ev) => { ev.stopPropagation(); startItemRename(item, row); },
    }));
    if (folders().length > 1) {
      row.append(el('button', {
        class: 'btn tiny', text: '📁', title: t('移动到其它分类'),
        onclick: (ev) => { ev.stopPropagation(); openMovePicker(item); },
      }));
    }
    let armed = false;
    const del = el('span', { class: 'tag-del', text: '✕' });
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!armed) {
        armed = true;
        del.classList.add('armed');
        del.textContent = t('删除');
        setTimeout(() => {
          armed = false;
          del.classList.remove('armed');
          del.textContent = '✕';
        }, 3000);
        return;
      }
      removeFav(item.text);
      openItems.delete(item.text);
      toast(t('已删除'));
      renderFavs();
    });
    row.append(del);

    const box = el('div', {}, row);
    if (open) {
      box.append(el('div', {
        style: {
          fontSize: '12px', margin: '2px 4px 8px', padding: '8px 10px', borderRadius: '8px',
          background: 'rgba(128, 128, 128, 0.08)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', cursor: 'pointer',
        },
        title: t('点击正文插入光标处'),
        text: item.text,
        onclick: (ev) => { ev.stopPropagation(); insertAtCursor(item.text); },
      }));
    }
    return box;
  }

  /** 原位改收藏名称：行内换成输入框 + ✓/✕（点击不冒泡触发展开）。 */
  function startItemRename(item, row) {
    const input = el('input', {
      type: 'text', value: item.name, style: { flex: '1' },
      onclick: (ev) => ev.stopPropagation(),
      onkeydown: (ev) => { if (ev.key === 'Enter') commit(); },
    });
    const commit = () => {
      const name = input.value.trim();
      if (name && name !== item.name) {
        const list = folders();
        for (const f of list) { for (const i of f.items) { if (i.text === item.text) i.name = name; } }
        setFolders(list);
      }
      renderFavs();
    };
    row.replaceChildren(
      input,
      el('button', { class: 'btn tiny primary', text: '✓', onclick: (ev) => { ev.stopPropagation(); commit(); } }),
      el('button', { class: 'btn tiny', text: '✕', onclick: (ev) => { ev.stopPropagation(); renderFavs(); } }),
    );
    input.focus();
  }

  /** 移动收藏：临时换成分类列表，选完（或取消）再装回助手面板。 */
  function openMovePicker(item) {
    const others = folders().filter((f) => !f.items.some((i) => i.text === item.text));
    const back = () => { showSheet(content); renderFavs(); };
    showSheet(el('div', {},
      el('h3', { text: t('把这条收藏移动到？') }),
      ...others.map((f) => el('button', {
        class: 'btn', style: { width: '100%', marginBottom: '6px', justifyContent: 'flex-start' },
        text: `📁 ${f.name} (${f.items.length})`,
        onclick: () => {
          back();
          if (moveFav(item.text, f.name)) toast(tf('已移动到「{f}」', { f: f.name }));
          renderFavs();
        },
      })),
      el('button', { class: 'btn', style: { width: '100%' }, text: t('取消'), onclick: back }),
    ));
  }

  /** 分类标题行：▸/▾ + 名称 + 数量 + 重命名/删除（两段式确认）。 */
  function folderHead(folder) {
    const open = expanded.has(folder.name);
    const arrow = el('span', { text: open ? '▾' : '▸', style: { flex: 'none' } });
    const title = el('span', {
      style: { flex: '1', fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      text: `${folder.name} (${folder.items.length})`,
    });
    const head = el('div', {
      class: 'row',
      style: { alignItems: 'center', gap: '6px', padding: '8px 2px', cursor: 'pointer' },
      onclick: () => {
        if (expanded.has(folder.name)) expanded.delete(folder.name);
        else expanded.add(folder.name);
        renderFavs();
      },
    }, arrow, title);

    const renameBtn = el('button', {
      class: 'btn tiny', text: '✎', title: t('重命名分类'),
      onclick: (ev) => { ev.stopPropagation(); startRename(folder, head); },
    });
    let delArmed = false;
    const delBtn = el('button', {
      class: 'btn tiny', text: '🗑', title: t('删除分类（含其中收藏）'),
      onclick: (ev) => {
        ev.stopPropagation();
        if (!delArmed) {
          delArmed = true;
          delBtn.textContent = t('确认');
          setTimeout(() => { delArmed = false; delBtn.textContent = '🗑'; }, 3000);
          return;
        }
        const list = folders();
        setFolders(list.filter((f) => f.name !== folder.name));
        expanded.delete(folder.name);
        if (target === folder.name) target = '';
        toast(t('已删除'));
        renderFavs();
      },
    });
    head.append(renameBtn, delBtn);
    return head;
  }

  /** 原位重命名：标题行换成输入框 + ✓/✕（点击不冒泡触发分类展开）。 */
  function startRename(folder, head) {
    const input = el('input', {
      type: 'text', value: folder.name, style: { flex: '1' },
      onclick: (ev) => ev.stopPropagation(),
    });
    const commit = () => {
      const name = input.value.trim();
      if (!name || name === folder.name) { renderFavs(); return; }
      const list = folders();
      if (list.some((f) => f.name === name)) { toast(t('已有同名分类')); renderFavs(); return; }
      const target0 = list.find((f) => f.name === folder.name);
      target0.name = name;
      setFolders(list);
      if (expanded.delete(folder.name)) expanded.add(name);
      if (target === folder.name) target = name;
      renderFavs();
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(); });
    head.replaceChildren(
      input,
      el('button', { class: 'btn tiny primary', text: '✓', onclick: (ev) => { ev.stopPropagation(); commit(); } }),
      el('button', { class: 'btn tiny', text: '✕', onclick: (ev) => { ev.stopPropagation(); renderFavs(); } }),
    );
    input.focus();
  }

  /** 新建分类输入行（点「＋新建分类」出现）。 */
  function newFolderRow() {
    const input = el('input', {
      type: 'text', placeholder: t('分类名'), style: { flex: '1' },
      onkeydown: (ev) => { if (ev.key === 'Enter') commit(); },
    });
    const commit = () => {
      const name = input.value.trim();
      if (!name) { renderFavs(); return; }
      const list = folders();
      if (list.some((f) => f.name === name)) { toast(t('已有同名分类')); return; }
      list.push({ name, items: [] });
      setFolders(list);
      target = name;
      expanded.add(name);
      renderFavs();
    };
    return el('div', { class: 'row', style: { gap: '6px', marginTop: '8px' } },
      input,
      el('button', { class: 'btn tiny primary', text: '✓ ' + t('确定'), onclick: commit }),
      el('button', { class: 'btn tiny', text: t('取消'), onclick: () => renderFavs() }),
    );
  }

  let creating = false;

  function renderFavs() {
    const list = folders();
    const total = totalItems(list);
    while (favWrap.firstChild) favWrap.firstChild.remove();
    const sel = el('select', {
      style: { flex: '1', maxWidth: '220px' },
      onchange: () => { target = sel.value; },
    });
    if (list.length) {
      sel.replaceChildren(...list.map((f) => el('option', { value: f.name, text: f.name })));
      sel.value = targetFolder();
      target = sel.value;
    }
    favWrap.append(
      el('div', { class: 'row', style: { alignItems: 'center', gap: '6px', marginBottom: '6px' } },
        el('span', { style: { fontWeight: '600' }, text: `⭐ ${t('我的收藏')} (${total})` }),
        el('span', { class: 'muted', style: { fontSize: '11px', flex: 'none' }, text: t('收藏到') }),
        sel,
        el('button', {
          class: 'btn tiny', text: '＋ ' + t('新建分类'),
          onclick: () => { creating = true; renderFavs(); },
        }),
      ),
    );
    if (creating) {
      favWrap.append(newFolderRow());
      creating = false;
    }
    if (!list.length) {
      favWrap.append(el('div', { class: 'muted', style: { fontSize: '11px' }, text: t('还没有收藏，点右上「收藏当前内容」') }));
      return;
    }
    for (const folder of list) {
      favWrap.append(folderHead(folder));
      if (!expanded.has(folder.name)) continue;
      if (!folder.items.length) {
        favWrap.append(el('div', { class: 'muted', style: { fontSize: '11px', padding: '2px' }, text: t('该分类暂无收藏') }));
        continue;
      }
      const box = el('div', { style: { marginBottom: '6px' } });
      for (const i of folder.items) box.append(favItem(i));
      favWrap.append(box);
    }
  }

  const content = el('div', {},
    el('div', { class: 'row', style: { alignItems: 'center', marginBottom: '12px' } },
      el('h3', { style: { margin: 0, flex: 1 }, text: t('提示词助手') }),
      favBtn,
    ),
    // 增强区：与下方收藏区用虚线分隔；模式选择带标签，行间留出呼吸感
    el('div', { class: 'enh-sec' },
      el('div', { class: 'row', style: { alignItems: 'center', gap: '6px', marginBottom: '10px' } },
        enhBtn = el('button', { class: 'btn small primary', text: '⚡ ' + t('增强'), onclick: () => runEnhance() }),
        el('span', {
          class: 'muted', style: { fontSize: '11px', flex: '1' },
          title: t('根据当前工作流与表单中的模型选择自动识别'),
          text: tf('模型：{m}', { m: profileLabel }),
        }),
      ),
      el('div', { class: 'row', style: { alignItems: 'center', gap: '8px' } },
        el('span', { class: 'muted', style: { fontSize: '11px', flex: 'none' }, text: t('模式') }),
        modeChips,
      ),
      imgHint,
      modelRow,
      enhResult,
    ),
    favWrap,
  );

  renderFavs();
  // 悬浮抽屉打开，但顶缘锚定在输入框下方，不再贴屏幕底（编辑时与提示词同屏）
  showSheet(content, { anchor });
}
