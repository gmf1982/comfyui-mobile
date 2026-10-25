/**
 * 偏好云同步收藏合并的单测：整包 last-writer-wins 会让一台设备的空列表
 * 抹掉另一台的云端收藏（2026-10-20 事故），这里验证逐条合并的各种时序。
 * favTimes 每项 [最近点亮, 最近取消]，点亮晚于取消才保留。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePrefsFavorites, mergeHasRemoteMissing, KNOWN_ADD_LOOKBACK_MS } from '../../web/js/lib/prefs-merge.js';

const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;

test('空本机列表不会覆盖云端收藏（旧云端无时间戳视为已点亮）', () => {
  const m = mergePrefsFavorites(
    { favorites: [], favTimes: {}, prefsUpdatedAt: now },
    { favorites: ['A.json', 'B.json'], updatedAt: now },
  );
  assert.deepEqual(m.favorites.sort(), ['A.json', 'B.json']);
});

test('云端空列表 + 本机有收藏：保留本机（事故反向场景）', () => {
  const m = mergePrefsFavorites(
    { favorites: ['A.json'], favTimes: { 'A.json': [now - DAY, 0] }, prefsUpdatedAt: now - 2 * DAY },
    { favorites: [], favTimes: {}, updatedAt: now },
  );
  assert.deepEqual(m.favorites, ['A.json']);
});

test('墓碑新于点亮 → 取消收藏跨设备生效，且墓碑继续随包传播', () => {
  const m = mergePrefsFavorites(
    { favorites: [], favTimes: { 'A.json': [0, now - DAY] }, prefsUpdatedAt: now },
    { favorites: ['A.json'], favTimes: { 'A.json': [now - 3 * DAY, 0] }, updatedAt: now },
  );
  assert.deepEqual(m.favorites, []);
  assert.deepEqual(m.favTimes['A.json'], [now - 3 * DAY, now - DAY], '两个事件都要保留供第三台设备合并');
});

test('点亮新于墓碑 → 重新点亮胜出', () => {
  const m = mergePrefsFavorites(
    { favorites: [], favTimes: { 'A.json': [0, now - 3 * DAY] }, prefsUpdatedAt: now },
    { favorites: ['A.json'], favTimes: { 'A.json': [now - DAY, 0] }, updatedAt: now },
  );
  assert.deepEqual(m.favorites, ['A.json']);
  assert.deepEqual(m.favTimes['A.json'], [now - DAY, now - 3 * DAY]);
});

test('旧云端无时间戳：本机新墓碑仍能取消（回退点亮时间不早于同步时刻）', () => {
  const m = mergePrefsFavorites(
    { favorites: [], favTimes: { 'A.json': [0, now] }, prefsUpdatedAt: now },
    { favorites: ['A.json'], updatedAt: now - 2 * DAY },
  );
  assert.deepEqual(m.favorites, []);
});

test('本机独有收藏在远端更新时被补推保留', () => {
  const m = mergePrefsFavorites(
    { favorites: ['B.json'], favTimes: { 'B.json': [now - DAY, 0] }, prefsUpdatedAt: now - 2 * DAY },
    { favorites: ['A.json'], favTimes: { 'A.json': [now - DAY, 0] }, updatedAt: now },
  );
  assert.deepEqual(m.favorites.sort(), ['A.json', 'B.json']);
});

test('超期的取消记录被清理，未超期的保留', () => {
  const m = mergePrefsFavorites(
    { favorites: [], favTimes: { 'Old.json': [0, now - 200 * DAY], 'New.json': [0, now - 10 * DAY] }, prefsUpdatedAt: now },
    { favorites: [], favTimes: {}, updatedAt: now },
  );
  assert.ok(!('Old.json' in m.favTimes), '200 天的取消记录应淘汰');
  assert.deepEqual(m.favTimes['New.json'], [0, now - 10 * DAY]);
});

test('脏数据（非字符串路径/非法时间）被忽略，列表仍可用', () => {
  const m = mergePrefsFavorites(
    { favorites: ['A.json', 1, null], favTimes: { 'A.json': 'x', Bad: [0, 0] }, prefsUpdatedAt: now },
    { favorites: 'nope', favTimes: [], updatedAt: now },
  );
  assert.deepEqual(m.favorites, ['A.json']);
  assert.ok(m.favTimes['A.json'][0] >= now - KNOWN_ADD_LOOKBACK_MS);
});

test('历史符号写法（正=点亮，负=取消）仍能正确合并', () => {
  const m = mergePrefsFavorites(
    { favorites: [], favTimes: { 'A.json': -(now - DAY) }, prefsUpdatedAt: now },
    { favorites: ['A.json'], favTimes: { 'A.json': now - 3 * DAY }, updatedAt: now },
  );
  assert.deepEqual(m.favorites, []);
});

// ---- mergeHasRemoteMissing：pullPrefs 据此决定是否补推（只在确实补入条目时推） ----

test('合并结果远端都已包含 → 不需要补推（含旧符号/缺时间图等形态）', () => {
  const remote = {
    favorites: ['A.json', 'B.json'],
    favTimes: { 'A.json': [now - DAY, 0], 'B.json': [now - DAY, 0] },
    updatedAt: now,
  };
  const m = mergePrefsFavorites({ favorites: ['A.json'], favTimes: {}, prefsUpdatedAt: now - DAY }, remote);
  assert.equal(mergeHasRemoteMissing(m, remote), false);
  // 远端没有 favTimes 字段但收藏列表一致：无需为格式差异反复补推
  assert.equal(mergeHasRemoteMissing({ favorites: ['A.json'], favTimes: { 'A.json': [now, 0] } }, { favorites: ['A.json'] }), true);
});

test('本机独有收藏远端没有 → 需要补推', () => {
  const merged = { favorites: ['A.json', 'C.json'], favTimes: { 'A.json': [now, 0], 'C.json': [now, 0] } };
  assert.equal(mergeHasRemoteMissing(merged, { favorites: ['A.json'], favTimes: { 'A.json': [now, 0] } }), true);
});

test('本机墓碑远端还没见过 → 需要补推（取消收藏要传播到云端）', () => {
  const merged = { favorites: [], favTimes: { 'A.json': [now - DAY, now] } };
  assert.equal(mergeHasRemoteMissing(merged, { favorites: ['A.json'], favTimes: {} }), true);
});

test('远端 favTimes 形状不对（字符串/数组）按空处理，不抛错', () => {
  const merged = { favorites: ['A.json'], favTimes: { 'A.json': [now, 0] } };
  assert.equal(mergeHasRemoteMissing(merged, { favorites: ['A.json'], favTimes: 'bad' }), true);
  assert.equal(mergeHasRemoteMissing(merged, { favorites: ['A.json'], favTimes: [] }), true);
  assert.equal(mergeHasRemoteMissing(merged, { favorites: ['A.json'], favTimes: { 'A.json': [1, 0] } }), false);
  assert.equal(mergeHasRemoteMissing(null, null), false);
});
