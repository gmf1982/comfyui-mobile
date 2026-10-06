/** 队列视图：运行中（实时进度+速度+显存+预览图）、待执行、中断/删除。 */
import { apiJson } from '../lib/api.js';
import { bus } from '../lib/api.js';
import { el, clear, toast, confirmDialog } from '../lib/ui.js';
import { viewUrl, thumbUrl, downloadMedia } from '../lib/media.js';
import { openMediaOverlay, sendToImageInput } from '../lib/media-actions.js';
import { extractMediaFromOutputs } from '../lib/workflow-form.js';
import { state, runStats, noteProgress, lastSubmittedId } from '../lib/state.js';
import { t, tf } from '../lib/i18n.js';

const progress = new Map(); // prompt_id → {pct, node}
let previewUrl = null;
/** 最近一次成功生成的结果（模块级：切页返回后仍在，避免重新拉全部历史） */
let lastResult = null;
let currentPromptId = null;

export async function queueView(container) {
  const runningBox = el('div', {});
  const pendingBox = el('div', {});
  const previewImg = el('img', { class: 'preview-img', alt: t('实时预览') });
  const previewCard = el('div', { class: 'card', style: { display: 'none' } },
    el('h3', { text: t('实时预览') }), previewImg);
  const statsLine = el('div', { class: 'muted', style: { marginTop: '6px' } });
  const resultCard = el('div', { class: 'card', style: { display: 'none' } });

  container.append(
    el('div', { class: 'row wrap', style: { marginBottom: '12px' } },
      el('button', { class: 'btn danger small', text: t('⏹ 中断当前'), onclick: interrupt }),
      el('button', { class: 'btn small', text: t('清空待执行'), onclick: clearPending }),
      el('button', { class: 'btn small', text: t('刷新'), onclick: () => refresh() }),
    ),
    previewCard,
    el('h3', { style: { margin: '4px 0 8px', fontSize: '15px' }, text: t('运行中') }),
    runningBox,
    el('h3', { style: { margin: '14px 0 8px', fontSize: '15px' }, text: t('待执行') }),
    pendingBox,
    resultCard,
  );

  function onWs(ev) {
    const msg = ev.detail;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'progress' && msg.data?.prompt_id) {
      noteProgress(msg.data.value ?? 0, msg.data.max ?? 0);
      progress.set(msg.data.prompt_id, {
        pct: Math.round(((msg.data.value ?? 0) / Math.max(1, msg.data.max ?? 1)) * 100),
        node: msg.data.node,
      });
      refresh();
    } else if (msg.type === 'progress_state') {
      // 新版事件：data.nodes.{id}.rate（it/s）——直接采用
      const nodes = msg.data?.nodes ?? {};
      for (const n of Object.values(nodes)) {
        if (n?.rate && Number.isFinite(Number(n.rate))) {
          runStats.rate = Number(n.rate);
          break;
        }
      }
    } else if (msg.type === 'execution_start') {
      if (!runStats.startedAt) runStats.startedAt = Date.now();
      currentPromptId = msg.data?.prompt_id ?? currentPromptId;
      refresh();
    } else if (msg.type === 'status' || msg.type === 'executing' || msg.type === 'execution_success' || msg.type === 'execution_error') {
      if (msg.type === 'execution_error' && msg.data) {
        toast(t('执行出错：') + (msg.data.exception_message ?? msg.data.node_type ?? t('未知错误')), 5000);
      }
      if (msg.type === 'execution_success') {
        currentPromptId = msg.data?.prompt_id ?? currentPromptId;
        // 生成结果就地展示（不跳图库，避免每次重载全部历史与图片）
        loadResult(msg.data?.prompt_id ?? currentPromptId);
      }
      refresh();
    }
  }
  function onPreview(ev) {
    previewUrl = ev.detail;
    previewImg.src = previewUrl;
    // 新一轮生成开始（或仍在生成）时恢复预览区；结果卡片保留在下方
    previewCard.style.display = '';
  }
  let alive = true; // 视图销毁后停掉 loadResult 的重试，避免写过期的 DOM
  bus.addEventListener('cm:ws', onWs);
  bus.addEventListener('cm:preview', onPreview);
  const timer = setInterval(refresh, 3000);
  const statsTimer = setInterval(pollVram, 3000);
  state.cleanup = () => {
    alive = false;
    bus.removeEventListener('cm:ws', onWs);
    bus.removeEventListener('cm:preview', onPreview);
    clearInterval(timer);
    clearInterval(statsTimer);
  };

  async function pollVram() {
    try {
      const stats = await apiJson('/system_stats');
      const dev = stats?.devices?.[0];
      if (dev?.vram_total != null && dev?.vram_free != null) {
        runStats.vramTotal = dev.vram_total;
        runStats.vramUsed = dev.vram_total - dev.vram_free;
      }
      updateStatsLine();
    } catch {
      // 显存读取失败不影响队列
    }
  }

  function fmtBytes(b) {
    return `${(b / 1024 ** 3).toFixed(1)} GB`;
  }

  function updateStatsLine() {
    const parts = [];
    if (runStats.rate) {
      parts.push(runStats.rate > 0 ? runStats.rate.toFixed(2) + t(' 步/秒') : t('速度：等待中'));
      if (runStats.eta) parts.push(t('约剩 ') + (runStats.eta >= 60 ? Math.floor(runStats.eta / 60) + t('分') + (runStats.eta % 60) + t('秒') : runStats.eta + t('秒')));
    }
    if (runStats.startedAt) {
      const secs = Math.round((Date.now() - runStats.startedAt) / 1000);
      parts.push(t('已运行 ') + (secs >= 60 ? Math.floor(secs / 60) + t('分') + (secs % 60) + t('秒') : secs + t('秒')));
    }
    if (runStats.vramUsed != null && runStats.vramTotal != null) {
      parts.push(t('显存 ') + fmtBytes(runStats.vramUsed) + ' / ' + fmtBytes(runStats.vramTotal));
    }
    statsLine.textContent = parts.join(' · ');
    statsLine.style.display = parts.length ? '' : 'none';
  }

  /** 取回本次生成的结果并在队列页内渲染（缩略图用 WebP，点开才载原图）。
   *  quiet：对账时静默（不弹“生成完成”）；attempt：history 落盘竞态的重试计数。 */
  async function loadResult(promptId, { quiet = false, attempt = 0 } = {}) {
    if (!promptId) return;
    try {
      const h = await apiJson(`/history/${encodeURIComponent(promptId)}`);
      const entry = h?.[promptId];
      const items = extractMediaFromOutputs(entry?.outputs ?? {}, { compare: true, version: entry?.prompt?.[0] ?? null });
      if (!items.length) {
        // history 落盘略晚于 execution_success 时会拉到空：稍后重试，避免本次结果丢失
        if (alive && attempt < 3) setTimeout(() => loadResult(promptId, { quiet, attempt: attempt + 1 }), 1500);
        return;
      }
      const msgs = entry?.status?.messages ?? [];
      const st = msgs.find((m) => m[0] === 'execution_start')?.[1]?.timestamp;
      const su = msgs.find((m) => m[0] === 'execution_success')?.[1]?.timestamp;
      // 优先用 ComfyUI 的时间戳；缺失时回退到客户端计时（提交时开始）
      const durationMs = st && su ? su - st : (runStats.startedAt ? Date.now() - runStats.startedAt : null);
      lastResult = { promptId, items, durationMs, promptJson: entry?.prompt?.[2] ?? null };
      renderResult();
      if (!quiet) toast(t('生成完成，结果见上方'));
    } catch {
      // 结果拉取失败不阻塞队列页
    }
  }

  /**
   * 切页/刷新期间会错过 execution_success 推送（视图监听器已解绑，WS 是全局的），
   * 而结果卡是纯事件驱动 + 模块级缓存——切回后只会显示上一次的结果。
   * 进入本页时按最近一次提交的 prompt_id 对账一次 /history 补上。
   */
  function reconcileResult() {
    const pid = lastSubmittedId() ?? currentPromptId;
    if (pid && lastResult?.promptId !== pid) loadResult(pid, { quiet: true });
  }

  /** 把毫秒格式化为「用时 X」，极短（缓存命中）时额外标注。 */
  function formatDuration(ms) {
    if (ms == null) return '';
    if (ms < 1000) return '用时 ' + ms + ' 毫秒（缓存命中，未重新计算）';
    const secs = ms / 1000;
    const text = secs >= 60
      ? Math.floor(secs / 60) + ' 分 ' + Math.round(secs % 60) + ' 秒'
      : (secs >= 10 ? Math.round(secs) : secs.toFixed(1)) + ' 秒';
    return '用时 ' + text;
  }

  function renderResult() {
    if (!lastResult?.items?.length) {
      resultCard.style.display = 'none';
      return;
    }
    const { items, durationMs } = lastResult;
    resultCard.style.display = '';
    // 有结果时不再显示生成过程中的实时预览，避免同一图出现两次
    previewCard.style.display = 'none';
    resultCard.replaceChildren(
      el('div', { class: 'row' },
        el('div', { class: 'grow' },
          el('h3', { style: { margin: 0 }, text: t('本次生成结果') }),
          el('div', { class: 'muted', text: tf('{n} 项', { n: items.length }) + (durationMs != null ? ' · ' + formatDuration(durationMs) : '') }),
        ),
        el('button', { class: 'btn small', text: '图库', onclick: () => { location.hash = '/gallery'; } }),
      ),
    );
    // 按节点分组：同一节点的 a_images+b_images 合成一个滑块对比控件，其余逐项渲染
    const byNode = new Map();
    for (const item of items) {
      if (!byNode.has(item.nodeId)) byNode.set(item.nodeId, []);
      byNode.get(item.nodeId).push(item);
    }
    for (const nodeItems of byNode.values()) {
      const before = nodeItems.find((i) => i.key === 'a_images');
      const after = nodeItems.find((i) => i.key === 'b_images');
      if (before && after) {
        resultCard.append(compareBox(before, after));
        continue;
      }
      for (const item of nodeItems) resultCard.append(itemBox(item));
    }
  }

  /** 单个媒体项卡片（图/视频/音频 + 文件名 + 操作按钮）。 */
  function itemBox(item) {
    const box = el('div', { style: { marginTop: '10px' } });
    if (item.mediaType === 'image') {
      // 结果卡用 1024px 缩略图（原图几 MB 的 PNG 会拖慢整页）；点开大图才加载原图
      const img = el('img', {
        loading: 'lazy', decoding: 'async',
        src: thumbUrl(item, 80, 1024),
        alt: item.filename,
        style: { width: '100%', height: 'auto', borderRadius: '12px', display: 'block' },
      });
      img.addEventListener('click', () => openMediaOverlay(item, { promptJson: lastResult.promptJson, durationMs: lastResult.durationMs }));
      box.append(img);
    } else if (item.mediaType === 'video') {
      box.append(el('video', { src: viewUrl(item), controls: '', playsinline: '', preload: 'metadata', style: { width: '100%', borderRadius: '12px' } }));
    } else {
      box.append(el('audio', { src: viewUrl(item), controls: '', style: { width: '100%' } }));
    }
    box.append(el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px', wordBreak: 'break-all' },
      text: item.filename + (lastResult.durationMs != null ? ' · ' + formatDuration(lastResult.durationMs) : '') + compareLabel(item) }));
    box.append(el('div', { class: 'row wrap', style: { marginTop: '6px' } },
      el('button', { class: 'btn small primary', text: t('⬇ 保存到手机'), onclick: () => downloadMedia(item) }),
      item.mediaType === 'image'
        ? el('button', { class: 'btn small', text: t('📤 用作图片输入'), onclick: () => sendToImageInput(item) })
        : null,
      el('button', { class: 'btn small', text: t('🔍 查看大图'), onclick: () => openMediaOverlay(item, { promptJson: lastResult.promptJson, durationMs: lastResult.durationMs }) }),
    ));
    return box;
  }

  /**
   * 新旧对比控件：history 里没有合成图，滑块是桌面端前端的功能，这里用两张
   * 临时图（a=编辑前、b=编辑后）自制——b 垫底，a 在上层用 clip-path 揭示，
   * 左右拖分隔线对比；默认各露一半。
   */
  function compareBox(before, after) {
    const box = el('div', { style: { marginTop: '10px' } });
    let clipPct = 50;
    const topLayer = el('div', { style: { position: 'absolute', inset: '0', pointerEvents: 'none' } });
    const divider = el('div', {
      style: { position: 'absolute', top: '0', bottom: '0', width: '2px', background: '#fff',
        boxShadow: '0 0 4px rgba(0,0,0,.7)', transform: 'translateX(-1px)', pointerEvents: 'none' },
    });
    const applyClip = () => {
      topLayer.style.clipPath = `inset(0 ${100 - clipPct}% 0 0)`;
      divider.style.left = clipPct + '%';
    };
    const imgBefore = el('img', {
      src: thumbUrl(before, 80, 1024), alt: before.filename, decoding: 'async',
      style: { width: '100%', height: '100%', objectFit: 'fill', display: 'block' },
    });
    topLayer.append(imgBefore);
    const wrap = el('div', {
      // pan-y 留给分隔线拖动；pinch-zoom 允许浏览器在图上捏合缩放页面
      style: { position: 'relative', overflow: 'hidden', borderRadius: '12px', touchAction: 'pan-y pinch-zoom', background: 'var(--bg)' },
    });
    const imgAfter = el('img', {
      src: thumbUrl(after, 80, 1024), alt: after.filename, decoding: 'async',
      style: { width: '100%', height: 'auto', display: 'block' },
    });
    imgAfter.addEventListener('load', () => {
      // 以编辑后图的宽高比定容器高度；编辑前图拉伸铺满（同尺寸工作流下逐像素对齐）
      wrap.style.aspectRatio = `${imgAfter.naturalWidth} / ${imgAfter.naturalHeight}`;
      applyClip();
    });
    wrap.append(imgAfter, topLayer, divider);

    // 拖动分隔线；只有"单指且任何方向都几乎没动"的点按才算轻点进大图——
    // 上下拖（页面滚动，浏览器会接管并发 pointercancel）与双指捏合都不触发
    let dragging = false;
    let multi = false;
    let downX = 0;
    let downY = 0;
    let movedFar = false;
    const setFromEvent = (ev) => {
      const rect = wrap.getBoundingClientRect();
      clipPct = Math.max(0, Math.min(100, ((ev.clientX - rect.left) / rect.width) * 100));
      applyClip();
    };
    wrap.addEventListener('pointerdown', (ev) => {
      if (dragging) { multi = true; movedFar = true; return; } // 第二根手指：捏合，不算轻点
      dragging = true;
      multi = false;
      downX = ev.clientX;
      downY = ev.clientY;
      movedFar = false;
      try { wrap.setPointerCapture(ev.pointerId); } catch { /* 合成 pointerId 无法捕获，不影响拖动 */ }
      setFromEvent(ev);
    });
    wrap.addEventListener('pointermove', (ev) => {
      if (!dragging || multi) return;
      if (Math.abs(ev.clientX - downX) > 6 || Math.abs(ev.clientY - downY) > 6) movedFar = true;
      setFromEvent(ev);
    });
    const release = (ev) => {
      if (!dragging) return;
      dragging = false;
      if (multi || ev.type !== 'pointerup' || movedFar) return;
      openMediaOverlay(after, { promptJson: lastResult.promptJson, durationMs: lastResult.durationMs });
    };
    wrap.addEventListener('pointerup', release);
    wrap.addEventListener('pointercancel', release);
    applyClip();

    box.append(
      wrap,
      el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' },
        text: t('新旧对比 · 左右拖动分隔线') + (lastResult.durationMs != null ? ' · ' + formatDuration(lastResult.durationMs) : '') }),
      el('div', { class: 'row wrap', style: { marginTop: '6px' } },
        el('button', { class: 'btn small', text: t('🔍 查看大图'), onclick: () => openMediaOverlay(after, { promptJson: lastResult.promptJson, durationMs: lastResult.durationMs }) }),
      ),
    );
    return box;
  }

  /** 未配对的对比输出（只有 a 或只有 b）仍单独展示，加可读标签。 */
  function compareLabel(item) {
    if (item.key === 'a_images') return t('（对比·编辑前）');
    if (item.key === 'b_images') return t('（对比·编辑后）');
    return '';
  }

  async function interrupt() {
    try {
      await apiJson('/interrupt', { method: 'POST' });
      toast(t('已发送中断请求'));
    } catch (err) {
      toast(t('中断失败：') + err.message);
    }
    refresh();
  }

  async function clearPending() {
    const ids = pendingIds.splice(0);
    if (!ids.length) return;
    if (!(await confirmDialog(tf('清空 {n} 个待执行任务？', { n: ids.length })))) {
      pendingIds.push(...ids);
      return;
    }
    try {
      await apiJson('/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: ids }),
      });
      toast(t('已清空'));
    } catch (err) {
      toast(t('清空失败：') + err.message);
    }
    refresh();
  }

  let pendingIds = [];

  async function refresh() {
    let data;
    try {
      data = await apiJson('/queue');
    } catch {
      return; // 401 已由全局处理；瞬时网络错误静默等下一轮
    }
    const running = data?.queue_running ?? [];
    const pending = data?.queue_pending ?? [];
    pendingIds = pending.map((entry) => entry[1]).filter(Boolean);
    if (!running.length && runStats.startedAt) {
      runStats.startedAt = null;
      runStats.rate = null;
    }
    updateStatsLine();

    clear(runningBox);
    if (!running.length) {
      runningBox.append(el('div', { class: 'card muted', text: t('当前没有正在执行的任务') }));
    }
    for (const entry of running) {
      const id = entry[1];
      const p = progress.get(id);
      const card = el('div', { class: 'card' },
        el('div', { class: 'row' },
          el('div', { class: 'grow' }, el('div', { class: 'title', text: tf('任务 {id}…', { id: id.slice(0, 8) }) })),
          el('button', { class: 'btn small danger', text: t('删除'), onclick: () => deleteQueueItem(id) }),
        ),
        el('div', { class: 'progress', style: { marginTop: '10px' } },
          el('div', { style: { width: `${p?.pct ?? 4}%` } }),
        ),
        el('div', { class: 'muted', style: { marginTop: '6px' }, text: p ? t('节点 ') + p.node + ' · ' + p.pct + '%' : t('等待节点数据…') }),
        statsLine,
      );
      runningBox.append(card);
    }

    clear(pendingBox);
    if (!pending.length) {
      pendingBox.append(el('div', { class: 'card muted', text: t('队列为空') }));
    }
    for (const entry of pending) {
      const id = entry[1];
      pendingBox.append(el('div', { class: 'list-item' },
        el('div', { class: 'grow title', text: tf('任务 {id}…', { id: id.slice(0, 8) }) }),
        el('button', { class: 'btn small danger', text: '✕', onclick: () => deleteQueueItem(id) }),
      ));
    }
  }

  async function deleteQueueItem(id) {
    try {
      await apiJson('/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [id] }),
      });
      toast(t('已删除'));
    } catch (err) {
      toast(t('删除失败：') + err.message);
    }
    refresh();
  }

  renderResult();
  await refresh();
  pollVram();
  reconcileResult();
}
