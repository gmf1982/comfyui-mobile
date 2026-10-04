/** 节点图查看器与编辑器：查看/添加节点/连线/删除/改参数。 */
import { apiJson, ensureSchemas, ensureFullObjectInfo } from '../lib/api.js';
import { el, clear, toast, showSheet, hideSheet, confirmDialog, promptDialog, fieldEditor } from '../lib/ui.js';
import { listApiNodes, schemaInputDef, schemaInputs, comboOptions, isWidgetAbleDef, applyFormModel, defConnectionType, bypassNodeInWorkflow, restoreBypassedNode, dynamicInputInfo, isConnectableDef, isSocketlessDef } from '../lib/workflow-form.js';
import { friendlyClassName } from '../lib/workflow-form.js';
import { layoutGraph, renderGraph, apiToUi } from '../lib/graph.js';
import { state } from '../lib/state.js';
import { t, tf } from '../lib/i18n.js';

function isSeedName(name) {
  return name === 'seed' || name === 'noise_seed' || /(^|_)seed$/.test(name);
}

function inferKindSimple(inputName, value, def) {
  if (isSeedName(inputName)) return 'seed';
  if (Array.isArray(def)) {
    if (Array.isArray(def[0])) return 'combo';
    if (def[0] === 'INT') return 'int';
    if (def[0] === 'FLOAT') return 'float';
    if (def[0] === 'BOOLEAN') return 'toggle';
    if (def[0] === 'STRING') return def[1]?.multiline ? 'textarea' : 'text';
  }
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'boolean') return 'toggle';
  if (typeof value === 'string') return value.length > 60 || value.includes('\n') ? 'textarea' : 'text';
  return 'other';
}

export async function nodeEditorView(container) {
  const wfState = state.workflow;
  if (!wfState) {
    container.append(el('div', { class: 'empty' },
      el('div', { class: 'big', text: '🗺️' }),
      el('div', { text: t('请先在工作流页打开一个工作流') }),
    ));
    return;
  }

  container.classList.add('fullbleed');

  const graphWrap = el('div', { class: 'graph-wrap' });
  const toolbar = el('div', { class: 'graph-toolbar' },
    el('button', { class: 'btn small', text: t('适配'), onclick: () => api?.fit() }),
    el('button', { class: 'btn small primary', text: t('＋ 节点'), onclick: addNodeSheet }),
    el('button', { class: 'btn small', text: t('已旁路'), onclick: bypassListSheet }),
    el('button', { class: 'btn small primary', text: t('▶ 运行'), onclick: () => { location.hash = '/run'; } }),
    el('button', { class: 'btn small', text: t('保存'), onclick: () => saveWorkflow(false) }),
    el('button', { class: 'btn small', text: t('另存为'), onclick: () => saveWorkflow(true) }),
  );
  container.append(el('div', { style: { position: 'relative' } }, graphWrap, toolbar));

  let api = null;
  const nodes = listApiNodes(wfState.json);
  const schemas = await ensureSchemas(nodes.map((n) => n.class_type));

  function draw() {
    clear(graphWrap);
    const layout = layoutGraph(wfState.json);
    api = renderGraph(graphWrap, layout, { onSelect: (id) => selectNode(id) });
  }

  // ---------------- 节点参数 + 连线 + 删除 ----------------

  async function selectNode(id) {
    const node = listApiNodes(wfState.json).find((n) => n.id === String(id));
    if (!node) return;
    const schema = schemas[node.class_type] ?? (await ensureSchemas([node.class_type]))[node.class_type];
    const values = {};
    const rawTitle = String(node.title ?? '').split('/').pop();
    const currentTitle = rawTitle && rawTitle !== node.class_type ? rawTitle : '';
    const sheet = el('div', {},
      el('h3', { text: (currentTitle || friendlyClassName(node.class_type)) + t('（') + '#' + id + t('）') }),
    );

    // 重命名节点：写入 _meta.title（与桌面端一致），图/表单/媒体字段标签同步显示
    sheet.append(el('button', {
      class: 'btn small', style: { width: '100%', marginBottom: '10px' }, text: t('✏️ 重命名节点'),
      onclick: async () => {
        const name = await promptDialog(t('节点标题'), currentTitle || friendlyClassName(node.class_type));
        if (!name) return;
        const target = wfState.json[String(node.id)];
        if (!target) return;
        target._meta = { ...(target._meta ?? {}), title: name.trim() };
        draw();
        selectNode(node.id);
        toast(t('已重命名（尚未保存）'));
      },
    }));

    for (const [inputName, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value)) continue;
      const def = schemaInputDef(schema, inputName);
      const field = {
        key: `${node.id}:${inputName}`,
        nodeId: node.id,
        inputName,
        kind: inferKindSimple(inputName, value, def),
        label: inputName,
        value,
        classType: node.class_type, // combo「刷新列表」按类重拉 object_info
      };
      if (field.kind === 'other') continue;
      if (field.kind === 'combo') field.options = def && Array.isArray(def[0]) ? def[0] : [value];
      if (field.kind === 'int' || field.kind === 'float') {
        const opts = Array.isArray(def) && def[1] && typeof def[1] === 'object' ? def[1] : {};
        if (typeof opts.min === 'number') field.min = opts.min;
        if (typeof opts.max === 'number') field.max = opts.max;
        if (typeof opts.step === 'number') field.step = opts.step;
      }
      sheet.append(fieldEditor(field, (key, v) => { values[key] = v; }));
    }

    // 连线区：schema 中的连线型输入（动态输入按子槽逐项展开）
    const linkSection = el('div', { class: 'field' }, el('label', { text: t('连线') }));
    let hasLinkable = false;
    for (const [inputName, def] of schemaInputs(schema)) {
      if (!isConnectableDef(def)) continue;
      const dyn = dynamicInputInfo(def);
      const typeStr = defConnectionType(def);
      if (dyn?.kind === 'autogrow') {
        hasLinkable = true;
        linkSection.append(el('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '4px' }, text: inputName + t('（可多个 ') + dyn.innerType + '）' }));
        const usedKeys = Object.keys(node.inputs ?? {}).filter((k) => k.startsWith(inputName + '.'));
        for (const key of usedKeys.sort()) {
          const slot = key.slice(inputName.length + 1);
          const cur = node.inputs[key];
          const row = el('div', { class: 'row', style: { marginBottom: '6px' } });
          row.append(el('div', { class: 'grow', style: { fontSize: '13px' }, text: slot + '（' + dyn.innerType + '）' }));
          if (Array.isArray(cur)) {
            row.append(el('span', { class: 'muted', text: '← #' + cur[0] }));
            row.append(el('button', {
              class: 'btn small danger', text: t('断开'),
              onclick: () => {
                delete wfState.json[String(node.id)].inputs[key];
                draw();
                selectNode(node.id);
              },
            }));
          } else {
            row.append(el('button', { class: 'btn small', text: t('🔗 连接'), onclick: () => connectSheet(node, key, dyn.innerType) }));
          }
          linkSection.append(row);
        }
        // 下一个空闲槽位（names 列表里第一个未使用的；用尽则按前缀自增）
        const freeSlot = (() => {
          for (const n of dyn.names) {
            if (!(inputName + '.' + n in (node.inputs ?? {}))) return n;
          }
          let idx = 1;
          while ((inputName + '.image_' + idx) in (node.inputs ?? {})) idx++;
          return 'image_' + idx;
        })();
        const addRow = el('div', { class: 'row', style: { marginBottom: '6px' } });
        addRow.append(el('div', { class: 'grow', style: { fontSize: '13px' }, text: '新增 ' + freeSlot + '（' + dyn.innerType + '）' }));
        addRow.append(el('button', {
          class: 'btn small primary', text: '＋ ' + t('🔗 连接'),
          onclick: () => connectSheet(node, inputName + '.' + freeSlot, dyn.innerType),
        }));
        linkSection.append(addRow);
        continue;
      }
      hasLinkable = true;
      const current = node.inputs?.[inputName];
      const row = el('div', { class: 'row', style: { marginBottom: '6px' } });
      row.append(el('div', { class: 'grow', style: { fontSize: '13px' }, text: inputName + t('（') + (typeStr || t('连线')) + t('）') }));
      if (Array.isArray(current)) {
        row.append(el('span', { class: 'muted', text: '← #' + current[0] }));
        row.append(el('button', {
          class: 'btn small danger', text: t('断开'),
          onclick: () => {
            delete wfState.json[String(node.id)].inputs[inputName];
            draw();
            selectNode(node.id);
          },
        }));
      } else {
        row.append(el('button', {
          class: 'btn small', text: '🔗 连接',
          onclick: () => connectSheet(node, inputName, typeStr),
        }));
      }
      linkSection.append(row);
    }
    if (hasLinkable) sheet.append(linkSection);

    // 输出连线区：把该节点的输出发起连接
    const outTypes = schema?.output ?? [];
    if (outTypes.length) {
      const outSection = el('div', { class: 'field' }, el('label', { text: t('输出连线') }));
      outTypes.forEach((outType, slot) => {
        const consumers = listApiNodes(wfState.json)
          .filter((n) => String(n.id) !== String(node.id) && Object.values(n.inputs ?? {}).some((v) => Array.isArray(v) && String(v[0]) === String(node.id) && v[1] === slot)).length;
        const label = t('输出') + slot + t('（') + outType + t('）') + (consumers ? t(' · 已连 ') + consumers + t(' 处') : t(' · 未使用'));
        outSection.append(el('div', { class: 'row', style: { marginBottom: '6px' } },
          el('div', { class: 'grow', style: { fontSize: '13px' }, text: label }),
          el('button', { class: 'btn small', text: t('🔗 输出到…'), onclick: () => outputConnectSheet(node, slot, outType) }),
        ));
      });
      sheet.append(outSection);
    }

    sheet.append(
      el('button', {
        class: 'btn', style: { width: '100%', marginTop: '8px' }, text: t('⏭ 旁路该节点'),
        onclick: async () => {
          hideSheet();
          if (!(await confirmDialog(t('旁路该节点？其消费方将改接到同类型输入的来源；可在「已旁路」中恢复。')))) return;
          const archive = bypassNodeInWorkflow(wfState.json, node.id, schemas);
          if (archive) {
            (wfState.bypassed ??= []).push(archive);
            draw();
            toast(t('已旁路（尚未保存）'));
          }
        },
      }),
    );

    sheet.append(
      el('button', {
        class: 'btn primary', style: { width: '100%', marginTop: '12px' }, text: t('应用修改'),
        onclick: () => {
          applyFormModel(wfState.json, [], values);
          for (const [key, value] of Object.entries(values)) {
            const [nodeId, inputName] = key.split(/:(.+)/);
            const target = wfState.json[nodeId];
            if (target) {
              const numeric = Number(value);
              target.inputs[inputName] = Number.isFinite(numeric) && typeof value !== 'boolean' && value !== '' && String(numeric) === String(value).trim() ? numeric : value;
            }
          }
          hideSheet();
          draw();
          toast(t('已应用（尚未保存）'));
        },
      }),
      el('button', {
        class: 'btn danger', style: { width: '100%', marginTop: '8px' }, text: t('🗑 删除该节点'),
        onclick: async () => {
          hideSheet();
          if (!(await confirmDialog(tf('删除节点 #{id}（{cls}）？引用它的连线会一并断开。', { id: node.id, cls: friendlyClassName(node.class_type) })))) return;
          delete wfState.json[String(node.id)];
          for (const n of Object.values(wfState.json)) {
            for (const [name, v] of Object.entries(n.inputs ?? {})) {
              if (Array.isArray(v) && String(v[0]) === String(node.id)) delete n.inputs[name];
            }
          }
          draw();
          toast(t('已删除'));
        },
      }),
      el('button', { class: 'btn', style: { width: '100%', marginTop: '8px' }, text: t('取消'), onclick: hideSheet }),
    );
    showSheet(sheet);
  }

  /** 连线：列出输出类型匹配的节点与槽位。 */
  function connectSheet(targetNode, inputName, wantType) {
    const candidates = [];
    for (const n of listApiNodes(wfState.json)) {
      if (String(n.id) === String(targetNode.id)) continue;
      const outTypes = schemas[n.class_type]?.output ?? [];
      outTypes.forEach((outType, slot) => {
        if (!wantType || outType === wantType) candidates.push({ id: n.id, title: n.title || n.class_type, cls: n.class_type, slot, type: outType });
      });
    }
    const sheet = el('div', {},
      el('h3', { text: t('连接到 ') + inputName + t('（') + (wantType || t('任意')) + t('）') }),
    );
    if (!candidates.length) {
      sheet.append(el('div', { class: 'muted', text: t('没有输出类型匹配的节点；可先添加一个节点。') }));
    }
    for (const c of candidates.slice(0, 60)) {
      sheet.append(el('button', {
        class: 'btn', style: { width: '100%', marginBottom: '6px', justifyContent: 'flex-start' },
        text: `${friendlyClassName(c.cls)}（#${c.id}）· 输出${c.slot} [${c.type}]`,
        onclick: () => {
          wfState.json[String(targetNode.id)].inputs[inputName] = [String(c.id), c.slot];
          hideSheet();
          draw();
          toast(t('已连接 ') + '#' + c.id + ' → ' + inputName);
        },
      }));
    }
    sheet.append(el('button', { class: 'btn', style: { width: '100%', marginTop: '8px' }, text: '取消', onclick: hideSheet }));
    showSheet(sheet);
  }

  /** 输出连线：列出目标节点上类型匹配的输入。 */
  function outputConnectSheet(sourceNode, slot, wantType) {
    const candidates = [];
    for (const n of listApiNodes(wfState.json)) {
      if (String(n.id) === String(sourceNode.id)) continue;
      const targetSchema = schemas[n.class_type];
      if (!targetSchema) continue;
      for (const [inputName, def] of schemaInputs(targetSchema)) {
        if (!isConnectableDef(def)) continue;
        const dyn = dynamicInputInfo(def);
        if (dyn?.kind === 'autogrow') {
          if (wantType && dyn.innerType !== wantType) continue;
          const usedKeys = Object.keys(n.inputs ?? {}).filter((k) => k.startsWith(inputName + '.'));
          for (const key of usedKeys.sort()) {
            if (Array.isArray(n.inputs[key])) continue; // 已占用
            candidates.push({ id: n.id, title: n.title || n.class_type, cls: n.class_type, inputName: key, connected: false });
          }
          const freeSlot = dyn.names.find((x) => !(inputName + '.' + x in (n.inputs ?? {})))
            ?? 'image_' + (usedKeys.length + 1);
          candidates.push({ id: n.id, title: n.title || n.class_type, cls: n.class_type, inputName: inputName + '.' + freeSlot, connected: false, isNew: true });
          continue;
        }
        if (wantType && defConnectionType(def) !== wantType) continue;
        const current = n.inputs?.[inputName];
        candidates.push({
          id: n.id, title: n.title || n.class_type, cls: n.class_type,
          inputName, connected: Array.isArray(current),
        });
      }
    }
    const sheet = el('div', {}, el('h3', { text: t('把 输出') + slot + t('（') + wantType + t('）连到…') }));
    if (!candidates.length) sheet.append(el('div', { class: 'muted', text: t('没有类型匹配的输入；可先添加一个节点。') }));
    for (const c of candidates.slice(0, 80)) {
      const label = friendlyClassName(c.cls) + '（#' + c.id + '）· ' + c.inputName + (c.isNew ? '（新增）' : c.connected ? '（覆盖原连线）' : '');
      sheet.append(el('button', {
        class: 'btn', style: { width: '100%', marginBottom: '6px', justifyContent: 'flex-start', textAlign: 'left' },
        text: label,
        onclick: () => {
          wfState.json[String(c.id)].inputs[c.inputName] = [String(sourceNode.id), slot];
          hideSheet();
          draw();
          toast(t('已连接 输出') + slot + ' → #' + c.id + '.' + c.inputName);
        },
      }));
    }
    sheet.append(el('button', { class: 'btn', style: { width: '100%', marginTop: '8px' }, text: '取消', onclick: hideSheet }));
    showSheet(sheet);
  }

  /** 已旁路节点列表与恢复。 */
  function bypassListSheet() {
    const list = wfState.bypassed ?? [];
    const sheet = el('div', {}, el('h3', { text: t('已旁路（') + list.length + t('）') }));
    if (!list.length) sheet.append(el('div', { class: 'muted', text: t('没有旁路的节点。旁路仅在本会话可恢复，保存后即固化。') }));
    list.forEach((entry, i) => {
      sheet.append(el('button', {
        class: 'btn', style: { width: '100%', marginBottom: '6px' },
        text: t('↩ 恢复 ') + friendlyClassName(entry.node.class_type) + t('（') + '#' + entry.bypassedId + t('）') + '',
        onclick: () => {
          restoreBypassedNode(wfState.json, entry);
          wfState.bypassed.splice(i, 1);
          hideSheet();
          draw();
          toast(t('已恢复（尚未保存）'));
        },
      }));
    });
    sheet.append(el('button', { class: 'btn', style: { width: '100%', marginTop: '8px' }, text: t('关闭'), onclick: hideSheet }));
    showSheet(sheet);
  }

  // ---------------- 添加节点 ----------------

  async function addNodeSheet() {
    toast(t('加载节点列表（首次约 5MB）…'));
    let all;
    try {
      all = await ensureFullObjectInfo();
    } catch (err) {
      toast(t('节点列表加载失败：') + err.message);
      return;
    }
    const input = el('input', { type: 'text', placeholder: t('搜索节点名（如 KSampler、放大、LoRA）') });
    const results = el('div', { style: { marginTop: '10px', maxHeight: '46dvh', overflowY: 'auto' } });
    const sheet = el('div', {}, el('h3', { text: t('添加节点') }), el('div', { class: 'field' }, input), results);

    function search() {
      clear(results);
      const q = input.value.trim().toLowerCase();
      const entries = Object.entries(all ?? {});
      const matched = [];
      for (const [cls, schema] of entries) {
        if (!schema) continue;
        const hay = `${cls} ${schema.display_name ?? ''} ${schema.category ?? ''}`.toLowerCase();
        if (!q || hay.includes(q)) matched.push([cls, schema]);
        if (matched.length >= 40) break;
      }
      if (!matched.length) {
        results.append(el('div', { class: 'muted', text: t('没有匹配的节点') }));
        return;
      }
      for (const [cls, schema] of matched) {
        results.append(el('button', {
          class: 'btn', style: { width: '100%', marginBottom: '6px', justifyContent: 'flex-start', textAlign: 'left' },
          onclick: () => { hideSheet(); addNode(cls, schema); },
        },
        el('div', {},
          el('div', { style: { fontWeight: 600 }, text: friendlyClassName(cls) }),
          el('div', { class: 'muted', style: { fontSize: '11px' }, text: `${cls} · ${schema.category ?? ''}` }),
        ),
        ));
      }
    }
    input.addEventListener('input', search);
    showSheet(sheet);
    search();
  }

  function addNode(classType, schema) {
    const wf = wfState.json;
    const numericIds = Object.keys(wf).map(Number).filter(Number.isFinite);
    const nextId = String((numericIds.length ? Math.max(...numericIds) : 0) + 1);
    const inputs = {};
    for (const [name, def] of schemaInputs(schema)) {
      if (!isWidgetAbleDef(def)) continue;
      const opts = comboOptions(def);
      if (isSeedName(name)) inputs[name] = Math.floor(Math.random() * 2 ** 31);
      else if (opts && opts.length) inputs[name] = String(opts[0]);
      else if (def[0] === 'INT') inputs[name] = typeof def[1]?.default === 'number' ? def[1].default : 0;
      else if (def[0] === 'FLOAT') inputs[name] = typeof def[1]?.default === 'number' ? def[1].default : 0;
      else if (def[0] === 'BOOLEAN') inputs[name] = Boolean(def[1]?.default ?? false);
      else if (def[0] === 'STRING') inputs[name] = typeof def[1]?.default === 'string' ? def[1].default : '';
    }
    // socketless 必填输入（如 ImageCompare.compare_view）不渲染 widget 也不连线，补占位避免服务端校验失败
    for (const [name, def] of schemaInputs(schema)) {
      if (isSocketlessDef(def) && !(name in inputs) && schema.input?.required && name in schema.input.required) {
        inputs[name] = typeof def[1]?.default === 'string' ? def[1].default : '';
      }
    }
    wf[nextId] = { class_type: classType, inputs, _meta: { title: friendlyClassName(classType) } };
    draw();
    toast(t('已添加 ') + friendlyClassName(classType) + t('（') + '#' + nextId + t('），点按节点可连线'));
    setTimeout(() => api?.focus(nextId), 100);
  }

  // ---------------- 保存 ----------------

  async function saveWorkflow(asNew) {
    try {
      let path = wfState.path;
      if (asNew || !path) {
        const name = await promptDialog(t('另存为文件名'), wfState.name);
        if (!name) return;
        path = name.endsWith('.json') ? name : `${name}.json`;
      } else if (!(await confirmDialog(tf('覆盖保存到 {p}？', { p: path })))) {
        return;
      }
      // 落盘一律用桌面 UI 图格式：桌面 ComfyUI 可直接打开，手机端载入自动转回 API
      const classes = listApiNodes(wfState.json).map((n) => n.class_type);
      const payload = JSON.stringify(apiToUi(wfState.json, await ensureSchemas(classes)), null, 2);
      const sep = path.includes('?') ? '&' : '?';
      await apiJson(`/userdata/${encodeURIComponent(`workflows/${path}`)}${sep}overwrite=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      state.workflow = { ...wfState, path, name: path.split('/').pop() };
      toast(t('已保存'));
    } catch (err) {
      toast(t('保存失败：') + err.message);
    }
  }

  draw();
}
