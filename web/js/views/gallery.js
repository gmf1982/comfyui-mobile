/** 图库视图：历史结果浏览（图片/视频/音频）、详情、保存/分享/重跑。 */
import { apiJson } from '../lib/api.js';
import { el, clear, toast, showOverlay, hideOverlay, confirmDialog } from '../lib/ui.js';
import { extractMediaFromOutputs } from '../lib/workflow-form.js';
import { thumbUrl, viewUrl } from '../lib/media.js';
import { openMediaOverlay } from '../lib/media-actions.js';
import { state } from '../lib/state.js';
import { t, tf } from '../lib/i18n.js';

const TYPE_FILTERS = [
  { key: 'all', label: t('全部') },
  { key: 'image', label: t('图片') },
  { key: 'video', label: t('视频') },
  { key: 'audio', label: t('音频') },
];

export async function galleryView(container) {
  const chips = el('div', { class: 'chips' });
  const grid = el('div', { class: 'gallery-grid' });
  const pendingBar = el('div', { class: 'card', style: { display: 'none', borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border))' } });
  container.append(
    el('div', { class: 'row', style: { marginBottom: '8px' } },
      el('button', { class: 'btn small', text: t('刷新'), onclick: () => load() }),
      el('span', { class: 'muted', id: 'gallery-count' }),
    ),
    pendingBar,
    chips,
    grid,
  );

  /** 本次会话已删除的条目（不立即重排列表，避免删一张跳一次） */
  const deletedIds = new Set();
  let deletedFiles = 0;

  function renderPendingBar() {
    if (!deletedIds.size) {
      pendingBar.style.display = 'none';
      return;
    }
    pendingBar.style.display = '';
    pendingBar.replaceChildren(el('div', { class: 'row' },
      el('div', { class: 'grow', style: { fontSize: '14px' }, text: tf('已删除 {n} 项{files}，点刷新更新列表', { n: deletedIds.size, files: deletedFiles ? tf('（含 {n} 个文件）', { n: deletedFiles }) : '' }) }),
      el('button', { class: 'btn small primary', text: t('刷新列表'), onclick: () => load() }),
    ));
  }

  let filter = 'all';

  for (const f of TYPE_FILTERS) {
    chips.append(el('button', {
      class: 'chip' + (f.key === filter ? ' active' : ''),
      'data-filter': f.key,
      text: f.label,
      onclick: () => {
        filter = f.key;
        for (const c of chips.children) c.classList.toggle('active', c.dataset.filter === filter);
        render();
      },
    }));
  }

  let entries = [];

  async function load() {
    clear(grid).append(el('div', { class: 'muted', text: t('加载中…') }));
    try {
      const data = await apiJson(`/history?max_items=${state.settings.maxItems}`);
      entries = Object.values(data ?? {})
        .filter((e) => e?.prompt)
        .sort((a, b) => (b.prompt[0] ?? 0) - (a.prompt[0] ?? 0))
        .map((e) => ({
          promptId: e.prompt[1],
          promptJson: e.prompt[2],
          durationMs: (() => {
            const msgs = e.status?.messages ?? [];
            const st = msgs.find((m) => m[0] === 'execution_start')?.[1]?.timestamp;
            const su = msgs.find((m) => m[0] === 'execution_success')?.[1]?.timestamp;
            const d = st && su ? su - st : null;
            return d != null && d > 900 ? d : null;
          })(),
          status: e.status?.status_str,
          error: e.status?.messages?.find((m) => m[0] === 'execution_error')?.[1],
          media: extractMediaFromOutputs(e.outputs, { version: e.prompt[0] }),
        }));
      renderPendingBar();
      render();
    } catch (err) {
      clear(grid).append(el('div', { class: 'card error-card' }, el('p', { text: t('加载历史失败：') + err.message })));
    }
  }

  function render() {
    clear(grid);
    let shown = 0;
    for (const entry of entries) {
      if (entry.error) {
        if (filter === 'all') {
          grid.append(errorTile(entry));
          shown++;
        }
        continue;
      }
      for (const item of entry.media) {
        if (filter !== 'all' && item.mediaType !== filter) continue;
        grid.append(mediaTile(entry, item));
        shown++;
      }
    }
    document.getElementById('gallery-count').textContent = shown ? tf('共 {n} 项', { n: shown }) : '';
    if (!shown) {
      grid.append(el('div', { class: 'empty', style: { gridColumn: '1 / -1' } },
        el('div', { class: 'big', text: '🖼️' }),
        el('div', { text: t('还没有生成结果，去「运行」页生成一个吧') }),
      ));
    }
  }

  function errorTile(entry) {
    const tile = el('div', { class: 'tile', 'data-prompt': entry.promptId },
      el('div', { class: 'tile-ico', text: '⚠️' }),
      el('div', { class: 'tile-name', text: t('失败：') + (entry.error?.exception_message ?? entry.promptId.slice(0, 8)) }),
    );
    tile.addEventListener('click', () => showEntryDetail(entry, null));
    return tile;
  }

  function mediaTile(entry, item) {
    const tile = el('div', { class: 'tile', 'data-prompt': entry.promptId });
    if (item.mediaType === 'image') {
      // 磁贴用 448px WebP（实测 ≈40KB/张）；原图留到点开时加载
      tile.append(el('img', { loading: 'lazy', decoding: 'async', src: thumbUrl(item, 50, 448), alt: item.filename }));
    } else if (item.mediaType === 'video') {
      // 视频首帧缩略图：metadata 预载 + #t=0.1 定位到开头；失败时露出底下的图标
      tile.append(el('div', { class: 'tile-ico', text: '🎬' }));
      tile.append(el('video', {
        class: 'tile-video', loading: 'lazy', preload: 'metadata', muted: '', playsinline: '',
        src: viewUrl(item) + '#t=0.1',
      }));
    } else {
      tile.append(el('div', { class: 'tile-ico', text: '🎵' }));
    }
    const secs = entry.durationMs ? Math.round(entry.durationMs / 1000) : null;
    const dur = secs != null ? (secs >= 60 ? Math.floor(secs / 60) + '分' + (secs % 60) + '秒' : secs + '秒') : '';
    tile.append(el('div', { class: 'tile-name', text: item.filename + (dur ? ' · ' + dur : '') }));
    if (deletedIds.has(entry.promptId)) {
      tile.classList.add('tile-deleted');
      tile.append(el('div', { class: 'tile-deleted-tag', text: t('已删除') }));
      return tile;
    }
    // 角标删除按钮（点按不触发大图预览）
    const delBtn = el('button', {
      class: 'tile-del', title: t('删除这张图片'), text: '🗑',
      onclick: (ev) => {
        ev.stopPropagation();
        deleteEntry(entry, item);
      },
    });
    tile.append(delBtn);
    tile.addEventListener('click', () => showEntryDetail(entry, item));
    return tile;
  }

  function showEntryDetail(entry, item) {
    if (!item) {
      // 报错条目：展示异常详情
      const pre = el('pre', {});
      pre.textContent = JSON.stringify({
        node_type: entry.error?.node_type,
        exception: entry.error?.exception_message,
        traceback: entry.error?.traceback?.slice(-1200),
      }, null, 2);
      showOverlay(el('div', {},
        el('div', { class: 'overlay-body' },
          el('div', { class: 'card error-card', style: { maxWidth: '92vw', overflow: 'auto', maxHeight: '60dvh' } }, pre)),
        el('div', { class: 'overlay-actions' },
          el('button', { class: 'btn', text: t('关闭'), onclick: hideOverlay }),
          el('button', { class: 'btn danger', text: t('🗑 删除'), onclick: () => { hideOverlay(); deleteEntry(entry, null); } }),
        ),
      ));
      return;
    }
    openMediaOverlay(item, {
      promptJson: entry.promptJson,
      durationMs: entry.durationMs,
      onDelete: () => deleteEntry(entry, item),
    });
  }

  /**
   * 删除一条图库结果：先从 ComfyUI 历史中移除（必定生效），
   * 再尽力删除磁盘文件（需网关配置 outputDir），并如实告知结果。
   */
  async function deleteEntry(entry, item) {
    const label = item?.filename ?? tf('任务 {id}', { id: entry.promptId.slice(0, 8) });
    const ok = await confirmDialog(tf('删除 {name}？\n历史记录会被移除；若网关已配置 outputDir，磁盘文件也会一并删除。', { name: label }));
    if (!ok) return;
    try {
      await apiJson('/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [entry.promptId] }),
      });
    } catch (err) {
      toast(t('移除历史失败：') + err.message);
      return;
    }
    let fileNote = '';
    if (item) {
      try {
        const q = new URLSearchParams({ filename: item.filename ?? '', subfolder: item.subfolder ?? '', type: item.type ?? 'output' });
        await apiJson(`/gw/output-file?${q}`, { method: 'DELETE' });
        fileNote = '（含磁盘文件）';
      } catch (err) {
        fileNote = err.status === 501 ? t('（磁盘文件未删除：网关未配置 outputDir）') : t('（磁盘文件未删除：') + err.message + '）';
      }
    }
    deletedIds.add(entry.promptId);
    if (item && fileNote.startsWith('（含')) deletedFiles++;
    markDeleted(entry);
    renderPendingBar();
    toast(tf('已删除 {name}{note}', { name: label, note: fileNote }) + t('（可继续删除，点「刷新列表」更新）'));
  }

  /** 在被删条目的磁贴上就地标记，避免列表跳动。 */
  function markDeleted(entry) {
    for (const tile of grid.querySelectorAll('.tile[data-prompt]')) {
      if (tile.dataset.prompt !== entry.promptId) continue;
      tile.classList.add('tile-deleted');
      if (!tile.querySelector('.tile-deleted-tag')) {
        tile.append(el('div', { class: 'tile-deleted-tag', text: t('已删除') }));
      }
      const badge = tile.querySelector('.tile-del');
      if (badge) badge.remove();
    }
  }

  await load();
}
