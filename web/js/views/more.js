/** 更多视图：模型浏览、节点图入口、设置入口、关于。 */
import { apiJson } from '../lib/api.js';
import { el, clear, toast } from '../lib/ui.js';
import { state } from '../lib/state.js';
import { t } from '../lib/i18n.js';

const MODEL_FOLDERS = [
  'checkpoints', 'diffusion_models', 'loras', 'vae', 'text_encoders', 'clip',
  'controlnet', 'upscale_models', 'embeddings', 'style_models', 'hypernetworks', 'photomaker',
];

const FOLDER_LABELS = {
  checkpoints: '大模型 Checkpoints', diffusion_models: '扩散模型', loras: 'LoRA', vae: 'VAE',
  text_encoders: '文本编码器', clip: 'CLIP', controlnet: 'ControlNet', upscale_models: '放大模型',
  embeddings: 'Embeddings', style_models: '风格模型', hypernetworks: '超网络', photomaker: 'PhotoMaker',
};

export async function moreView(container) {
  // 模型浏览
  const modelChips = el('div', { class: 'chips' });
  const modelList = el('div', { class: 'muted', text: t('选择上方分类查看已安装模型') });

  for (const folder of MODEL_FOLDERS) {
    modelChips.append(el('button', {
      class: 'chip', text: FOLDER_LABELS[folder] ?? folder,
      onclick: (ev) => {
        for (const c of modelChips.children) c.classList.toggle('active', c === ev.currentTarget);
        loadModels(folder);
      },
    }));
  }

  async function loadModels(folder) {
    clear(modelList).append(el('div', { class: 'muted', text: t('加载中…') }));
    try {
      const files = await apiJson(`/models/${encodeURIComponent(folder)}`);
      clear(modelList);
      if (!Array.isArray(files) || !files.length) {
        modelList.append(el('div', { class: 'muted', text: t('该目录为空或不存在') }));
        return;
      }
      for (const file of files) {
        modelList.append(el('div', { class: 'list-item' }, el('div', { class: 'grow title', style: { fontSize: '13px', fontWeight: 400 }, text: file })));
      }
    } catch (err) {
      clear(modelList).append(el('div', { class: 'muted', text: t('加载失败：') + err.message }));
    }
  }

  // 关于
  const aboutCard = el('div', { class: 'card' }, el('h3', { text: t('关于') }), el('div', { class: 'muted', text: t('加载中…') }));
  try {
    const [stats, health] = await Promise.all([
      apiJson('/system_stats'),
      fetch('/health').then((r) => r.json()).catch(() => null),
    ]);
    const device = stats?.devices?.[0];
    clear(aboutCard).append(
      el('h3', { text: t('关于') }),
      health?.version ? el('div', { class: 'muted' }, t('版本：') + health.version) : null,
      el('div', { class: 'muted' }, `ComfyUI: ${stats?.system?.comfyui_version ?? t("未知")}`),
      el('div', { class: 'muted' }, `Gateway: ${location.origin}`),
      device ? el('div', { class: 'muted' }, `GPU: ${device.name} (VRAM ${(device.vram_total / 1024 ** 3).toFixed(1)} GB)`) : null,
    );
  } catch {
    clear(aboutCard).append(el('h3', { text: t('关于') }), el('div', { class: 'muted', text: t('无法读取服务器信息') }));
  }

  container.append(
    el('div', { class: 'card' },
      el('h3', { text: t('模型浏览') }),
      modelChips, modelList,
    ),
    el('div', { class: 'card' },
      el('h3', { text: t('节点图') }),
      el('p', { class: 'muted', style: { marginTop: 0 }, text: t('查看当前工作流结构、点按节点修改参数。') }),
      el('button', {
        class: 'btn', style: { width: '100%' }, text: t('打开节点图'),
        onclick: () => {
          if (!state.workflow) {
            toast(t('请先在工作流页打开一个工作流'));
            return;
          }
          location.hash = '/editor';
        },
      }),
    ),
    el('div', { class: 'card' },
      el('h3', { text: t('设置') }),
      el('button', { class: 'btn', style: { width: '100%' }, text: t('打开设置'), onclick: () => { location.hash = '/settings'; } }),
    ),
    aboutCard,
  );
}
