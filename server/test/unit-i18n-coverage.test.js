/**
 * i18n 覆盖测试：web/js 里所有 t()/tf() 用的中文字符串键都必须有 EN 词典词条，
 * 否则英文界面会漏出中文（回归防护：2026-10 更多页显存卡片曾整块漏翻）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

function walk(dir, acc = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (f.endsWith('.js')) acc.push(p);
  }
  return acc;
}

/** @param {string} src 任意 JS 源码 */
function extractStringKeys(src) {
  const keys = new Set();
  const re = /\bt(?:f)?\(\s*('((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*[),]/g;
  for (const m of src.matchAll(re)) keys.add(m[2] ?? m[3]);
  return keys;
}

test('t()/tf() 文案键全部有 EN 词典词条', () => {
  const used = new Map();
  for (const f of walk('web/js')) {
    const rel = relative('web/js', f).split(sep).join('/');
    if (rel === 'lib/i18n.js') continue; // 词典自身不扫描
    for (const key of extractStringKeys(readFileSync(f, 'utf8'))) {
      if (!used.has(key)) used.set(key, rel);
    }
  }
  assert.ok(used.size > 300, `扫描到的键异常少（${used.size}），检查扫描逻辑`);

  const i18n = readFileSync('web/js/lib/i18n.js', 'utf8');
  const have = new Set();
  for (const m of i18n.matchAll(/'((?:[^'\\]|\\.)*)':/g)) have.add(m[1]);
  assert.ok(have.size > 300, `词典键异常少（${have.size}），检查解析逻辑`);

  const missing = [...used.entries()].filter(([k]) => !have.has(k) && k.trim());
  assert.deepEqual(
    missing.map(([k, f]) => `${f}: ${k}`),
    [],
    '以下 t()/tf() 键缺 EN 词条（英文界面会漏中文），请在 web/js/lib/i18n.js 的 EN 词典补齐',
  );
});
