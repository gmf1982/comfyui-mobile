/** 快速运行视图：表单模式（主参数 + 高级参数 + JSON 兜底），提交 /prompt。 */
import { apiJson, ensureSchemas, CLIENT_ID } from '../lib/api.js';
import { el, clear, toast, confirmDialog, promptDialog, fieldEditor } from '../lib/ui.js';
import { buildFormModel, applyFormModel, detectFormat, listApiNodes, schemaInputDef, comboOptions, buildRunLayout, heroRowTitle, fillSocketlessInputs } from '../lib/workflow-form.js';
import { t, tf } from '../lib/i18n.js';
import { state, setWorkflow, resetRunStats, markPendingRun, isFavorite, toggleFavorite, saveSettings, loadLayoutUnits, saveLayoutUnits, openWorkflows, addOpenWorkflow, removeOpenWorkflow, loadWorkflowParams, saveWorkflowParam, clearWorkflowParams, migrateWorkflowParams } from '../lib/state.js';
import { loadWorkflowFromPath } from './workflows.js';
import { apiToUi } from '../lib/graph.js';

let cachedSchemas = {};

export async function runView(container) {
  const wfState = state.workflow;
  if (!wfState) {
    container.append(
      el('div', { class: 'empty' },
        el('div', { class: 'big', text: '▶️' }),
        el('div', { text: t('尚未打开工作流') }),
        el('button', { class: 'btn primary', style: { marginTop: '14px' }, text: t('去选择工作流'), onclick: () => { location.hash = '/workflows'; } }),
      ),
    );
    return;
  }

  if (detectFormat(wfState.json) !== 'api') {
    container.append(el('div', { class: 'card error-card' },
      el('h3', { text: t('不支持的格式') }),
      el('p', { class: 'muted', text: t('该文件不是 API 格式工作流。请在桌面端 ComfyUI 用菜单 Workflow → Export (API) 导出后重新打开。') }),
    ));
    return;
  }

  // 多开下拉：列出已打开的工作流（最近使用在前），切换即载入；无 path 的当前项（模板/历史参数）以临时项显示
  const openList = openWorkflows();
  const wfSelect = el('select', { class: 'wf-switcher', title: t('切换已打开的工作流') });
  if (!wfState.path) {
    wfSelect.append(el('option', { value: '', text: `${wfState.name}${t('（未保存）')}` }));
  }
  for (const entry of openList) {
    wfSelect.append(el('option', { value: entry.path, text: entry.name }));
  }
  if (wfState.path) wfSelect.value = wfState.path;
  wfSelect.addEventListener('change', async () => {
    const p = wfSelect.value;
    if (!p) return;
    toast(t('正在切换…'));
    const ok = await loadWorkflowFromPath(p, { navigate: false });
    if (!ok) { wfSelect.value = wfState.path ?? ''; return; }
    rerenderRun();
  });
  const closeBtn = el('button', {
    class: 'icon-btn', title: t('关闭当前工作流（从多开列表移除）'), text: '✕',
    onclick: async () => {
      if (!wfState.path) { toast(t('该工作流尚未保存，无打开列表可关闭')); return; }
      removeOpenWorkflow(wfState.path);
      clearWorkflowParams(wfState); // 关闭即丢弃该工作流未保存的表单参数
      removeOpenWorkflow(wfState.path);
      const rest = openWorkflows();
      if (rest[0]) await loadWorkflowFromPath(rest[0].path, { navigate: false });
      else setWorkflow(null);
      rerenderRun();
    },
  });
  if (!openList.length || !wfState.path) closeBtn.style.display = 'none';

  const root = el('div', {});
  container.append(
    el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('div', { class: 'grow' },
          wfSelect,
          el('div', { class: 'muted', text: tf('{n} 个节点', { n: listApiNodes(wfState.json).length }) + (wfState.sourceFormat === 'ui' ? t(' · 由 UI 格式转换') : '') }),
        ),
        wfState.path ? el('button', {
          class: 'icon-btn star' + (isFavorite(wfState.path) ? ' on' : ''),
          title: t('收藏该工作流'),
          text: isFavorite(wfState.path) ? '★' : '☆',
          onclick: (ev) => {
            const on = toggleFavorite(wfState.path);
            ev.currentTarget.textContent = on ? '★' : '☆';
            ev.currentTarget.classList.toggle('on', on);
            toast(on ? t('已收藏，可在工作流页置顶找到') : t('已取消收藏'));
          },
        }) : null,
        closeBtn,
        el('button', { class: 'btn small', text: t('节点图'), onclick: () => { location.hash = '/editor'; } }),
      ),
      ...(wfState.warnings?.length ? [el('details', { class: 'adv', style: { marginTop: '10px' } },
        el('summary', { text: tf('⚠ 转换警告（{n}）', { n: wfState.warnings.length }) }),
        el('div', { class: 'adv-body' }, wfState.warnings.map((w) => el('div', { class: 'muted', text: `· ${w}` }))),
      )] : []),
    ),
    root,
  );

  /** 重渲染本视图（hash 置空再置回，触发全局路由）。 */
  function rerenderRun() {
    location.hash = '';
    location.hash = '/run';
  }

  /**
   * 渲染一个布局单元行。主参数区展开；高级参数区折叠（点标题展开/收起）。
   * 提示词/媒体独占整行；数值/下拉类并入两列网格（单项自动占满）。
   */
  function unitRowEl(unit, collapsed) {
    const box = el('div', { class: 'form-row' + (collapsed ? ' collapsed' : '') });
    box.dataset.unitKey = unit.key;
    box.append(el('span', { class: 'drag-handle', title: t('拖动调整顺序'), text: '⋮' }));
    const title = unit.key.startsWith('group:')
      ? (unit.title + (unit.count > 1 ? ` ×${unit.count}` : ''))
      : (heroRowTitle(unit.key) ?? unit.key);
    const head = el('div', { class: 'form-row-head' },
      el('span', { class: 'grow', text: title }),
      el('span', { class: 'muted form-row-toggle', text: '▸' }),
    );
    head.addEventListener('click', () => {
      if (!box.classList.contains('collapsed')) return;
      const open = box.classList.toggle('open');
      head.querySelector('.form-row-toggle').textContent = open ? '▾' : '▸';
    });
    const body = el('div', { class: 'form-row-body' });
    const inline = [];
    const flush = () => {
      if (!inline.length) return;
      const grid = el('div', { class: 'form-row-grid' });
      for (const field of inline) grid.append(fieldEditor(field, onChange));
      body.append(grid);
      inline.length = 0;
    };
    for (const field of unit.fields) {
      if (field.kind === 'textarea' || field.kind === 'media') {
        flush();
        body.append(fieldEditor(field, onChange));
      } else {
        inline.push(field);
      }
    }
    flush();
    box.append(head, body);
    return box;
  }

  /**
   * 两区拖拽：手柄捕获指针，实时换位；拖过分区边界时自动切换
   * 展开形态（拖入主区展开、拖入高级区折叠），松手持久化两区行序。
   */
  function attachLayoutDrag(mainBox, advBox) {
    let drag = null;
    mainBox.addEventListener('pointerdown', (ev) => start(ev));
    advBox.addEventListener('pointerdown', (ev) => start(ev));

    function start(ev) {
      const handle = ev.target.closest('.drag-handle');
      if (!handle) return;
      const row = handle.closest('.form-row');
      if (!row) return;
      ev.preventDefault();
      drag = { grabY: ev.clientY - row.getBoundingClientRect().top, offsetY: 0, moved: false };
      row.classList.add('dragging');
      try { handle.setPointerCapture(ev.pointerId); } catch { /* 捕获失败时手指不离开手柄仍可拖动 */ }

      const onMove = (mv) => {
        if (!drag) return;
        // 行的基准位置随 DOM 重排变化：用「当前 top − 已有位移」反推基准，避免跳动
        const baseTop = row.getBoundingClientRect().top - drag.offsetY;
        drag.offsetY = mv.clientY - drag.grabY - baseTop;
        row.style.transform = `translateY(${drag.offsetY}px)`;
        if (Math.abs(drag.offsetY) > 4) drag.moved = true;
        // 分区判定：指针越过高级区顶部即属于高级区（拖入主区展开、拖入高级区折叠）；
        // 高级组收起时 advBox 不可见（top=0），禁止跨区，避免行被拖进隐藏区
        const inAdv = !advBox.hidden && mv.clientY >= advBox.getBoundingClientRect().top;
        const targetBox = inAdv ? advBox : mainBox;
        if (row.parentElement !== targetBox) {
          targetBox.append(row);
          row.classList.toggle('collapsed', inAdv);
          row.classList.remove('open');
          const head = row.querySelector('.form-row-head');
          if (head) head.querySelector('.form-row-toggle').textContent = '▸';
          // 区的边界变了，重新校准基准
          drag.grabY = mv.clientY - row.getBoundingClientRect().top + drag.offsetY;
        }
        const rect = row.getBoundingClientRect();
        const center = rect.top + rect.height / 2;
        for (const other of targetBox.querySelectorAll(':scope > .form-row')) {
          if (other === row) continue;
          const oRect = other.getBoundingClientRect();
          if (center < oRect.top || center > oRect.bottom) continue;
          if (center > oRect.top + oRect.height / 2) other.after(row);
          else other.before(row);
          break;
        }
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        if (!drag) return;
        const wasMoved = drag.moved;
        drag = null;
        row.classList.remove('dragging');
        row.style.transform = '';
        if (!wasMoved) return;
        // 排序按工作流分开记：不同工作流互不干扰（旧版全局单份会互相污染）
        saveLayoutUnits(wfState, {
          main: [...mainBox.querySelectorAll(':scope > .form-row')].map((r) => r.dataset.unitKey).filter(Boolean),
          advanced: [...advBox.querySelectorAll(':scope > .form-row')].map((r) => r.dataset.unitKey).filter(Boolean),
        });
        toast(t('布局已保存（主区展开，下方折叠）'));
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    }
  }


  // 提交按钮（置顶）与页尾保存卡
  const submitBtn = el('button', {
    class: 'btn primary big', text: '▶ ' + t('生成'),
    onclick: submit,
  });
  const submitCard = el('div', { class: 'card' }, submitBtn);
  const tailCard = el('div', { class: 'card' },
    el('div', { class: 'row wrap' },
      el('button', { class: 'btn small grow', text: t('保存覆盖'), onclick: () => save(true) }),
      el('button', { class: 'btn small grow', text: t('另存为'), onclick: () => save(false) }),
    ),
    el('p', { class: 'muted', style: { marginBottom: 0, fontSize: '12px' },
      text: t(wfState.path ? '修改的参数仅用于本次运行；需要持久化请使用保存。' : '该工作流来自模板/历史参数，尚未存为你的文件；点「保存覆盖」或「另存为」都会让你起名保存。') }),
  );

  const nodes = listApiNodes(wfState.json);
  const schemas = await ensureSchemas(nodes.map((n) => n.class_type));
  cachedSchemas = schemas;
  const model = buildFormModel({ workflow: wfState.json, schemas });
  // 恢复上次编辑的表单值（切走工作流/切页签/刷新不丢；控件初始值取 field.value）
  const savedParams = loadWorkflowParams(wfState);
  const values = { ...savedParams };
  for (const field of model.fields) {
    if (field.key in savedParams) field.value = savedParams[field.key];
  }
  const onChange = (key, value) => {
    values[key] = value;
    saveWorkflowParam(wfState, key, value);
  };

  clear(root);
  root.append(submitCard);

  if (model.heroes.length || model.groups.length) {
    // 旧版布局记忆迁移：heroRows（仅主区行序）→ 旧全局 layoutUnits（再由 loadLayoutUnits 兜底读取）
    if (!state.settings.layoutUnits && Array.isArray(state.settings.heroRows)) {
      state.settings.layoutUnits = {
        main: state.settings.heroRows.filter((k) => !String(k).startsWith('group:')),
        advanced: [],
      };
      delete state.settings.heroRows;
    }

    const zones = buildRunLayout(model.heroes, model.groups, loadLayoutUnits(wfState));
    const heroCard = el('div', { class: 'card' },
      el('div', { class: 'row', style: { marginBottom: '8px' } },
        el('h3', { style: { margin: 0, flex: 1 }, text: t('主参数') }),
        el('span', { class: 'muted', style: { fontSize: '11px' }, text: t('按住 ⋮ 拖动：上下排序；展开高级参数组后可拖入高级区') }),
      ),
    );
    const mainBox = el('div', { class: 'hero-rows' });
    for (const unit of zones.main) mainBox.append(unitRowEl(unit, Boolean(unit.isFamily)));
    // 高级参数整组折叠：默认收起，点组标题展开/收起全部高级行（展开状态记入设置随偏好同步）
    const advBox = el('div', { class: 'adv-rows' });
    for (const unit of zones.advanced) advBox.append(unitRowEl(unit, true));
    const advToggle = el('span', { class: 'adv-group-toggle', text: '▸' });
    const advHead = el('div', { class: 'adv-group-head' },
      advToggle,
      el('span', { class: 'grow', text: tf('高级参数（{n}）', { n: zones.advanced.length }) }),
    );
    const advHint = el('div', { class: 'adv-hint muted', text: t('按住 ⋮ 拖动：上下排序，可拖回主参数区') });
    let advOpen = zones.advanced.length > 0 && Boolean(state.settings.advOpen);
    const applyAdvOpen = () => {
      advToggle.textContent = advOpen ? '▾' : '▸';
      advBox.hidden = !advOpen;
      advHint.hidden = !advOpen;
    };
    advHead.addEventListener('click', () => {
      advOpen = !advOpen;
      state.settings.advOpen = advOpen;
      saveSettings();
      applyAdvOpen();
    });
    applyAdvOpen();
    const advGroup = el('div', { class: 'adv-group' }, advHead, advHint, advBox);
    if (!zones.advanced.length) advGroup.style.display = 'none';
    heroCard.append(mainBox, advGroup);
    attachLayoutDrag(mainBox, advBox);
    root.append(heroCard);
  } else {
    root.append(el('div', { class: 'card muted', text: t('该工作流未识别出可编辑的 widget 参数，请在下方高级参数或 JSON 中修改。') }));
  }

  root.append(tailCard);

  // JSON 源码兜底编辑
  const ta = el('textarea', { rows: '10', style: { fontFamily: 'monospace', fontSize: '12px' } });
  ta.value = JSON.stringify(wfState.json, null, 2);
  root.append(
    el('details', { class: 'adv' },
      el('summary', { text: t('JSON 源码（高级）') }),
      el('div', { class: 'adv-body' },
        ta,
        el('button', {
          class: 'btn small', style: { marginTop: '8px' }, text: t('应用 JSON 修改'),
          onclick: () => {
            try {
              const parsed = JSON.parse(ta.value);
              if (detectFormat(parsed) !== 'api') throw new Error(t('不是 API 格式'));
              // JSON 是显式设定的新基准：作废表单缓存，避免恢复的旧值在重渲染时盖掉 JSON 现值
              clearWorkflowParams(wfState);
              setWorkflow({ ...wfState, json: parsed });
              toast(t('已应用，正在刷新表单'));
              rerenderRun();
            } catch (err) {
              toast(t('JSON 无效：') + err.message);
            }
          },
        }),
      ),
    ),
  );

  function showNodeErrors(nodeErrors) {
    const keys = Object.keys(nodeErrors);
    if (!keys.length) return false;
    const errCard = el('div', { class: 'card error-card' },
      el('h3', { text: tf('工作流校验失败（{n} 个节点）', { n: keys.length }) }),
    );
    for (const nodeId of keys) {
      const e = nodeErrors[nodeId];
      errCard.append(el('div', { class: 'muted', text: `节点 #${nodeId} ${e?.class_type ?? ''}：${e?.errors?.map((x) => x.message).join('；') ?? JSON.stringify(e)}` }));
      for (const err of e?.errors ?? []) {
        const fix = parseValueNotInList(err, e?.class_type);
        if (fix) {
          errCard.append(el('button', {
            class: 'btn small', style: { margin: '4px 8px 4px 0' },
            text: tf('🔧 一键修复 {a} → {b}', { a: fix.inputName, b: fix.best }),
            onclick: () => applyAutoFix(nodeId, fix),
          }));
        }
      }
    }
    root.prepend(errCard);
    return true;
  }

  /** 从 value_not_in_list 错误中解析输入名与当前值，并给出模糊匹配的候选值。 */
  function parseValueNotInList(err, classType) {
    if (!/not in/i.test(String(err?.message ?? '')) || err?.details == null) return null;
    const detail = String(err.details);
    const match = /^([^\s:]+):\s*'(.*)' not in/.exec(detail);
    if (!match) return null;
    const [, inputName, current] = match;
    const schema = cachedSchemas[classType];
    const def = schemaInputDef(schema, inputName);
    const options = comboOptions(def) ?? [];
    if (!options.length) return null;
    // 模糊匹配：去掉 "(1)" 这类副本后缀再比对
    const normalized = current.replace(/\s*\(\d+\)(\.[^.]*)$/, '$1');
    const best = options.find((o) => o === normalized)
      ?? options.find((o) => o.replace(/\s*\(\d+\)(\.[^.]*)$/, '$1') === normalized)
      ?? options.find((o) => normalized.includes(o.split('/').pop()))
      ?? options[0];
    return { inputName, current, best };
  }

  function applyAutoFix(nodeId, fix) {
    const node = wfState.json[String(nodeId)];
    if (!node) return;
    node.inputs[fix.inputName] = fix.best;
    onChange(`${nodeId}:${fix.inputName}`, fix.best);
    toast(tf('已将 {a} 改为 {b}，重新提交中…', { a: fix.inputName, b: fix.best }));
    errCardCleanup();
    submit();
  }

  function errCardCleanup() {
    const card = root.querySelector('.error-card');
    if (card) card.remove();
  }

  async function submit() {
    submitBtn.disabled = true;
    submitBtn.textContent = t('提交中…');
    try {
      applyFormModel(wfState.json, model.fields, values);
      fillSocketlessInputs(wfState.json, cachedSchemas);
      const res = await apiJson('/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: wfState.json, client_id: CLIENT_ID }),
      });
      if (!showNodeErrors(res?.node_errors ?? {})) {
        resetRunStats();
        markPendingRun();
        toast(tf('已加入队列（#{n}）', { n: res?.number ?? '?' }));
        location.hash = '/queue';
      }
    } catch (err) {
      if (!showNodeErrors(err.data?.node_errors ?? {})) {
        toast(t('提交失败：') + err.message);
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '▶ ' + t('生成');
    }
  }

  async function save(overwrite) {
    try {
      applyFormModel(wfState.json, model.fields, values);
      let path = wfState.path;
      // 模板库/「用此参数重跑」打开的工作流没有来源文件（path 为空）：
      // 覆盖保存若照常提交会写到 workflows/null 并提示已保存，实际什么都没存。
      // 这里退化为另存为，让用户起一个真实文件名。
      if (overwrite && !path) overwrite = false;
      if (!overwrite) {
        const name = await promptDialog(wfState.path ? t('另存为文件名') : t('保存到我的工作流，文件名'), wfState.name);
        if (!name) return;
        path = name.endsWith('.json') ? name : `${name}.json`;
      } else if (!(await confirmDialog(tf('覆盖保存到 {p}？', { p: wfState.path ?? wfState.name })))) {
        return;
      }
      // 落盘一律用桌面 UI 图格式：桌面 ComfyUI 可直接打开，手机端载入自动转回 API
      const classes = listApiNodes(wfState.json).map((n) => n.class_type);
      const payload = JSON.stringify(apiToUi(wfState.json, await ensureSchemas(classes)), null, 2);
      const sep = path.includes('?') ? '&' : '?';
      // ComfyUI 的 /userdata/{path} 按单段匹配：整路径编码（斜杠→%2F），前缀 workflows/
      await apiJson(`/userdata/${encodeURIComponent(`workflows/${path}`)}${sep}overwrite=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      setWorkflow({ ...wfState, path, name: path.split('/').pop(), json: wfState.json, warnings: undefined });
      migrateWorkflowParams(wfState, state.workflow); // 另存为/首次保存后表单缓存跟着新 path 走
      toast(t('已保存'));
    } catch (err) {
      toast(t('保存失败：') + err.message);
    }
  }
}
