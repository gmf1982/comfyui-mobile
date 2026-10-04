/**
 * `/ws` WebSocket 双向代理：手机端 ⇄ 网关 ⇄ ComfyUI。
 * 二进制预览帧原样透传不解析；上游断开时向下游发 gw_upstream_closed 事件再关闭。
 */
import { WebSocketServer, WebSocket as UpstreamSocket } from 'ws';
import { clientAddress } from './gateway.js';

const MAX_PAYLOAD = 256 * 1024 * 1024;

/**
 * 在 http server 上挂载 /ws 升级处理。
 * @param {import('node:http').Server} server
 * @param {object} cfg 网关配置
 * @param {{ tokenOk: (url: URL) => boolean, onAuthFail: (ip: string) => void, isBanned: (ip: string) => boolean }} auth
 */
export function attachWebSocketProxy(server, cfg, auth) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      // 与 gateway 一致：// 开头的路径先规范化，避免被当作协议相对引用
      url = new URL(req.url.replace(/^\/{2,}/, '/'), 'http://local');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const ip = clientAddress(req);
    if (auth.isBanned(ip)) {
      replyAndDestroy(socket, 429, 'rate_limited');
      return;
    }
    if (!auth.tokenOk(url)) {
      auth.onAuthFail(ip);
      replyAndDestroy(socket, 401, 'unauthorized');
      return;
    }
    wss.handleUpgrade(req, socket, head, (downstream) => {
      connectUpstream(downstream, url, cfg);
    });
  });
}

function replyAndDestroy(socket, code, reason) {
  socket.write(`HTTP/1.1 ${code} ${reason === 'unauthorized' ? 'Unauthorized' : 'Too Many Requests'}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function connectUpstream(downstream, clientUrl, cfg) {
  const upstreamBase = cfg.upstream.replace(/^http/, 'ws');
  const upstreamUrl = new URL('/ws' + (clientUrl.search || ''), upstreamBase);
  upstreamUrl.searchParams.delete('token'); // token 只用于网关鉴权，不转发上游

  let upstream;
  try {
    upstream = new UpstreamSocket(upstreamUrl, { maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  } catch {
    downstream.close(1011, 'upstream_connect_failed');
    return;
  }

  const pending = [];
  const pushDown = (data, isBinary) => {
    if (downstream.readyState === downstream.OPEN) downstream.send(data, { binary: isBinary });
  };

  upstream.on('open', () => {
    for (const [data, isBinary] of pending.splice(0)) pushDown(data, isBinary);
  });
  upstream.on('message', (data, isBinary) => pushDown(data, isBinary));
  upstream.on('close', (code, reason) => {
    if (downstream.readyState === downstream.OPEN) {
      downstream.send(JSON.stringify({ type: 'gw_upstream_closed', code, reason: reason.toString() }), { binary: false });
      downstream.close(1011, 'upstream_closed');
    }
  });
  upstream.on('error', () => {
    if (downstream.readyState === downstream.OPEN) downstream.close(1011, 'upstream_error');
  });

  downstream.on('message', (data, isBinary) => {
    if (upstream.readyState === upstream.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream.readyState !== upstream.CLOSED) pending.push([data, isBinary]);
  });
  downstream.on('close', () => upstream.close());

  const heartbeat = setInterval(() => {
    if (downstream.readyState === downstream.OPEN) downstream.ping();
  }, 30_000);
  downstream.on('close', () => clearInterval(heartbeat));
}
