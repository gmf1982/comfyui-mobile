/** 更多视图：显存清理、设置入口、关于。 */
import { apiJson } from '../lib/api.js';
import { el, clear, toast, confirmDialog } from '../lib/ui.js';
import { t } from '../lib/i18n.js';

export async function moreView(container) {
  // 显存清理：显示当前占用，一键卸载模型并释放内存（ComfyUI 原生 /free）
  const vramLine = el('div', { class: 'muted', style: { marginBottom: '10px' }, text: t('加载中…') });

  async function refreshVram() {
    try {
      const stats = await apiJson('/system_stats');
      const dev = stats?.devices?.[0];
      if (dev?.vram_total != null && dev?.vram_free != null) {
        const used = (dev.vram_total - dev.vram_free) / 1024 ** 3;
        vramLine.textContent = t('显存占用 ') + `${used.toFixed(1)} / ${(dev.vram_total / 1024 ** 3).toFixed(1)} GB`;
      } else {
        vramLine.textContent = t('无法读取显存信息');
      }
    } catch {
      vramLine.textContent = t('无法读取显存信息');
    }
  }
  refreshVram();

  const freeBtn = el('button', {
    class: 'btn', style: { width: '100%' }, text: t('清理显存 / 内存'),
    onclick: async () => {
      if (!(await confirmDialog(t('卸载已加载的模型并释放内存？下次生成需重新加载模型。')))) return;
      freeBtn.disabled = true;
      try {
        await apiJson('/free', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ unload_models: true, free_memory: true }),
        });
        toast(t('已清理'));
      } catch (err) {
        toast(t('清理失败：') + err.message);
      }
      freeBtn.disabled = false;
      setTimeout(refreshVram, 1500); // 释放稍晚于接口返回，缓一拍再刷新读数
    },
  });

  // 关于
  const aboutLink = () => el('div', { class: 'muted' },
    el('a', { href: 'https://github.com/gmf1982', target: '_blank', rel: 'noopener', text: 'GitHub: @gmf1982' }));
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
      aboutLink(),
    );
  } catch {
    clear(aboutCard).append(el('h3', { text: t('关于') }), el('div', { class: 'muted', text: t('无法读取服务器信息') }), aboutLink());
  }

  container.append(
    el('div', { class: 'card' },
      el('h3', { text: t('显存清理') }),
      el('p', { class: 'muted', style: { marginTop: 0 }, text: t('长时间使用后显存可能被历史模型占满，清理后不影响已生成的图片。') }),
      vramLine,
      freeBtn,
    ),
    el('div', { class: 'card' },
      el('h3', { text: t('设置') }),
      el('button', { class: 'btn', style: { width: '100%' }, text: t('打开设置'), onclick: () => { location.hash = '/settings'; } }),
    ),
    aboutCard,
  );
}
