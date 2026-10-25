/**
 * 媒体操作共享模块：详情浮层与「用作图片输入」。
 * 图库与队列页（生成结果预览）共用，避免两处重复实现。
 */
import { apiJson, uploadMedia, ensureSchemas } from './api.js';
import { el, toast, showOverlay, hideOverlay, showSheet, hideSheet } from './ui.js';
import { viewUrl, downloadMedia } from './media.js';
import { buildFormModel, listApiNodes } from './workflow-form.js';
import { state, rememberedWorkflow, saveWorkflowParam } from './state.js';
import { t, tf } from './i18n.js';

/**
 * 打开媒体详情浮层。
 * @param {{filename?: string, name?: string, subfolder?: string, type?: string, mediaType: string,
 *          fileUrl?: string, downloadUrl?: string, path?: string}} item
 * @param {{promptJson?: object|null, durationMs?: number|null, onDelete?: Function|null,
 *          getPromptJson?: (item: object) => Promise<object|null>,
 *          list?: Array<{item: object, promptJson?: object|null, durationMs?: number|null, onDelete?: Function|null>}|null}} options
 * 传 list（按浏览顺序排好、且包含 item 本身的媒体选项数组）时启用左右翻页：
 * 两侧箭头点按 + 图片区域左右滑动；不传则行为与单张浮层一致。
 * 图片额外支持双指捏合缩放、放大后单指拖动平移、双击在 1x/2.5x 间切换。
 * 传 getPromptJson 时（目录直读场景，promptJson 未知）：图片类型会在浮层打开后
 * 异步获取提示词元数据，拿到后就地补上「复制提示词/用此参数重跑」按钮。
 */
export function openMediaOverlay(item, options = {}) {
  let list = null;
  let index = -1;
  if (Array.isArray(options.list) && options.list.length > 1) {
    const i = options.list.findIndex((li) => li?.item === item);
    if (i >= 0) { list = options.list; index = i; }
  }
  // 每次重建内容自增；异步补充的按钮（如 PNG 元数据提取的提示词）凭序号判断是否过期
  let buildSeq = 0;
  showOverlay(buildContent());

  function buildContent() {
    buildSeq++;
    const seq = buildSeq;
    const cur = list ? list[index] : options;
    const media = cur?.item ?? item;
    const { promptJson = null, durationMs = null, onDelete = null } = cur;
    const body = el('div', { class: 'overlay-body' });
    if (media.mediaType === 'image') {
      body.append(el('img', { src: viewUrl(media), alt: media.filename ?? media.name ?? '' }));
    } else if (media.mediaType === 'video') {
      body.append(el('video', { src: viewUrl(media), controls: '', playsinline: '', preload: 'metadata' }));
    } else {
      body.append(el('audio', { src: viewUrl(media), controls: '' }));
    }
    attachGestures(body, body.querySelector('img'));
    // 音频元素细窄且垂直居中，翻页箭头会正好压在播放键/菜单上，因此音频只保留滑动翻页
    if (list && media.mediaType !== 'audio') {
      if (index > 0) {
        body.append(el('button', {
          class: 'nav-arrow prev', text: '‹', 'aria-label': t('上一张'),
          onclick: () => navigate(-1),
        }));
      }
      if (index < list.length - 1) {
        body.append(el('button', {
          class: 'nav-arrow next', text: '›', 'aria-label': t('下一张'),
          onclick: () => navigate(1),
        }));
      }
    }

    const info = el('div', { class: 'muted', style: { padding: '8px 14px', textAlign: 'center' },
      text: (list ? `${index + 1} / ${list.length} · ` : '') + (media.filename ?? media.name ?? '')
        + (durationMs ? t(' · 用时 ') + (durationMs / 1000).toFixed(1) + t(' 秒') : '') });

    const actions = el('div', { class: 'overlay-actions' },
      el('button', { class: 'btn', text: t('关闭'), onclick: hideOverlay }),
      el('button', { class: 'btn primary', text: t('⬇ 保存到手机'), onclick: () => downloadMedia(media) }),
    );
    const promptText = positivePromptText(promptJson);
    if (promptText) {
      actions.append(el('button', {
        class: 'btn', text: t('📋 复制提示词'),
        onclick: async () => toast(await copyText(promptText) ? t('已复制提示词') : t('复制失败')),
      }));
    }    if (media.mediaType === 'image') {
      actions.append(el('button', { class: 'btn', text: t('📤 用作图片输入'), onclick: () => { hideOverlay(); sendToImageInput(media); } }));
    }
    if (promptJson) {
      actions.append(el('button', {
        class: 'btn', text: t('用此参数重跑'),
        onclick: () => {
          state.workflow = null;
          import('./state.js').then(({ setWorkflow }) => {
            setWorkflow({ name: t('历史 ') + ((media.promptId ?? '').slice(0, 8) || t('历史参数')), path: null, json: JSON.parse(JSON.stringify(promptJson)), format: 'api' });
            hideOverlay();
            location.hash = '/run';
          });
        },
      }));
    } else if (options.getPromptJson && media.mediaType === 'image') {
      // 目录直读条目没有 history：从 PNG 元数据异步提取提示词，拿到后就地补上按钮
      Promise.resolve(options.getPromptJson(media)).then((pj) => {
        if (seq !== buildSeq || !pj) return;
        cur.promptJson = pj; // 记住结果，翻页回来不再请求
        const delBtn = [...actions.children].find((b) => b.classList.contains('danger'));
        const insert = (btn) => (delBtn ? actions.insertBefore(btn, delBtn) : actions.append(btn));
        const text = positivePromptText(pj);
        if (text) {
          insert(el('button', {
            class: 'btn', text: t('📋 复制提示词'),
            onclick: async () => toast(await copyText(text) ? t('已复制提示词') : t('复制失败')),
          }));
        }
        insert(el('button', {
          class: 'btn', text: t('用此参数重跑'),
          onclick: () => {
            state.workflow = null;
            import('./state.js').then(({ setWorkflow }) => {
              setWorkflow({ name: t('历史 ') + ((media.promptId ?? '').slice(0, 8) || t('历史参数')), path: null, json: JSON.parse(JSON.stringify(pj)), format: 'api' });
              hideOverlay();
              location.hash = '/run';
            });
          },
        }));
      }).catch(() => {});
    }
    if (onDelete) {
      actions.append(el('button', { class: 'btn danger', text: t('🗑 删除'), onclick: () => { hideOverlay(); onDelete(media); } }));
    }
    return el('div', { class: 'overlay-frame' }, body, info, actions);
  }

  function navigate(delta) {
    const next = index + delta;
    if (next < 0 || next >= list.length) return;
    index = next;
    showOverlay(buildContent());
  }

  /**
   * 图片手势：双指捏合缩放（锚定捏合中点）、放大后单指拖动平移、双击在 1x/2.5x 间切换；
   * scale=1 时单指水平滑动翻页（有 list 才生效），视频/音频只保留滑动翻页。
   * img 是 pointer-events:none，事件全部落在容器上；图片区 touch-action 必须为 none，
   * 否则浏览器会把双指抢去整页缩放或直接 pointercancel，捏合收不到完整事件。
   * 变换为 translate(tx,ty) scale(s)（先缩放后平移，transform-origin 是图中心）。
   */
  function attachGestures(body, img) {
    body.style.touchAction = img ? 'none' : 'pan-y';
    const pointers = new Map();
    let scale = 1, tx = 0, ty = 0;
    let pinch = null; // {d0, mx0, my0, cx, cy, s0, tx0, ty0}
    let pan = null;   // {px, py}
    let swipe = null; // {x, y, horiz}
    let lastTap = 0, lastX = 0, lastY = 0;

    const clampPan = () => {
      const maxX = Math.max(0, (img.clientWidth * scale - body.clientWidth) / 2);
      const maxY = Math.max(0, (img.clientHeight * scale - body.clientHeight) / 2);
      tx = Math.max(-maxX, Math.min(maxX, tx));
      ty = Math.max(-maxY, Math.min(maxY, ty));
    };
    const apply = () => {
      if (!img) return;
      clampPan();
      img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    };

    body.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, video, audio')) return;
      try { body.setPointerCapture(e.pointerId); } catch { /* 指针已释放 */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        if (!img) return; // 视频/音频不缩放
        const [a, b] = [...pointers.values()];
        const rect = img.getBoundingClientRect();
        swipe = null; pan = null;
        pinch = {
          d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          mx0: (a.x + b.x) / 2, my0: (a.y + b.y) / 2,
          cx: rect.left + rect.width / 2 - tx, cy: rect.top + rect.height / 2 - ty,
          s0: scale, tx0: tx, ty0: ty,
        };
        return;
      }
      if (pointers.size !== 1) return;
      const now = Date.now();
      const isDouble = now - lastTap < 300 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 30;
      lastTap = isDouble ? 0 : now; lastX = e.clientX; lastY = e.clientY;
      if (img && scale > 1) {
        swipe = null;
        if (isDouble) {
          img.style.transition = 'transform 0.25s ease';
          scale = 1; tx = 0; ty = 0; apply();
        } else {
          pan = { px: e.clientX, py: e.clientY };
        }
      } else if (img && isDouble) {
        swipe = null;
        img.style.transition = 'transform 0.25s ease';
        const rect = img.getBoundingClientRect();
        scale = 2.5;
        tx = (1 - scale) * (e.clientX - (rect.left + rect.width / 2));
        ty = (1 - scale) * (e.clientY - (rect.top + rect.height / 2));
        apply();
      } else {
        swipe = { x: e.clientX, y: e.clientY, horiz: false };
      }
    });

    body.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX; p.y = e.clientY;
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const s1 = Math.min(5, Math.max(1, (pinch.s0 * d) / pinch.d0));
        const k = s1 / pinch.s0;
        // 保持捏合中点下的图像位置不动
        tx = (a.x + b.x) / 2 - pinch.cx - k * (pinch.mx0 - pinch.cx - pinch.tx0);
        ty = (a.y + b.y) / 2 - pinch.cy - k * (pinch.my0 - pinch.cy - pinch.ty0);
        scale = s1;
        apply();
      } else if (pan && pointers.size === 1) {
        tx += e.clientX - pan.px; ty += e.clientY - pan.py;
        pan = { px: e.clientX, py: e.clientY };
        apply();
      } else if (swipe) {
        const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
        if (!swipe.horiz && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          swipe.horiz = true;
        }
      }
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pinch) {
        if (pointers.size < 2) {
          pinch = null;
          if (scale <= 1.001) { scale = 1; tx = 0; ty = 0; }
          apply();
          const [q] = [...pointers.values()];
          if (q) pan = { px: q.x, py: q.y }; // 剩下的一指接续为平移
        }
        return;
      }
      if (list && e.type === 'pointerup' && swipe) {
        const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
        if (swipe.horiz && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) navigate(dx < 0 ? 1 : -1);
      }
      swipe = null;
      pan = null;
    };
    body.addEventListener('pointerup', end);
    body.addEventListener('pointercancel', end);
  }
}

/**
 * 从 API 格式工作流 JSON 提取正向提示词文本。
 * 文本可能不在采样器直连的编码节点 text 里，而是经由「easy positive」等
 * 提示词输入节点（文本在 positive 输入上）串进 positive 连线，因此：
 * 先从含 positive/negative 输入的节点出发沿连线向上爬（最多 6 层），逐层在
 * text/prompt/positive_prompt/positive 输入里找非空文本；找不到再全图兜底扫一遍。
 */
const POS_TEXT_INPUT_NAMES = ['text', 'prompt', 'positive_prompt', 'positive'];

function positivePromptText(promptJson) {
  if (!promptJson || typeof promptJson !== 'object') return '';
  const nodes = Object.values(promptJson).filter((n) => n && typeof n === 'object');
  const samplers = nodes.filter((n) => n.inputs && 'positive' in n.inputs && 'negative' in n.inputs);
  const seen = new Set();
  for (const sampler of samplers) {
    const link = sampler.inputs.positive;
    const start = Array.isArray(link) ? promptJson[link[0]] : null;
    const text = linkedTextOf(promptJson, start, 6, seen);
    if (text) return text;
  }
  for (const node of nodes) {
    const text = linkedTextOf(promptJson, node, 3, seen);
    if (text) return text;
  }
  return '';
}

function linkedTextOf(promptJson, node, hops, seen) {
  if (!node || hops < 0 || seen.has(node)) return '';
  seen.add(node);
  for (const name of POS_TEXT_INPUT_NAMES) {
    const v = node.inputs?.[name];
    if (typeof v === 'string' && v.trim()) return v;
  }
  if (hops === 0) return '';
  for (const v of Object.values(node.inputs ?? {})) {
    if (Array.isArray(v) && typeof v[0] === 'string' && promptJson[v[0]]) {
      const found = linkedTextOf(promptJson, promptJson[v[0]], hops - 1, seen);
      if (found) return found;
    }
  }
  return '';
}

/** 写剪贴板：优先 async Clipboard API，非安全上下文（HTTP 局域网）退回 execCommand。 */
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* 权限拒绝/非安全上下文，走兜底 */ }
  }
  const ta = el('textarea', { style: { position: 'fixed', top: '-999px', opacity: '0' }, text });
  document.body.append(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* 老内核可能直接抛错 */ }
  ta.remove();
  return ok;
}

/** 把当前工作流已有的图片输入位列出来供选择。 */
function pickTargetSheet(wfState, uploadedName, onDone) {
  const mediaFields = wfState?._mediaFields ?? [];
  if (!mediaFields.length) {
    toast(t('当前工作流没有图片输入位'));
    return;
  }
  const sheet = el('div', {}, el('h3', { text: t('设为哪个图片输入？') }));
  for (const f of mediaFields) {
    sheet.append(el('button', {
      class: 'btn', style: { width: '100%', marginBottom: '6px', justifyContent: 'flex-start' },
      text: f.label + (f.value ? t('（当前 ') + f.value + t('）') : ''),
      onclick: () => {
        wfState.json[String(f.nodeId)].inputs[f.inputName] = uploadedName;
        // run 页恢复表单值时缓存优先于 JSON，必须同步写缓存，否则选中的图会被旧缓存覆盖
        saveWorkflowParam(wfState, f.key, uploadedName);
        hideSheet();
        toast(t('已设为 ') + f.label + '：' + uploadedName);
        location.hash = '/run';
        onDone?.();
      },
    }));
  }
  sheet.append(el('button', { class: 'btn', style: { width: '100%', marginTop: '8px' }, text: t('取消'), onclick: hideSheet }));
  showSheet(sheet);
}

/**
 * 把一张图库/结果图复制到 input 目录并设为当前工作流的图片输入。
 * 若当前没有工作流（例如刷新后），先让用户选一个再继续。
 * @param {object} item 媒体条目
 */
export async function sendToImageInput(item) {
  try {
    toast(t('复制图片到 input 目录…'));
    const res = await fetch(viewUrl(item));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const file = new File([blob], 'ref_' + (item.filename ?? item.name ?? 'image.png'), { type: blob.type || 'image/png' });
    const up = await uploadMedia(file, { compress: false });

    let wfState = state.workflow;
    if (!wfState) {
      // 刷新后内存态丢失：让用户选一个工作流后继续
      const paths = await apiJson('/userdata?dir=workflows&recurse=true&split=false').catch(() => []);
      const last = rememberedWorkflow();
      const sheet = el('div', {}, el('h3', { text: t('先选择要用的工作流') }));
      sheet.append(el('div', { class: 'muted', style: { marginBottom: '8px' }, text: t('选好后会自动把这张图设为它的图片输入。') }));
      const list = [...(paths ?? [])].sort((a, b) => (a === last?.path ? -1 : b === last?.path ? 1 : a.localeCompare(b)));
      if (!list.length) sheet.append(el('div', { class: 'muted', text: t('没有找到工作流，请先在工作流页新建或导入。') }));
      for (const path of list.slice(0, 40)) {
        const isLast = path === last?.path;
        sheet.append(el('button', {
          class: 'btn' + (isLast ? ' primary' : ''), style: { width: '100%', marginBottom: '6px', justifyContent: 'flex-start', textAlign: 'left' },
          text: path + (isLast ? t('（最近使用）') : ''),
          onclick: async () => {
            hideSheet();
            toast(t('正在载入 ') + path + '…');
            const { loadWorkflowFromPath } = await import('../views/workflows.js');
            const ok = await loadWorkflowFromPath(path, { navigate: false, silent: true });
            if (!ok) { toast(t('载入失败：无法读取或转换该工作流')); return; }
            await continueWithUpload(up.name);
          },
        }));
      }
      sheet.append(el('button', { class: 'btn', style: { width: '100%', marginTop: '8px' }, text: t('取消'), onclick: hideSheet }));
      showSheet(sheet);
      return;
    }
    await continueWithUpload(up.name);
  } catch (err) {
    toast(t('发送失败：') + err.message);
  }
}

async function continueWithUpload(uploadedName) {
  const wfState = state.workflow;
  if (!wfState) return;
  const nodes = listApiNodes(wfState.json);
  const schemas = await ensureSchemas(nodes.map((n) => n.class_type));
  const model = buildFormModel({ workflow: wfState.json, schemas });
  wfState._mediaFields = model.heroes.filter((f) => f.kind === 'media' && f.mediaKind === 'image');
  pickTargetSheet(wfState, uploadedName);
}
