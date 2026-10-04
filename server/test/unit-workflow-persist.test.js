/** 工作流跨刷新保留与图库“用作图片输入”按钮的实现约束测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const stateSrc = fs.readFileSync('web/js/lib/state.js', 'utf8');
const wfSrc = fs.readFileSync('web/js/views/workflows.js', 'utf8');
const appSrc = fs.readFileSync('web/js/app.js', 'utf8');
const galSrc = fs.readFileSync('web/js/views/gallery.js', 'utf8');

test('工作流状态持久化：记住路径并支持恢复', () => {
  assert.match(stateSrc, /export function rememberWorkflow/);
  assert.match(stateSrc, /export function rememberedWorkflow/);
  assert.match(stateSrc, /localStorage\.setItem\(LAST_WF_KEY/);
  assert.match(stateSrc, /state\.workflow = w;\s*\n\s*rememberWorkflow\(w\)/, 'setWorkflow 应同时持久化');
});

test('载入函数可复用且不强制跳转（供恢复与图库使用）', () => {
  assert.match(wfSrc, /export async function loadWorkflowFromPath/);
  assert.match(wfSrc, /navigate = true, silent = false/);
  assert.match(wfSrc, /if \(navigate\) location\.hash = '\/run'/);
  assert.match(wfSrc, /await loadWorkflowFromPath\(path, \{ navigate: true \}\)/, 'openWorkflowByName 应委托');
});

test('应用启动时静默恢复上次工作流（不打断当前页面）', () => {
  assert.match(appSrc, /rememberedWorkflow\(\)/);
  assert.match(appSrc, /loadWorkflowFromPath\(last\.path, \{ navigate: false, silent: true \}\)/);
});

test('“用作图片输入”用于图库与队列结果（实现位于共享模块）', () => {
  const actionsSrc = fs.readFileSync('web/js/lib/media-actions.js', 'utf8');
  // 按钮只在图片类型时出现，但不再依赖“当前是否已打开工作流”
  assert.match(actionsSrc, /if \(item\.mediaType === 'image'\) \{[\s\S]{0,160}用作图片输入/);
  assert.doesNotMatch(actionsSrc, /item\.mediaType === 'image' && state\.workflow/, '不应依赖内存态决定是否显示');
  assert.match(actionsSrc, /先选择要用的工作流/, '无工作流时应引导选择');
  assert.match(actionsSrc, /loadWorkflowFromPath\(path, \{ navigate: false, silent: true \}\)/, '选完后就地载入');
  // 图库与队列都通过共享模块打开详情，因此两处都有该入口
  assert.match(galSrc, /openMediaOverlay\(item, \{/, '图库应使用共享详情浮层');
  const queueSrc = fs.readFileSync('web/js/views/queue.js', 'utf8');
  assert.match(queueSrc, /openMediaOverlay\(item, \{/, '队列结果也应使用共享详情浮层');
});

test('生成耗时小于 1 秒不显示（避免“用时 0.0 秒”）', () => {
  assert.match(galSrc, /d != null && d > 900 \? d : null/);
});
