/**
 * 节点图：拓扑自动布局 + SVG 渲染 + 手势（单指平移、双指缩放、点按选中）。
 */
import {
  listApiNodes, friendlyClassName, schemaInputs, schemaInputDef, comboOptions,
  isWidgetAbleDef, isSocketlessDef, defConnectionType, dynamicInputInfo, isSeedInputName,
} from './workflow-form.js';

const NODE_W = 190;
const TITLE_H = 30;
const ROW_H = 17;
const MAX_FIELD_ROWS = 6;
const COL_GAP = 70;
const ROW_GAP = 26;

function previewValue(v) {
  if (Array.isArray(v)) return `← #${v[0]}`;
  if (typeof v === 'string') {
    const s = v.replace(/\s+/g, ' ');
    return s.length > 26 ? s.slice(0, 25) + '…' : s || '""';
  }
  return String(v);
}

/**
 * 自动布局：按拓扑层级分列（输入源在左，输出节点在右）。
 * @param {object} workflow API 格式工作流
 */
export function layoutGraph(workflow) {
  const nodes = listApiNodes(workflow);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = [];
  for (const node of nodes) {
    for (const [inputName, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v)) links.push({ from: String(v[0]), to: node.id, slot: v[1] ?? 0, input: inputName });
    }
  }

  const levels = new Map();
  const levelOf = (id, seen) => {
    if (levels.has(id)) return levels.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const node = byId.get(id);
    let lvl = 0;
    if (node) {
      for (const v of Object.values(node.inputs ?? {})) {
        if (Array.isArray(v)) lvl = Math.max(lvl, levelOf(String(v[0]), seen) + 1);
      }
    }
    seen.delete(id);
    levels.set(id, lvl);
    return lvl;
  };
  for (const node of nodes) levelOf(node.id, new Set());

  const columns = new Map();
  for (const node of nodes) {
    const lvl = levels.get(node.id) ?? 0;
    if (!columns.has(lvl)) columns.set(lvl, []);
    columns.get(lvl).push(node);
  }

  const outsCount = new Map();
  for (const link of links) {
    outsCount.set(link.from, Math.max(outsCount.get(link.from) ?? 1, link.slot + 1));
  }

  const placed = [];
  let maxBottom = 0;
  for (const [lvl, colNodes] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    let y = 30;
    const x = 30 + lvl * (NODE_W + COL_GAP);
    for (const node of colNodes) {
      const widgetEntries = Object.entries(node.inputs ?? {}).filter(([, v]) => !Array.isArray(v)).slice(0, MAX_FIELD_ROWS);
      const h = TITLE_H + ROW_H * widgetEntries.length + 12;
      placed.push({
        id: node.id,
        x, y, w: NODE_W, h,
        title: (String(node.title ?? '').split('/').pop() && String(node.title).split('/').pop() !== node.class_type)
          ? String(node.title).split('/').pop()
          : friendlyClassName(node.class_type),
        cls: node.class_type,
        fields: widgetEntries.map(([k, v]) => `${k}: ${previewValue(v)}`),
        outs: outsCount.get(node.id) ?? 0,
      });
      y += h + ROW_GAP;
    }
    maxBottom = Math.max(maxBottom, y);
  }

  return { nodes: placed, links, width: 30 + (columns.size) * (NODE_W + COL_GAP), height: maxBottom + 30 };
}

// ---------------- API → 桌面 UI 图序列化（保存用，桌面端 ComfyUI 可直接打开） ----------------

const CONTROL_AFTER_GENERATE = 'fixed';

function isLinkValue(v) {
  return Array.isArray(v) && v.length === 2
    && (typeof v[0] === 'string' || typeof v[0] === 'number')
    && typeof v[1] === 'number';
}

/** 控件缺省值：API 缺值或控件被连线占用时，占住 widgets_values 槽位用。 */
function widgetDefaultOf(def) {
  if (!Array.isArray(def)) return '';
  if (Array.isArray(def[0])) return def[0][0] ?? '';
  if (def[0] === 'INT' || def[0] === 'FLOAT') return typeof def[1]?.default === 'number' ? def[1].default : 0;
  if (def[0] === 'BOOLEAN') return Boolean(def[1]?.default ?? false);
  if (def[0] === 'STRING') return typeof def[1]?.default === 'string' ? def[1].default : '';
  if (typeof def[0] === 'string' && def[0].includes('DYNAMICCOMBO')) return def[1]?.options?.[0]?.key ?? '';
  const opts = comboOptions(def);
  return opts?.length ? opts[0] : '';
}

/** _meta 侧信道点值（_cm_pos/_cm_size）→ [a, b]；缺失或非法返回 null。 */
function metaPoint(meta, key) {
  const v = meta?.[key];
  return Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]) ? [v[0], v[1]] : null;
}

/**
 * API 格式工作流 → 桌面端 LiteGraph UI 图格式（带坐标、连线、控件值）。
 * 保存到 userdata 的工作流一律用此格式落盘：桌面 ComfyUI 可直接打开；
 * 手机端载入时 convertUiToApi 会转回 API。槽位规则与 applyWidgetValues 互逆：
 * widgets_values 按 schema 输入序只含控件输入；被连线占用的控件照占槽不赋值；
 * seed 类输入后随一个 control_after_generate 槽位；DYNAMICCOMBO 选中项的
 * 子输入紧随其后占槽（API 键为点号全名）。节点 id 重编号为 1..N（子图展平的
 * 459_451 之类字符串 id 桌面端不能作 LiteGraph 数字 id）。
 * @param {object} apiJson {id: {class_type, inputs, _meta}}
 * @param {Record<string, object|null>} schemas class_type → object_info 条目
 */
export function apiToUi(apiJson, schemas = {}) {
  const nodes = listApiNodes(apiJson);
  const idMap = new Map(nodes.map((n, i) => [n.id, i + 1]));
  const posById = new Map(layoutGraph(apiJson).nodes.map((n) => [n.id, n]));

  const draft = nodes.map((node) => {
    const schema = schemas[node.class_type] ?? null;
    const entries = schemaInputs(schema);
    const entryNames = new Set(entries.map(([name]) => name));
    const slotInputs = [];
    const widgets = [];
    const autogrow = new Map(); // autogrow 父输入名 → 内层连线类型（点号子键第二遍补槽）
    if (schema) {
      for (const [name, def] of entries) {
        if (isSocketlessDef(def)) continue; // 纯 UI 占位：无控件无槽位，载入时由 convertUiToApi 补默认值
        const dyn = dynamicInputInfo(def);
        if (dyn?.kind === 'autogrow') { autogrow.set(name, dyn.innerType); continue; }
        const v = node.inputs[name];
        const linked = isLinkValue(v);
        if (isWidgetAbleDef(def)) {
          // 控件槽位永远占位（与桌面端序列化一致）：被连线占用时填默认值
          widgets.push(linked || v === undefined || v === null || typeof v === 'object' ? widgetDefaultOf(def) : v);
          if (isSeedInputName(name)) widgets.push(CONTROL_AFTER_GENERATE);
          if (dyn?.kind === 'dynamiccombo') {
            const options = Array.isArray(def[1]?.options) ? def[1].options : null;
            const opt = options?.find((o) => o.key === String(v ?? ''));
            const subEntries = [
              ...Object.entries(opt?.inputs?.required ?? {}),
              ...Object.entries(opt?.inputs?.optional ?? {}),
            ];
            for (const [subName, subDef] of subEntries) {
              const full = `${name}.${subName}`;
              const sv = node.inputs[full];
              widgets.push(sv === undefined || sv === null || typeof sv === 'object' ? widgetDefaultOf(subDef) : sv);
              if (isSeedInputName(full)) widgets.push(CONTROL_AFTER_GENERATE);
            }
          }
        }
        if (linked) slotInputs.push({ name, type: defConnectionType(def) || '*', value: v });
      }
    }
    // 第二遍：autogrow 的点号子键（images.image_1 等）与缺 schema 节点的输入
    for (const [name, v] of Object.entries(node.inputs ?? {})) {
      if (entryNames.has(name)) continue;
      const dot = name.indexOf('.');
      if (dot !== -1 && autogrow.has(name.slice(0, dot))) {
        if (isLinkValue(v)) slotInputs.push({ name, type: autogrow.get(name.slice(0, dot)) || 'IMAGE', value: v });
        continue;
      }
      if (!schema) {
        if (isLinkValue(v)) slotInputs.push({ name, type: '*', value: v });
        else if (v !== null && typeof v !== 'object') widgets.push(v);
      }
    }
    return { node, schema, slotInputs, widgets };
  });
  const draftById = new Map(draft.map((d) => [d.node.id, d]));

  // 输出槽：按 schema 声明生成，另为被消费但未声明的槽位补齐
  const consumers = new Set();
  for (const node of nodes) {
    for (const v of Object.values(node.inputs ?? {})) {
      if (isLinkValue(v)) consumers.add(`${v[0]}:${v[1] ?? 0}`);
    }
  }
  for (const d of draft) {
    const names = d.schema?.output_name ?? [];
    const types = d.schema?.output ?? [];
    let count = names.length;
    for (const key of consumers) {
      if (key.startsWith(`${d.node.id}:`)) count = Math.max(count, Number(key.split(':')[1]) + 1);
    }
    d.outputs = Array.from({ length: count }, (_, i) => ({
      name: names[i] ?? `OUTPUT_${i + 1}`,
      type: types[i] ?? '*',
      links: [],
      slot_index: i,
    }));
  }

  // 连线：target_slot 取输入槽序号；link 类型优先用来源输出的类型
  let lastLinkId = 0;
  const links = [];
  for (const d of draft) {
    d.slotInputs.forEach((slot, idx) => {
      const fromOld = String(slot.value[0]);
      const src = draftById.get(fromOld);
      const fromId = idMap.get(fromOld);
      if (!src || fromId == null) return; // 悬空连线丢弃
      const outSlot = slot.value[1] ?? 0;
      const linkId = ++lastLinkId;
      links.push([linkId, fromId, outSlot, idMap.get(d.node.id), idx, src.outputs[outSlot]?.type ?? slot.type]);
      slot.link = linkId;
      src.outputs[outSlot]?.links.push(linkId);
    });
  }

  const uiNodes = draft.map((d, i) => {
    const pos = posById.get(d.node.id);
    // 载入 UI 图时 convertUiToApi 把原 pos/size 存进节点 _meta（_cm_pos/_cm_size）：
    // 有侧信道就原位还原桌面布局；没有（API 直建、子图展平）才按拓扑自动布局。
    // listApiNodes 不透传 _meta，这里从原始 apiJson 按 key 取。
    const rawMeta = apiJson?.[d.node.id]?._meta ?? null;
    const savedPos = metaPoint(rawMeta, '_cm_pos');
    const savedSize = metaPoint(rawMeta, '_cm_size');
    const title = d.node.title ?? '';
    const rows = Math.min(d.widgets.length + d.slotInputs.length, 14);
    return {
      id: idMap.get(d.node.id),
      type: d.node.class_type,
      pos: savedPos ?? [Math.round((pos?.x ?? 30 + i * 30) * 1.5), Math.round((pos?.y ?? 30) * 1.5)],
      size: savedSize ?? [240, Math.max(60, 46 + 22 * rows)],
      flags: {},
      order: i,
      mode: 0,
      inputs: d.slotInputs.map((s) => ({ name: s.name, type: s.type, link: s.link ?? null })),
      outputs: d.outputs,
      properties: { 'Node name for S&R': d.node.class_type },
      widgets_values: d.widgets,
      ...(title ? { title } : {}),
    };
  });

  return {
    last_node_id: nodes.length,
    last_link_id: lastLinkId,
    nodes: uiNodes,
    links,
    groups: [],
    config: {},
    extra: {},
    version: 0.4,
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'textContent') node.textContent = v;
    else node.setAttribute(k, v);
  }
  return node;
}

function portY(node, slot) {
  return node.y + 20 + slot * 14;
}

/**
 * 渲染可交互节点图。
 * @param {HTMLElement} container
 * @param {object} layout layoutGraph 产出
 * @param {{onSelect?: (id: string) => void}} handlers
 */
export function renderGraph(container, layout, handlers = {}) {
  const svg = svgEl('svg');
  const viewport = svgEl('g');
  svg.append(viewport);

  for (const link of layout.links) {
    const from = layout.nodes.find((n) => n.id === link.from);
    const to = layout.nodes.find((n) => n.id === link.to);
    if (!from || !to) continue;
    const x1 = from.x + from.w;
    const y1 = portY(from, link.slot);
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
    const dx = Math.max(40, (x2 - x1) / 2);
    viewport.append(svgEl('path', {
      d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      class: 'node-link',
    }));
  }

  for (const node of layout.nodes) {
    const g = svgEl('g', { class: 'node-g', 'data-node': node.id });
    g.append(svgEl('rect', { x: node.x, y: node.y, width: node.w, height: node.h, rx: 10, class: 'node-rect' }));
    g.append(svgEl('text', { x: node.x + 10, y: node.y + 19, class: 'node-title', textContent: node.title }));
    node.fields.forEach((line, i) => {
      g.append(svgEl('text', { x: node.x + 10, y: node.y + TITLE_H + 4 + i * ROW_H, class: 'node-field', textContent: line }));
    });
    for (let s = 0; s < node.outs; s++) {
      g.append(svgEl('circle', { cx: node.x + node.w, cy: portY(node, s), r: 4, fill: '#4d7cff' }));
    }
    viewport.append(g);
  }

  // 视图变换：单指平移 / 双指捏合 / 滚轮缩放 / 点按选中
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const apply = () => viewport.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`);
  apply();

  const pointers = new Map();
  let pinchStart = null;
  let moved = false;
  let downNode = null;

  const clampScale = (s) => Math.max(0.15, Math.min(2.5, s));

  /** 把内容点 c（视图坐标）锚定到屏幕点 m 后应用新缩放：以手指/光标为中心缩放。 */
  function zoomAt(newScale, sx, sy, content) {
    const rect = container.getBoundingClientRect();
    scale = clampScale(newScale);
    tx = (sx - rect.left) - content.x * scale;
    ty = (sy - rect.top) - content.y * scale;
    apply();
  }

  function fit() {
    const rect = container.getBoundingClientRect();
    // 顶部悬浮工具条会盖住第一行节点：fit 时把内容整体下移到工具条以下再计算可用高度
    const toolbar = container.parentElement?.querySelector('.graph-toolbar');
    const toolbarH = toolbar ? toolbar.offsetHeight + 12 : 0;
    scale = Math.min(1.4, rect.width / layout.width);
    scale = Math.max(0.2, Math.min(scale, (rect.height - toolbarH) / layout.height));
    tx = (rect.width - layout.width * scale) / 2;
    ty = toolbarH + 4;
    apply();
  }

  svg.addEventListener('pointerdown', (ev) => {
    try {
      svg.setPointerCapture(ev.pointerId);
    } catch {
      // 合成/已失效的 pointerId 无法捕获，不影响手势
    }
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    downNode = ev.target.closest?.('[data-node]') ?? null;
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // 记录捏合起点的中点对应的内容坐标：后续缩放/移动都把它锚定到当前两指中点
      const rect = container.getBoundingClientRect();
      pinchStart = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale,
        content: { x: (mid.x - rect.left - tx) / scale, y: (mid.y - rect.top - ty) / scale },
      };
    }
  });
  svg.addEventListener('pointermove', (ev) => {
    const prev = pointers.get(ev.pointerId);
    if (!prev) return;
    const dx = ev.clientX - prev.x;
    const dy = ev.clientY - prev.y;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;

    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // 以捏合起点的内容点为锚：缩放跟随两指间距，平移跟随两指中点
      zoomAt(pinchStart.scale * (dist / pinchStart.dist), mid.x, mid.y, pinchStart.content);
    } else {
      tx += dx;
      ty += dy;
      apply();
    }
  });
  const release = (ev) => {
    const wasSingle = pointers.size === 1;
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinchStart = null;
    // pointer capture 会把 target 重定向到 svg，因此用 pointerdown 时记录的节点
    const target = downNode;
    downNode = null;
    if (wasSingle && !moved && handlers.onSelect && target) {
      handlers.onSelect(target.dataset.node);
    }
  };
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = container.getBoundingClientRect();
    const content = { x: (ev.clientX - rect.left - tx) / scale, y: (ev.clientY - rect.top - ty) / scale };
    zoomAt(scale * (ev.deltaY < 0 ? 1.1 : 0.9), ev.clientX, ev.clientY, content);
  }, { passive: false });

  const api = {
    focus(id) {
      const node = layout.nodes.find((n) => n.id === String(id));
      if (!node) return;
      const rect = container.getBoundingClientRect();
      scale = 1;
      tx = rect.width / 2 - (node.x + node.w / 2);
      ty = rect.height / 2 - (node.y + node.h / 2);
      apply();
      for (const g of viewport.querySelectorAll('.node-g')) {
        g.classList.toggle('selected', g.dataset.node === String(id));
      }
    },
    fit,
  };

  container.append(svg);
  requestAnimationFrame(fit);
  return api;
}
