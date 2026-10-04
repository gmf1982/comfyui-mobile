/** 设置视图：主题、图库加载数量、令牌、PWA 安装、清缓存。 */
import { getToken, setToken, clearSchemas, apiJson } from '../lib/api.js';
import { el, toast, confirmDialog } from '../lib/ui.js';
import { state, saveSettings } from '../lib/state.js';
import { t, tf, getLang, setLang } from '../lib/i18n.js';

export async function settingsView(container) {
  // 语言（中文/English）
  const langSelect = el('select');
  langSelect.append(el('option', { value: 'zh', text: '中文' }));
  langSelect.append(el('option', { value: 'en', text: 'English' }));
  langSelect.value = getLang();
  langSelect.addEventListener('change', () => {
    setLang(langSelect.value);
    saveSettings();
    document.documentElement.lang = langSelect.value === 'en' ? 'en' : 'zh-CN';
    setTimeout(() => location.reload(), 150);
  });

  // 主题
  const themeSelect = el('select');
  for (const [value, label] of [['dark', t('暗色')], ['light', t('亮色')]]) {
    themeSelect.append(el('option', { value, text: label }));
  }
  themeSelect.value = state.settings.theme;
  themeSelect.addEventListener('change', () => {
    state.settings.theme = themeSelect.value;
    saveSettings();
    document.documentElement.dataset.theme = themeSelect.value;
    toast(t('主题已切换'));
  });

  // 上传压缩（弱网/大图必备）
  const compressToggle = el('input', { type: 'checkbox' });
  compressToggle.checked = state.settings.compressUpload !== false;
  compressToggle.style.width = '22px';
  compressToggle.style.height = '22px';
  compressToggle.addEventListener('change', () => {
    state.settings.compressUpload = compressToggle.checked;
    saveSettings();
    toast(compressToggle.checked ? t('上传前将自动压缩图片') : t('已关闭压缩（原图上传较慢）'));
  });
  const maxDimInput = el('input', { type: 'number', min: '512', max: '4096', step: '256' });
  maxDimInput.value = state.settings.uploadMaxDim ?? 2048;
  maxDimInput.addEventListener('change', () => {
    state.settings.uploadMaxDim = Math.max(512, Math.min(4096, Number(maxDimInput.value) || 2048));
    saveSettings();
  });
  const targetMBInput = el('input', { type: 'number', min: '0.2', max: '10', step: '0.1' });
  targetMBInput.value = state.settings.uploadTargetMB ?? 0.9;
  targetMBInput.addEventListener('change', () => {
    state.settings.uploadTargetMB = Math.max(0.2, Math.min(10, Number(targetMBInput.value) || 0.9));
    saveSettings();
  });

  // 图库加载数量
  const maxItems = el('input', { type: 'number', min: '10', max: '500', step: '10' });
  maxItems.value = state.settings.maxItems;
  maxItems.addEventListener('change', () => {
    state.settings.maxItems = Math.max(10, Math.min(500, Number(maxItems.value) || 100));
    saveSettings();
  });

  // 令牌
  const tokenInput = el('input', { type: 'password', value: getToken() });
  tokenInput.addEventListener('change', () => {
    setToken(tokenInput.value.trim());
    toast(t('令牌已更新'));
  });

  const installBtn = el('button', { class: 'btn', style: { width: '100%' }, text: t('安装到主屏幕（PWA）'), onclick: async () => {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      state.installPrompt = null;
      return;
    }
    toast(t('请使用浏览器菜单中的「添加到主屏幕」'));
  } });
  if (!state.installPrompt) installBtn.style.opacity = '0.7';

  container.append(
    el('div', { class: 'card' },
      el('h3', { text: t('外观') }),
      el('div', { class: 'field' }, el('label', { text: t('主题') }), themeSelect),
      el('div', { class: 'field' }, el('label', { text: t('语言') }), langSelect),
    ),
    el('div', { class: 'card' },
      el('h3', { text: t('上传') }),
      el('div', { class: 'row', style: { marginBottom: '12px' } },
        compressToggle,
        el('div', { class: 'grow' },
          el('div', { text: t('上传前压缩图片') }),
          el('div', { class: 'muted', style: { fontSize: '12px' }, text: t('手机照片常为 5-10MB，压缩后上传更快；HEIC 等格式会自动转 JPEG') }),
        ),
      ),
      el('div', { class: 'field' },
        el('label', { text: t('压缩最长边（像素，默认 2048）') }),
        maxDimInput,
      ),
      el('div', { class: 'field' },
        el('label', { text: t('目标体积（MB，默认 0.9）') }),
        targetMBInput,
      ),
    ),
    el('div', { class: 'card' },
      el('h3', { text: t('图库') }),
      el('div', { class: 'field' },
        el('label', { text: t('每次加载的历史条数（10-500）') }),
        maxItems,
      ),
    ),
    el('div', { class: 'card' },
      el('h3', { text: t('连接') }),
      el('div', { class: 'field' }, el('label', { text: t('访问令牌') }), tokenInput),
      el('div', { class: 'muted', text: t('网关：') + location.origin }),
    ),
    el('div', { class: 'card' },
      el('h3', { text: t('应用') }),
      el('div', { style: { marginBottom: '8px' } }, installBtn),
      el('button', {
        class: 'btn danger', style: { width: '100%' }, text: t('清除本地缓存与偏好'),
        onclick: async () => {
          if (!(await confirmDialog(t('清除主题/令牌/节点缓存等本地数据？')))) return;
          clearSchemas();
          localStorage.clear();
          navigator.serviceWorker?.getRegistrations?.().then((regs) => regs.forEach((r) => r.unregister()));
          toast(t('已清除，即将刷新'));
          setTimeout(() => location.reload(), 800);
        },
      }),
    ),
  );

  // 服务器状态检查（health 无需令牌，用于显示网关可达性）
  try {
    const res = await fetch('/health');
    if (res.ok) {
      const card = el('div', { class: 'card' }, el('h3', { text: t('服务器') }));

      // ComfyUI 进程管理（网关配置了 comfyuiLaunch 才出现；旧版网关无此接口则整块隐藏）。
      // 按钮常驻：未运行=启动，运行中=重启（重启会中断正在生成的任务，需二次确认）。
      const startBtn = el('button', { class: 'btn', style: { width: '100%' }, text: t('启动 ComfyUI') });
      const stateLine = el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } });
      let pollTimer = null;
      let cur = { running: false, starting: false };
      const stopPoll = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
      const render = (s) => {
        cur = s;
        if (s.starting) {
          startBtn.disabled = true;
          startBtn.textContent = t('启动中…');
        } else {
          startBtn.disabled = false;
          startBtn.textContent = s.running ? t('重启 ComfyUI') : t('启动 ComfyUI');
        }
        stateLine.textContent = s.running
          ? (s.pid ? tf('ComfyUI 运行中（pid {pid}）', { pid: s.pid }) : t('ComfyUI 运行中'))
          : s.starting
            ? t('ComfyUI 启动中…（冷启动约 1-3 分钟）')
            : t('ComfyUI 未运行，点上方按钮启动（冷启动约 1-3 分钟）');
      };
      // 轮询至 running（已就绪）或 starting 归 false（进程退出/启动失败），然后停表
      const poll = () => {
        stopPoll();
        pollTimer = setInterval(async () => {
          let s;
          try { s = await apiJson('/gw/comfyui/status'); } catch { return; } // 网关暂时不可达，下轮再试
          render(s);
          if (s.running) { stopPoll(); toast(t('ComfyUI 已就绪')); }
          else if (!s.starting) stopPoll();
        }, 2500);
      };
      startBtn.addEventListener('click', async () => {
        const restart = Boolean(cur.running);
        if (!(await confirmDialog(restart ? t('确认重启 ComfyUI？正在生成的任务会中断。') : t('确认启动 ComfyUI？')))) return;
        startBtn.disabled = true;
        startBtn.textContent = t('启动中…');
        stateLine.textContent = restart ? t('正在结束 ComfyUI 进程…') : t('正在请求启动…');
        try {
          await apiJson(restart ? '/gw/comfyui/restart' : '/gw/comfyui/start', { method: 'POST' });
        } catch (err) {
          startBtn.disabled = false;
          stateLine.textContent = '';
          toast(t('启动失败：') + (err?.message ?? String(err)));
          return;
        }
        render({ running: false, starting: true });
        poll();
      });

      let st = null;
      try { st = await apiJson('/gw/comfyui/status'); } catch { /* 网关版本较旧，无进程管理接口 */ }
      if (st?.configured) {
        card.append(startBtn, stateLine);
        render(st);
        if (st.starting) poll();
      } else {
        // 未配置远程启动时维持原有的一次性健康行（避免与实时状态行内容矛盾）
        card.append(el('div', { class: 'muted', text: t('网关健康检查：正常（') + await apiJson('/system_stats').then((s) => 'ComfyUI ' + (s?.system?.comfyui_version ?? '')).catch(() => t('ComfyUI 未连接')) + t('）') }));
      }

      container.append(card);
    }
  } catch {
    // health 不可达时页面其他请求也会报错，这里静默
  }
}
