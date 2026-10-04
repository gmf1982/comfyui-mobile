/** media.js / static.js 单元测试：类型判定、Content-Disposition、路径穿越校验、静态服务。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaTypeOf, mimeOfFilename, mimeOfStatic, contentDisposition, isSafeMediaName } from '../src/media.js';
import { serveStatic } from '../src/static.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

test('mediaTypeOf 按扩展名归类', () => {
  assert.equal(mediaTypeOf('a.png'), 'image');
  assert.equal(mediaTypeOf('a.MP4'), 'video');
  assert.equal(mediaTypeOf('b.mp3'), 'audio');
  assert.equal(mediaTypeOf('b.webm'), 'video');
  assert.equal(mediaTypeOf('c.flac'), 'audio');
  assert.equal(mediaTypeOf('c.txt'), 'other');
  assert.equal(mediaTypeOf('noext'), 'other');
});

test('mimeOfFilename / mimeOfStatic', () => {
  assert.equal(mimeOfFilename('x.mp4'), 'video/mp4');
  assert.equal(mimeOfFilename('x.png'), 'image/png');
  assert.equal(mimeOfFilename('x.???'), '');
  assert.equal(mimeOfStatic('app.css'), 'text/css; charset=utf-8');
  assert.equal(mimeOfStatic('index.html'), 'text/html; charset=utf-8');
  assert.equal(mimeOfStatic('a.unknown'), 'application/octet-stream');
});

test('contentDisposition 支持 ASCII 与中文（RFC 5987）', () => {
  assert.equal(contentDisposition('a.png', false), `inline; filename="a.png"; filename*=UTF-8''a.png`);
  assert.equal(contentDisposition('b.mp4', true), `attachment; filename="b.mp4"; filename*=UTF-8''b.mp4`);
  const cn = contentDisposition('生成的图片.png');
  assert.match(cn, /filename="_+\.png"/);
  assert.match(cn, /filename\*=UTF-8''%E7%94%9F%E6%88%90%E7%9A%84%E5%9B%BE%E7%89%87\.png/);
});

test('isSafeMediaName 拒绝穿越与非法字符', () => {
  for (const bad of [
    '', '../../secret.png', 'a/../b.png', '..\\evil.png', '\\evil.png', '/abs.png',
    'C:/win.png', 'C:\\win.png', 'a'.repeat(256),
  ]) {
    assert.equal(isSafeMediaName(bad), false, `应拒绝：${bad}`);
  }
  for (const bad of ['ctrl\x00.png', 'ctrl\n.png']) {
    assert.equal(isSafeMediaName(bad), false);
  }
  for (const good of ['ok.png', '子目录/图片 01.png', 'ComfyUI_0001_.mp4']) {
    assert.equal(isSafeMediaName(good), true, `应放行：${good}`);
  }
});

test('serveStatic 提供文件并拒绝目录穿越', () => {
  let captured = null;
  const fakeRes = {
    writeHead(status, headers) {
      captured = { status, headers };
      return this;
    },
    end() {},
    on() { return this; },
    once() { return this; },
    emit() {},
    write() { return true; },
  };
  // 命中
  assert.equal(serveStatic(webRoot, '/index.html', fakeRes), true);
  assert.equal(captured.status, 200);
  assert.match(captured.headers['Content-Type'], /text\/html/);
  // 根路径
  assert.equal(serveStatic(webRoot, '/', fakeRes), true);
  // 穿越（Windows 上 path.join 会规范化 ..，仍不得逃出 webRoot）
  assert.equal(serveStatic(webRoot, '/../server/src/config.js', fakeRes), false);
  // 不存在
  assert.equal(serveStatic(webRoot, '/nope.js', fakeRes), false);
});
