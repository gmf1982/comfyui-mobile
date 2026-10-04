/**
 * `web/` 静态资源服务：路径限定在 web 根目录内，静态壳不含数据，无需鉴权。
 */
import fs from 'node:fs';
import path from 'node:path';
import { mimeOfStatic } from './media.js';

/**
 * 尝试用静态文件响应请求；未命中返回 false 由调用方继续路由。
 * @param {string} webRoot web 目录绝对路径
 * @param {string} pathname 已解析的 URL 路径（不含查询串）
 * @param {import('node:http').ServerResponse} res
 */
export function serveStatic(webRoot, pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(webRoot, rel));
  if (!filePath.startsWith(path.normalize(webRoot + path.sep)) && filePath !== path.normalize(webRoot)) {
    return false;
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (stat.isDirectory()) return false;

  const immutable = filePath.includes(`${path.sep}icons${path.sep}`);
  res.writeHead(200, {
    'Content-Type': mimeOfStatic(filePath),
    'Content-Length': stat.size,
    'Cache-Control': immutable ? 'public, max-age=86400' : 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}
