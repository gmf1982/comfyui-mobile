/**
 * 媒体操作共享模块：详情浮层与「用作图片输入」。
 * 图库与队列页（生成结果预览）共用，避免两处重复实现。
 */
import { apiJson, uploadMedia, ensureSchemas } from './api.js';
import { el, toast, showOverlay, hideOverlay, showSheet, hideSheet } from './ui.js';
import { viewUrl, downloadMedia, shareMedia } from './media.js';
import { buildFormModel, listApiNodes } from './workflow-form.js';
import { state, rememberedWorkflow, saveWorkflowParam } from './state.js';
import { t, tf } from './i18n.js';

/**
 * 打开媒体详情浮层。
 * @param {{filename: string, subfolder?: string, type?: string, mediaType: string}} item
 * @param {{promptJson?: object|null, durationMs?: number|null, onDelete?: Function|null}} options
 */
export function openMediaOverlay(item, options = {}) {
  const { promptJson = null, durationMs = null, onDelete = null } = options;
  const body = el('div', { class: 'overlay-body' });
  if (item.mediaType === 'image') {
    body.append(el('img', { src: viewUrl(item), alt: item.filename }));
  } else if (item.mediaType === 'video') {
    body.append(el('video', { src: viewUrl(item), controls: '', playsinline: '', preload: 'metadata' }));
  } else {
    body.append(el('audio', { src: viewUrl(item), controls: '' }));
  }

  const info = el('div', { class: 'muted', style: { padding: '8px 14px', textAlign: 'center' },
    text: item.filename + (durationMs ? t(' · 用时 ') + (durationMs / 1000).toFixed(1) + t(' 秒') : '') });

  const actions = el('div', { class: 'overlay-actions' },
    el('button', { class: 'btn', text: t('关闭'), onclick: hideOverlay }),
    el('button', { class: 'btn primary', text: t('⬇ 保存到手机'), onclick: () => downloadMedia(item) }),
  );
  if (navigator.canShare) {
    actions.append(el('button', { class: 'btn', text: t('分享'), onclick: () => shareMedia(item) }));
  }
  if (item.mediaType === 'image') {
    actions.append(el('button', { class: 'btn', text: t('📤 用作图片输入'), onclick: () => { hideOverlay(); sendToImageInput(item); } }));
  }
  if (promptJson) {
    actions.append(el('button', {
      class: 'btn', text: t('用此参数重跑'),
      onclick: () => {
        state.workflow = null;
        import('./state.js').then(({ setWorkflow }) => {
          setWorkflow({ name: t('历史 ') + ((item.promptId ?? '').slice(0, 8) || t('历史参数')), path: null, json: JSON.parse(JSON.stringify(promptJson)), format: 'api' });
          hideOverlay();
          location.hash = '/run';
        });
      },
    }));
  }
  if (onDelete) {
    actions.append(el('button', { class: 'btn danger', text: t('🗑 删除'), onclick: () => { hideOverlay(); onDelete(item); } }));
  }
  showOverlay(el('div', {}, body, info, actions));
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
    const file = new File([blob], 'ref_' + (item.filename ?? 'image.png'), { type: blob.type || 'image/png' });
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
