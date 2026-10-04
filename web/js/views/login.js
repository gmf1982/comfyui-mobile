/** 登录视图：输入网关访问令牌。 */
import { apiJson, getToken, setToken, bus } from '../lib/api.js';
import { el, toast } from '../lib/ui.js';
import { t } from '../lib/i18n.js';

export async function loginView(container) {
  const input = el('input', { type: 'password', placeholder: t('访问令牌（token）'), autocomplete: 'current-password' });
  const status = el('div', { class: 'muted', style: { marginTop: '10px', minHeight: '1.4em' } });

  async function connect() {
    const token = input.value.trim();
    if (!token) {
      status.textContent = t('请输入令牌（电脑端启动网关时会显示）。');
      return;
    }
    setToken(token);
    status.textContent = t('连接中…');
    try {
      await apiJson('/system_stats');
      location.hash = '/workflows';
      bus.dispatchEvent(new CustomEvent('cm:login'));
    } catch (err) {
      if (err.status === 401) {
        status.textContent = t('令牌错误，请核对电脑端显示的 token。');
        setToken('');
      } else if (err.status === 502 || err.status === 503) {
        // 令牌已通过网关校验，只是 ComfyUI 没开（这正是远程启动的主场景）：放行登录，
        // 「设置 → 服务器」里可用「启动 ComfyUI」把电脑端的 ComfyUI 拉起来。
        location.hash = '/workflows';
        bus.dispatchEvent(new CustomEvent('cm:login'));
        toast(t('ComfyUI 未连接，已登录；可到「设置」里远程启动 ComfyUI'));
      } else {
        status.textContent = t('连接失败：') + err.message;
        setToken('');
      }
    }
  }

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') connect();
  });

  if (getToken()) input.value = getToken();

  container.append(
    el('div', { class: 'login-wrap' },
      el('div', { class: 'card' },
        el('div', { class: 'login-logo', text: '🎛️' }),
        el('h1', { style: { textAlign: 'center', fontSize: '20px', margin: '0 0 6px' }, text: 'ComfyUI Mobile' }),
        el('p', { class: 'muted', style: { textAlign: 'center', marginTop: 0 }, text: t('远程控制电脑上的 ComfyUI') }),
        el('div', { class: 'field' }, input),
        el('button', { class: 'btn primary big', text: t('连接'), onclick: connect }),
        status,
        el('p', { class: 'muted', style: { fontSize: '12px', marginBottom: 0 }, text: t('提示：直接用电脑端启动时打印的链接（含 ?token=）打开本页可自动登录。') }),
      ),
    ),
  );
  if (getToken()) connect();
}
