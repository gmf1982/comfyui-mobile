/**
 * 文件选择器触发链路测试。
 * 教训：<button> 不会把点击转发给内部 <input type=file>，只有 <label for>/
 * 显式 click() 才能打开选择器。此前的测试直接给 input 派发 change，绕过了
 * 点击环节，导致"点了没反应"未被发现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const uiSrc = fs.readFileSync('web/js/lib/ui.js', 'utf8');

test('上传/拍照按钮使用 fileTrigger（label + 显式 click）', () => {
  assert.match(uiSrc, /export function fileTrigger\(className, text, input\)/, '应有统一触发助手');
  assert.match(uiSrc, /el\('label', \{ class: className, for: input\.id, text \}\)/, '应使用 label for 关联 input');
  assert.match(uiSrc, /ev\.preventDefault\(\);\s*\n\s*input\.click\(\);/, '应显式触发 input.click()');
  const uses = [...uiSrc.matchAll(/fileTrigger\('btn small[^)]*\)/g)].length;
  assert.ok(uses >= 3, `上传/拍照按钮都应用 fileTrigger，当前 ${uses} 处`);
});

test('不再出现“把 input 包进 button 依赖原生转发”的写法', () => {
  assert.doesNotMatch(uiSrc, /el\('button', \{[^}]*\}, albumInput\)/, 'button 不转发点击，不能这样写');
  assert.doesNotMatch(uiSrc, /el\('button', \{[^}]*\}, camInput\)/, 'button 不转发点击，不能这样写');
});

test('input 的 id 在构造时设置（fileTrigger 依赖它建立 for 关联）', () => {
  const seg = uiSrc.slice(uiSrc.indexOf('const mkInput'), uiSrc.indexOf('const mkInput') + 700);
  assert.match(seg, /input\.id = id;/, 'id 必须在返回前设置');
});
