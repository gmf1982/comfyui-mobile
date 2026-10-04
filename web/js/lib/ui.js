/**
 * DOM 工具：元素构造、Toast、底部抽屉、全屏遮罩、通用字段编辑器。
 */
import { apiJson, invalidateSchemaCache, fetchFreshSchema } from './api.js';
import { inputMediaUrl } from './media.js';
import { schemaInputDef, comboOptions } from './workflow-form.js';
import { state, wfParamsKey } from './state.js';
import { t, tf } from './i18n.js';
import { attachTextHistory } from './text-history.js';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/**
 * 构造一个"打开文件选择器"的按钮。
 * 用 <label for> 建立原生关联，同时显式调用 input.click()：
 * —— <button> 不转发点击，<label> 在个别 WebView 上也需要显式触发，两者都留才稳。
 * @param {string} className 按钮样式类
 * @param {string} text 按钮文案
 * @param {HTMLInputElement} input 目标文件输入（需已设置 id 并在文档中）
 */
export function fileTrigger(className, text, input) {
  const label = el('label', { class: className, for: input.id, text });
  label.addEventListener('click', (ev) => {
    ev.preventDefault();
    input.click();
  });
  return label;
}

let toastTimer = null;
export function toast(message, ms = 2600) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), ms);
}

/**
 * 抽屉顶部下拉手柄：点按收起；按住向下拖过阈值松手也收起，不足则回弹。
 * @param {HTMLElement} sheet 抽屉容器（拖拽时跟随平移）
 */
function buildSheetGrab(sheet) {
  const grab = el('button', {
    class: 'sheet-grab', type: 'button', title: t('收起'), 'aria-label': t('收起'),
    html: '<svg viewBox="0 0 28 16" width="28" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3.5 14 12.5 25 3.5"/></svg>',
  });
  let activeId = null, startY = 0, dy = 0, moved = false;
  grab.addEventListener('pointerdown', (ev) => {
    if (activeId !== null) return;
    activeId = ev.pointerId; startY = ev.clientY; dy = 0; moved = false;
    try {
      grab.setPointerCapture(ev.pointerId);
    } catch {
      // 指针已失效（自动化合成事件等）时捕获失败：仅拖出手柄后不跟手，点按与拖拽判定不受影响
    }
    sheet.style.transition = 'none';
  });
  grab.addEventListener('contextmenu', (ev) => ev.preventDefault()); // 长按拖拽不弹系统菜单
  grab.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== activeId) return;
    dy = Math.max(0, ev.clientY - startY);
    if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
  });
  const release = (ev) => {
    if (ev.pointerId !== activeId) return;
    activeId = null;
    moved = dy > 8;
    const dismiss = dy > Math.max(72, sheet.offsetHeight * 0.2);
    sheet.style.transition = `transform ${dismiss ? 0.16 : 0.22}s ease`;
    sheet.style.transform = dismiss ? 'translateY(100%)' : '';
    if (dismiss) setTimeout(hideSheet, 170);
  };
  grab.addEventListener('pointerup', release);
  grab.addEventListener('pointercancel', release);
  grab.addEventListener('click', () => {
    if (moved) { moved = false; return; } // 拖拽松手处补发的 click 不算点按；复位让键盘 Enter 再次可用
    hideSheet();
  });
  return grab;
}

/** 底部抽屉（选择操作/编辑节点参数）。 */
export function showSheet(content) {
  const sheet = document.getElementById('sheet');
  const backdrop = document.getElementById('sheet-backdrop');
  clear(sheet);
  sheet.append(buildSheetGrab(sheet), content);
  sheet.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  backdrop.onclick = hideSheet;
  // 节点图等在 pointerup 里开层：同一次点按随后补发的 click 会落在层/遮罩上，
  // 造成秒关或误触层内首个按钮（如“重命名节点”）。开层后短时间内吞掉第一个 click。
  const openedAt = performance.now();
  const swallow = (ev) => {
    document.removeEventListener('click', swallow, true);
    if (performance.now() - openedAt <= 350) {
      ev.stopPropagation();
      ev.preventDefault();
    }
  };
  document.addEventListener('click', swallow, true);
}

export function hideSheet() {
  const sheet = document.getElementById('sheet');
  sheet.classList.add('hidden');
  sheet.style.transform = '';
  sheet.style.transition = '';
  document.getElementById('sheet-backdrop').classList.add('hidden');
}

/** 全屏遮罩（媒体详情）。返回关闭函数。 */
export function showOverlay(content) {
  const overlay = document.getElementById('overlay');
  clear(overlay);
  overlay.append(content);
  overlay.classList.remove('hidden');
  return hideOverlay;
}

export function hideOverlay() {
  document.getElementById('overlay').classList.add('hidden');
}

export function confirmDialog(message) {
  return new Promise((resolve) => {
    const sheet = el('div', {},
      el('h3', { text: t('确认操作') }),
      el('p', { text: message, style: { margin: '0 0 16px' } }),
      el('div', { class: 'row' },
        el('button', { class: 'btn grow', text: t('取消'), onclick: () => { hideSheet(); resolve(false); } }),
        el('button', { class: 'btn danger grow', text: t('确定'), onclick: () => { hideSheet(); resolve(true); } }),
      ),
    );
    showSheet(sheet);
  });
}

export function promptDialog(title, initial = '') {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value: initial, placeholder: title });
    const sheet = el('div', {},
      el('h3', { text: title }),
      el('div', { class: 'field' }, input),
      el('div', { class: 'row' },
        el('button', { class: 'btn grow', text: t('取消'), onclick: () => { hideSheet(); resolve(null); } }),
        el('button', {
          class: 'btn primary grow', text: t('确定'),
          onclick: () => { const v = input.value.trim(); hideSheet(); resolve(v || null); },
        }),
      ),
    );
    showSheet(sheet);
    setTimeout(() => input.focus(), 50);
  });
}

// ---------------- 字段编辑器 ----------------

const folderOptionsCache = new Map();

async function loadFolderOptions(folders) {
  const cacheKey = folders.join('|');
  if (folderOptionsCache.has(cacheKey)) return folderOptionsCache.get(cacheKey);
  for (const folder of folders) {
    try {
      const res = await apiJson(`/models/${encodeURIComponent(folder)}`);
      if (Array.isArray(res) && res.length) {
        folderOptionsCache.set(cacheKey, { options: res, folder });
        return { options: res, folder };
      }
    } catch {
      // 尝试下一个候选目录
    }
  }
  folderOptionsCache.set(cacheKey, { options: [], folder: folders[0] });
  return { options: [], folder: folders[0] };
}

/** 清会话缓存重拉模型列表（下拉「刷新列表」用）；网关对 JSON 统一 no-store，重取即磁盘最新。 */
export async function refreshFolderOptions(folders) {
  folderOptionsCache.delete(folders.join('|'));
  return loadFolderOptions(folders);
}

/**
 * 渲染单个参数控件。
 * @param {object} field buildFormModel 产出的字段
 * @param {(key: string, value: unknown) => void} onChange 值变更回调
 * @returns {HTMLElement}
 */
export function fieldEditor(field, onChange) {
  const wrap = el('div', { class: 'field' });

  if (field.kind === 'media') {
    // 媒体输入：值显示 + 缩略图选择器（图片带缩略图，长按预览大图）
    const acceptMap = { image: 'image/*', video: 'video/*', audio: 'audio/*' };
    const mediaLabel = { image: t('图片'), video: t('视频'), audio: t('音频') }[field.mediaKind] ?? t('文件');
    let current = field.value ?? '';
    const options = [...(field.options ?? [])];
    const pickerState = { compressedNote: '' };

    const valueBtn = el('button', {
      class: 'btn media-value', style: { width: '100%', justifyContent: 'space-between', textAlign: 'left' },
    }, el('span', { class: 'grow ellipsis', text: current ? current : t('选择') + mediaLabel + t('…') }), el('span', { class: 'muted', text: '▾' }));
    valueBtn.addEventListener('click', () => openPicker());

    const info = el('div', { class: 'muted', style: { minHeight: '1.2em', marginTop: '4px' } });
    const status = el('div', { class: 'muted', style: { minHeight: '1.2em' } });

    const setValue = (name) => {
      current = name;
      valueBtn.querySelector('span').textContent = name || ('选择' + mediaLabel + '…');
      onChange(field.key, name);
    };

    // 隐藏的相册/拍照输入（iOS 安全隐藏；标签 for 关联，避免双重弹窗）
    const mkInput = (id, capture) => {
      const input = el('input', {
        type: 'file', accept: acceptMap[field.mediaKind] ?? '*/*',
        style: { position: 'absolute', width: '1px', height: '1px', opacity: '0', overflow: 'hidden', left: '-9999px' },
      });
      input.id = id;
      if (capture) input.setAttribute('capture', 'environment');
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        await doUpload(file);
        input.value = '';
      });
      return input;
    };
    const albumInput = mkInput('upload-' + field.key, false);
    const camInput = field.mediaKind === 'image' ? mkInput('cam-' + field.key, true) : null;

    async function doUpload(file) {
      const { uploadMedia } = await import('./api.js');
      const { humanSize } = await import('./media.js');
      const compressOn = state.settings.compressUpload !== false;
      let lastProgress = '';
      status.textContent = compressOn ? (t('压缩并上传 ') + file.name + t('…')) : (t('上传 ') + file.name + t('…'));
      try {
        const res = await uploadMedia(file, {
          compress: compressOn,
          maxDim: state.settings.uploadMaxDim ?? 2048,
          targetMB: state.settings.uploadTargetMB ?? 0.9,
          onProgress: (sent, total) => {
            if (!total) {
              lastProgress = '压缩中…';
            } else {
              lastProgress = humanSize(total) + ' · 上传 ' + Math.round((sent / total) * 100) + '%';
            }
            status.textContent = lastProgress;
          },
        });
        const note = res.compressed
          ? humanSize(res.originalSize) + ' → ' + humanSize(res.size) + '（已压缩）'
          : humanSize(res.size);
        if (!options.includes(res.name)) options.unshift(res.name);
        setValue(res.name);
        status.textContent = t('✓ 上传完成 · ') + note;
      } catch (err) {
        status.textContent = t('上传失败：') + err.message;
        toast(t('上传失败：') + err.message);
      }
    }

    /** 缩略图网格选择器：点选、长按预览 500px 大图、排序（最新/名称）、删除文件。 */
    async function openPicker() {
      const grid = el('div', { class: 'media-grid' });
      const toolbarRow = el('div', { class: 'row wrap', style: { marginBottom: '8px' } });
      const search = el('input', { type: 'text', placeholder: t('搜索文件名…'), style: { marginBottom: '8px' } });
      const sheet = el('div', {},
        el('h3', { text: field.label }),
        search,
        toolbarRow,
        grid,
        status,
      );
      // 排序：默认按最新时间（依赖网关 /gw/input-files 的 mtime；不可用时退化为按名称）
      const sortState = { mode: 'time' };
      let mtimeMap = null;
      let deletable = false;
      /** 本次会话已删除的文件（就地置灰标记，不重排列表；点「刷新列表」才真正更新） */
      const deletedNames = new Set();

      async function loadInputIndex() {
        try {
          const data = await apiJson('/gw/input-files');
          mtimeMap = new Map((data.files ?? []).map((f) => [f.name, f.mtime]));
          deletable = true;
        } catch {
          mtimeMap = null;
          deletable = false;
        }
      }

      const sortChips = {};
      function renderSortChips() {
        for (const [mode, btn] of Object.entries(sortChips)) {
          btn.classList.toggle('active', sortState.mode === mode);
        }
      }
      sortChips.time = el('button', { class: 'chip', text: t('🕐 最新'), onclick: () => { sortState.mode = 'time'; renderSortChips(); renderGrid(); } });
      sortChips.name = el('button', { class: 'chip', text: t('🔤 名称'), onclick: () => { sortState.mode = 'name'; renderSortChips(); renderGrid(); } });

      const refreshBtn = el('button', { class: 'btn small', text: t('↻ 刷新列表') });
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.textContent = t('刷新中…');
        deletedNames.clear();
        try {
          const { fetchFreshSchema } = await import('./api.js');
          const schema = await fetchFreshSchema(field.classType);
          if (schema) {
            const def = schemaInputDef(schema, field.inputName);
            const fresh = comboOptions(def) ?? [];
            options.length = 0;
            options.push(...fresh);
          }
          await loadInputIndex();
          renderGrid();
          refreshBtn.textContent = t('↻ 刷新列表');
          toast(tf('已刷新（{n} 个文件）', { n: options.length }));
        } catch (err) {
          refreshBtn.textContent = t('↻ 刷新列表');
          toast(t('刷新失败：') + err.message);
        }
      });
      toolbarRow.append(fileTrigger('btn small primary', t('⬆ 上传') + mediaLabel, albumInput));
      if (camInput) toolbarRow.append(fileTrigger('btn small', t('📷 拍照'), camInput));
      toolbarRow.append(refreshBtn, sortChips.time, sortChips.name);

      /**
       * 从 input 目录删除文件（网关侧限该目录子树）。
       * 与图库删除同一套逻辑：只把格子就地置灰标记，不重排列表，可连续删多张；
       * 点「↻ 刷新列表」才真正移除格子并刷新 schema 缓存。
       * 确认用两段式（✕ 点一次变红、再点确认）：不用确认弹窗，否则会顶掉选择器面板。
       */
      async function deleteInputFile(name) {
        if (deletedNames.has(name)) return;
        try {
          await apiJson(`/gw/input-file?filename=${encodeURIComponent(name)}`, { method: 'DELETE' });
          deletedNames.add(name);
          invalidateSchemaCache();
          for (const cell of grid.querySelectorAll('.media-cell')) {
            if (cell.dataset.name === name) {
              cell.classList.add('deleted');
              const badge = cell.querySelector('.media-cell-del');
              if (badge) badge.remove();
            }
          }
          if (current === name) {
            setValue('');
            status.textContent = t('已删除当前选中的文件，请重新选择');
          }
          toast(tf('已删除 {n} 项，可继续删除，点「刷新列表」更新', { n: deletedNames.size }));
        } catch (err) {
          toast(t('删除失败：') + err.message);
        }
      }

      function renderGrid() {
        grid.replaceChildren();
        const q = search.value.trim().toLowerCase();
        let list = options.filter((o) => !q || o.toLowerCase().includes(q));
        if (sortState.mode === 'time' && mtimeMap) {
          // 最新在前；没有时间信息的文件排在最后（按名称）
          list = list.slice().sort((a, b) => (mtimeMap.get(b) ?? -1) - (mtimeMap.get(a) ?? -1) || a.localeCompare(b));
        } else {
          list = list.slice().sort((a, b) => a.localeCompare(b));
        }
        if (!list.length) {
          grid.append(el('div', { class: 'muted', text: t('没有匹配的文件，可点上方上传') }));
          return;
        }
        for (const name of list) {
          const isCurrent = name === current;
          const isDeleted = deletedNames.has(name);
          const cell = el('button', { class: 'media-cell' + (isCurrent ? ' current' : '') + (isDeleted ? ' deleted' : '') });
          cell.dataset.name = name;
          const thumbBox = el('div', { class: 'media-thumb' });
          if (field.mediaKind === 'image') {
            // 224px/q40 实测 ≈10KB/张：选择器一次渲染几十个磁贴，用小尺寸控流量（大图看长按预览）
            thumbBox.append(el('img', { loading: 'lazy', decoding: 'async', src: inputMediaUrl(name, '', 40, 224, mtimeMap?.get(name) ?? null), alt: name }));
          } else if (field.mediaKind === 'video') {
            thumbBox.append(el('span', { class: 'tile-ico', text: '🎬' }));
            thumbBox.append(el('video', { loading: 'lazy', preload: 'metadata', muted: '', playsinline: '', src: inputMediaUrl(name, '', null, null, mtimeMap?.get(name) ?? null) + '#t=0.1' }));
          } else {
            thumbBox.append(el('span', { class: 'tile-ico', text: '🎵' }));
          }
          cell.append(thumbBox, el('div', { class: 'media-name', text: name }));
          if (deletable && mtimeMap?.has(name) && !isDeleted) {
            // 右上角小删除钮：span 而非 button（button 内不得嵌套 button），pointerdown 不冒泡以免触发长按预览。
            // 两段式确认：点一下 ✕ 原位弹出「删除」，再点「删除」才删（不用弹窗，避免顶掉选择器面板）。
            const delBtn = el('span', { class: 'media-cell-del', role: 'button', title: t('删除该文件'), text: '✕' });
            delBtn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
            let armed = false;
            let disarmTimer = null;
            const disarm = () => {
              armed = false;
              clearTimeout(disarmTimer);
              delBtn.classList.remove('armed');
              delBtn.textContent = '✕';
            };
            delBtn.addEventListener('click', (ev) => {
              ev.stopPropagation();
              if (!armed) {
                armed = true;
                delBtn.classList.add('armed');
                delBtn.textContent = t('删除');
                disarmTimer = setTimeout(disarm, 3000);
                return;
              }
              disarm();
              deleteInputFile(name);
            });
            cell.append(delBtn);
          }
          // 长按预览（500px），松手消失；短按选中
          let pressTimer = null;
          let previewOpen = false;
          let suppressClick = false;
          const startPress = () => {
            pressTimer = setTimeout(() => {
              previewOpen = true;
              suppressClick = true;
              showQuickPreview(name, field.mediaKind, mtimeMap?.get(name) ?? null);
              // 预览出现后手指事件可能不再派发给原格子（触屏长按/轻微移动），
              // 在 window 上兜底：任意位置松手或取消都关闭预览
              const dismiss = () => {
                previewOpen = false;
                hideQuickPreview();
                setTimeout(() => { suppressClick = false; }, 350);
              };
              window.addEventListener('pointerup', dismiss, { once: true });
              window.addEventListener('pointercancel', dismiss, { once: true });
            }, 380);
          };
          const cancelPress = () => {
            clearTimeout(pressTimer);
            pressTimer = null;
            if (previewOpen) {
              previewOpen = false;
              hideQuickPreview();
            }
          };
          cell.addEventListener('pointerdown', startPress);
          cell.addEventListener('pointerup', cancelPress);
          cell.addEventListener('pointercancel', cancelPress);
          cell.addEventListener('pointerleave', cancelPress);
          cell.addEventListener('click', (ev) => {
            if (previewOpen || suppressClick) { ev.preventDefault(); return; }
            setValue(name);
            hideSheet();
          });
          grid.append(cell);
        }
      }
      search.addEventListener('input', renderGrid);
      renderGrid();
      showSheet(sheet);
      loadInputIndex().then(() => renderGrid());
    }

    // 字段下方直接可见的上传/拍照按钮。
    // 注意：<button> 不会把点击转发给内部 input，必须用 <label for>（原生关联）
    // 配合显式 click()——两者缺一在部分手机浏览器上会“点了没反应”。
    const btnRow = el('div', { class: 'row wrap', style: { marginTop: '6px' } });
    btnRow.append(fileTrigger('btn small', t('⬆ 上传') + mediaLabel, albumInput));
    if (camInput) btnRow.append(fileTrigger('btn small', t('📷 拍照'), camInput));

    // 隐藏 input 必须挂进 DOM：label 的 for 关联与显式 click() 都依赖它在文档中
    wrap.append(el('label', { text: field.label }), valueBtn, btnRow, albumInput, camInput ?? null, info);
    return wrap;
  }

  if (field.kind === 'image-upload') {
    const label = el('label', { text: field.label + t('（点击上传图片）') });
    const info = el('div', { class: 'muted', text: field.value ? t('当前：') + field.value : t('未选择') });
    const input = el('input', {
      type: 'file', accept: 'image/*',
      style: { position: 'absolute', width: '1px', height: '1px', opacity: '0', overflow: 'hidden', left: '-9999px' },
    });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      info.textContent = t('上传中…');
      try {
        const { uploadMedia } = await import('./api.js');
        const res = await uploadMedia(file);
        onChange(field.key, res.name);
        info.textContent = t('当前：') + res.name;
      } catch (err) {
        info.textContent = field.value ? t('当前：') + field.value : t('未选择');
        toast(`上传失败：${err.message}`);
      }
    });
    const btn = el('button', { class: 'btn small', text: t('选择图片 / 拍照') }, input);
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      input.click();
    });
    wrap.append(label, info, btn);
    return wrap;
  }

  wrap.append(el('label', { text: field.label }));

  switch (field.kind) {
    case 'textarea': {
      const ta = el('textarea', { rows: '4', placeholder: t('输入提示词…') });
      ta.value = field.value ?? '';
      ta.addEventListener('input', () => onChange(field.key, ta.value));
      // 撤销/重做：按「工作流:字段」登记历史，运行页整页重建（切页签/返回）后接回原历史
      // 继续撤销；无字段 key 的调用方（节点编辑器）与临时工作流退化为元素私有历史
      const undoBtn = el('button', { class: 'btn tiny', title: t('撤销输入'), text: '↶' });
      const redoBtn = el('button', { class: 'btn tiny', title: t('恢复输入'), text: '↷' });
      const wfKey = wfParamsKey(state.workflow);
      const histKey = field.key && wfKey ? `${wfKey}:${field.key}` : null;
      const hist = attachTextHistory(ta, { key: histKey, onStateChange: syncHistBtns });
      const step = (fn) => { fn(); ta.focus(); };
      undoBtn.addEventListener('click', () => step(hist.undo));
      redoBtn.addEventListener('click', () => step(hist.redo));
      function syncHistBtns() {
        undoBtn.disabled = !hist.canUndo();
        redoBtn.disabled = !hist.canRedo();
      }
      syncHistBtns();
      // 内置提示词助手：按钮与标签同行（label 无 for 关联，点文字不会误触按钮）。
      // el() 会把 label 从 wrap 挪进 headRow（append 即移动），所以这里只需把 headRow 追加回 wrap。
      const label = wrap.querySelector('label');
      const headRow = el('div', { class: 'field-head' }, label,
        el('div', { class: 'row', style: { flex: 'none', gap: '6px' } },
          undoBtn, redoBtn,
          el('button', {
            class: 'btn tiny', title: t('提示词助手'), text: '✨ ' + t('助手'),
            onclick: async () => {
              const { openPromptAssistant } = await import('./prompt-assistant.js');
              openPromptAssistant(ta);
            },
          })));
      wrap.append(headRow);
      wrap.append(ta);
      break;
    }
    case 'text': {
      const input = el('input', { type: 'text' });
      input.value = field.value ?? '';
      input.addEventListener('input', () => onChange(field.key, input.value));
      wrap.append(input);
      break;
    }
    case 'int':
    case 'float':
    case 'seed': {
      const row = el('div', { class: 'row' });
      const input = el('input', {
        type: 'number',
        inputmode: field.kind === 'float' ? 'decimal' : 'numeric',
        step: field.step ?? (field.kind === 'int' ? '1' : 'any'),
        style: { flex: '1' },
      });
      if (field.min != null) input.min = field.min;
      if (field.max != null) input.max = field.max;
      input.value = field.value ?? '';
      input.addEventListener('input', () => onChange(field.key, input.value));
      row.append(input);
      if (field.kind === 'seed') {
        row.append(el('button', {
          class: 'icon-btn', title: t('随机种子'), text: '🎲',
          onclick: () => {
            const v = String(Math.floor(Math.random() * 2 ** 48));
            input.value = v;
            onChange(field.key, v);
          },
        }));
      }
      wrap.append(row);
      break;
    }
    case 'toggle': {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = Boolean(field.value);
      cb.addEventListener('change', () => onChange(field.key, cb.checked));
      cb.style.width = '22px';
      cb.style.height = '22px';
      wrap.append(cb);
      break;
    }
    case 'combo':
    case 'sampler':
    case 'scheduler':
    case 'model': {
      const isModel = field.kind === 'model';
      let allOptions = isModel ? [] : (field.options ?? []).map(String);
      let current = String(field.value ?? '');
      const refreshOptions = async () => {
        if (isModel) {
          allOptions = (await refreshFolderOptions(field.folders)).options.map(String);
        } else if (field.classType) {
          const schema = await fetchFreshSchema(field.classType);
          const opts = comboOptions(schemaInputDef(schema, field.inputName));
          if (opts?.length) allOptions = opts.map(String);
        }
      };
      // 长列表（模型类、≥12 项的 combo）用「值按钮 + 底部抽屉」：搜索框在抽屉顶部、输入即过滤；
      // 短列表保留原生 select（系统弹层两下点完，最快）。
      if (!isModel && allOptions.length < 12) {
        const select = el('select');
        select.append(el('option', { value: current, text: current + t('（当前）') }));
        for (const opt of allOptions) {
          select.append(el('option', { value: opt, text: opt }));
        }
        if (current) select.value = current;
        else select.selectedIndex = 0;
        select.addEventListener('change', () => onChange(field.key, select.value));
        wrap.append(select);
        break;
      }
      const valueBtn = el('button', {
        class: 'btn media-value', style: { width: '100%', justifyContent: 'space-between', textAlign: 'left' },
      }, el('span', { class: 'grow ellipsis', text: current || (t('选择') + '…') }), el('span', { class: 'muted', text: '▾' }));
      valueBtn.addEventListener('click', () => {
        const search = el('input', { type: 'text', class: 'grow', placeholder: t('搜索…') });
        const list = el('div', { class: 'combo-list' });
        const renderList = () => {
          const kw = search.value.trim().toLowerCase();
          const visible = kw ? allOptions.filter((opt) => opt.toLowerCase().includes(kw)) : allOptions;
          clear(list);
          if (!visible.length) {
            list.append(el('div', { class: 'muted', style: { padding: '12px 2px' }, text: t('没有匹配的选项') }));
            return;
          }
          for (const opt of visible) {
            const row = el('button', {
              class: 'btn combo-option' + (opt === current ? ' current' : ''),
              style: { width: '100%', justifyContent: 'flex-start', textAlign: 'left' },
              text: opt === current ? `✓ ${opt}` : opt,
            });
            row.addEventListener('click', () => {
              current = opt;
              valueBtn.querySelector('span').textContent = opt;
              onChange(field.key, opt);
              hideSheet();
            });
            list.append(row);
          }
        };
        search.addEventListener('input', renderList);
        const head = el('div', { class: 'row', style: { marginBottom: '8px' } }, search);
        if (isModel || field.classType) {
          const refreshBtn = el('button', { class: 'btn small', text: t('↻ 刷新列表') });
          refreshBtn.addEventListener('click', async () => {
            refreshBtn.disabled = true;
            refreshBtn.textContent = t('刷新中…');
            try {
              await refreshOptions();
              renderList();
            } catch (err) {
              toast(t('刷新失败：') + err.message);
            } finally {
              refreshBtn.disabled = false;
              refreshBtn.textContent = t('↻ 刷新列表');
            }
          });
          head.append(refreshBtn);
        }
        renderList();
        showSheet(el('div', {},
          el('h3', { text: field.label }),
          head,
          list,
        ));
        setTimeout(() => search.focus(), 50);
      });
      if (isModel) {
        // 列表未就绪先禁用（loadFolderOptions 不 reject；空列表时抽屉内可用「刷新列表」重试）
        valueBtn.disabled = true;
        loadFolderOptions(field.folders).then(({ options }) => {
          allOptions = options.map(String);
          valueBtn.disabled = false;
        });
      }
      wrap.append(valueBtn);
      break;
    }
    default: {
      wrap.append(el('div', { class: 'muted', text: t('暂不支持的控件类型：') + field.kind }));
    }
  }
  return wrap;
}

let quickPreviewEl = null;

/** 长按预览：最大边 500px 的浮层，松手即消失。 */
export function showQuickPreview(name, kind, version = null) {
  hideQuickPreview();
  const box = el('div', { class: 'quick-preview' });
  if (kind === 'image') {
    // 浮层最大 500px：512px 缩略图足够，不必拉原图
    box.append(el('img', { src: inputMediaUrl(name, '', 80, 512, version), alt: name }));
  } else if (kind === 'video') {
    box.append(el('video', { src: inputMediaUrl(name, '', null, null, version), autoplay: '', muted: '', playsinline: '' }));
  } else {
    box.append(el('audio', { src: inputMediaUrl(name, '', null, null, version), controls: '' }));
  }
  box.append(el('div', { class: 'quick-preview-name', text: name }));
  document.body.append(box);
  quickPreviewEl = box;
}

export function hideQuickPreview() {
  quickPreviewEl?.remove();
  quickPreviewEl = null;
}
