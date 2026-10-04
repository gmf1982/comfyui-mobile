/** text-history.js 单元测试：输入合并、撤销/重做回放、重做分支丢弃、blur 提交。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachTextHistory } from '../../web/js/lib/text-history.js';

/** 无 DOM 的输入框替身：监听表 + 同步派发。回放里的 setSelectionRange 由模块内 try 兜底。 */
function fakeTa(initial = '') {
  const listeners = {};
  return {
    value: initial,
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    dispatchEvent(ev) { for (const fn of listeners[ev.type] ?? []) fn(ev); },
    fire(type) { this.dispatchEvent({ type }); },
  };
}

test('初始无可撤销/重做', () => {
  const hist = attachTextHistory(fakeTa('初始'));
  assert.equal(hist.canUndo(), false);
  assert.equal(hist.canRedo(), false);
});

test('合并窗口内的连续输入只算一次编辑，撤销一步回到开头', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ta = fakeTa('开始');
  const hist = attachTextHistory(ta);
  ta.value = '开始画一只猫';
  ta.fire('input');
  t.mock.timers.tick(400);
  ta.value = '开始画一只橘猫';
  ta.fire('input');
  t.mock.timers.tick(800);
  hist.undo();
  assert.equal(ta.value, '开始');
  hist.redo();
  assert.equal(ta.value, '开始画一只橘猫');
});

test('停顿超过合并窗口则分段，撤销逐段回退', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ta = fakeTa('');
  const hist = attachTextHistory(ta);
  ta.value = '第一段';
  ta.fire('input');
  t.mock.timers.tick(800);
  ta.value = '第一段第二段';
  ta.fire('input');
  t.mock.timers.tick(800);
  hist.undo();
  assert.equal(ta.value, '第一段');
  hist.undo();
  assert.equal(ta.value, '');
  assert.equal(hist.canUndo(), false);
});

test('输入未停顿就撤销：先提交当前内容再回退，重做回到它', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ta = fakeTa('旧');
  const hist = attachTextHistory(ta);
  ta.value = '旧改成了新句子';
  ta.fire('input');
  hist.undo();
  assert.equal(ta.value, '旧');
  assert.ok(hist.canRedo());
  hist.redo();
  assert.equal(ta.value, '旧改成了新句子');
});

test('撤销后输入新内容，重做分支被丢弃', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ta = fakeTa('');
  const hist = attachTextHistory(ta);
  ta.value = 'abc';
  ta.fire('input');
  t.mock.timers.tick(800);
  hist.undo();
  assert.equal(ta.value, '');
  ta.value = 'x';
  ta.fire('input');
  t.mock.timers.tick(800);
  assert.equal(hist.canRedo(), false);
  hist.undo();
  hist.redo();
  assert.equal(ta.value, 'x');
});

test('撤销/重做回放派发 input，表单联动收到新值', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ta = fakeTa('');
  const seen = [];
  ta.addEventListener('input', () => seen.push(ta.value));
  const hist = attachTextHistory(ta);
  ta.value = '草稿';
  ta.fire('input');
  t.mock.timers.tick(800);
  hist.undo();
  hist.redo();
  // 三次 input：手输'草稿'、回放''、回放'草稿'——表单联动与手输走同一事件
  assert.deepEqual(seen, ['草稿', '', '草稿']);
});

test('失焦即提交未停顿的输入', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ta = fakeTa('');
  const hist = attachTextHistory(ta);
  ta.value = '草稿';
  ta.fire('input');
  ta.fire('blur');
  hist.undo();
  assert.equal(ta.value, '');
});

test('同 key 重新挂接且文字未变：接回原历史，撤销/重做继续可用', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ta1 = fakeTa('');
  attachTextHistory(ta1, { key: 'wf:6:text' });
  ta1.value = '第一版';
  ta1.fire('input');
  t.mock.timers.tick(800);
  ta1.value = '第一版第二版';
  ta1.fire('input');
  t.mock.timers.tick(800);
  // 模拟视图整页重建：新元素、同文字、同登记键
  const ta2 = fakeTa('第一版第二版');
  const hist2 = attachTextHistory(ta2, { key: 'wf:6:text' });
  assert.ok(hist2.canUndo());
  hist2.undo();
  assert.equal(ta2.value, '第一版');
  assert.ok(hist2.canRedo());
  hist2.redo();
  assert.equal(ta2.value, '第一版第二版');
});

test('同 key 重新挂接但文字已变：另起新栈，不接旧历史', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ta1 = fakeTa('');
  attachTextHistory(ta1, { key: 'wf:7:text' });
  ta1.value = '旧文字';
  ta1.fire('input');
  t.mock.timers.tick(800);
  const ta2 = fakeTa('别处改过的文字');
  const hist2 = attachTextHistory(ta2, { key: 'wf:7:text' });
  assert.equal(hist2.canUndo(), false);
  assert.equal(hist2.canRedo(), false);
});

test('不同登记键的历史互不串线', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = fakeTa('');
  const b = fakeTa('');
  const ha = attachTextHistory(a, { key: 'wfA:6:text' });
  const hb = attachTextHistory(b, { key: 'wfB:6:text' });
  assert.equal(hb.canUndo(), false);
  a.value = 'A 的内容';
  a.fire('input');
  a.fire('blur');
  b.value = 'B 的内容';
  b.fire('input');
  b.fire('blur');
  assert.ok(ha.canUndo());
  assert.ok(hb.canUndo());
  ha.undo();
  assert.equal(a.value, '');
  assert.equal(b.value, 'B 的内容');
});
