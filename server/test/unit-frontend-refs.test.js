/**
 * 前端引用检查：扫描 web/js 下各模块，找出「被引用但未声明」的顶层标识符。
 *
 * 背景：这类错误发生过三次且都到了用户手里——
 *   1. api.js 的 `let fullObjInfo` 被误删（模块级状态，被调用）
 *   2. gallery.js 的 deleteEntry/markDeleted 被误删（函数体内部调用）
 *   3. gallery.js 漏导入 `state` 却写了 `state.settings`（**属性访问**，非调用）
 * 第 3 类曾从本检查中漏网，因此这里两类都要查。node --check 只验语法，
 * 模块冒烟测试只覆盖模块级，本检查补上静态引用这一层。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'web/js';
const FILES = [
  ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `${ROOT}/lib/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'views')).filter((f) => f.endsWith('.js')).map((f) => `${ROOT}/views/${f}`),
  `${ROOT}/app.js`,
];

/** 语言与浏览器内置（不声明也合法）。 */
const BUILTINS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function', 'new', 'delete', 'void', 'in', 'of',
  'console', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'Number', 'String', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Date', 'Map', 'Set', 'Promise', 'Symbol', 'Error',
  'RegExp', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'URL', 'URLSearchParams', 'FormData', 'Blob', 'File', 'FileReader', 'Image', 'ImageBitmap', 'createImageBitmap',
  'XMLHttpRequest', 'WebSocket', 'Event', 'CustomEvent', 'EventTarget', 'AbortController', 'structuredClone',
  'localStorage', 'sessionStorage', 'location', 'history', 'navigator', 'document', 'window', 'globalThis',
  'crypto', 'performance', 'Node', 'Element', 'HTMLElement', 'getComputedStyle', 'alert', 'confirm', 'prompt',
  'import', 'super', 'this', 'arguments', 'undefined', 'NaN', 'Infinity', 'require', 'WeakMap', 'queueMicrotask',
  'Headers', 'DataView', 'async', 'click', 'var', 'mix', 'translate', 'Export',
]);

/**
 * 去掉注释与字符串字面量，避免把文案/CSS 当成代码扫描。
 * 关键点：模板字符串里 `${...}` 是**真实代码**，必须保留（否则形如
 * `...${state.settings.x}...` 的引用会漏检——这正是 gallery.js 漏掉 state 导入的原因）。
 * @param {string} src
 */
/**
 * 去掉注释与字符串/模板字面量，避免把文案与 CSS 当成代码扫描。
 * 模板插值 ${...} 里的引用由 collectTemplateExprRefs 单独扫描（整体丢弃会漏检）。
 * @param {string} src
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { quote = c; state = 'str'; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i++; continue; }
    if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i += 2; } else i++; continue; }
    if (state === 'str') {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) state = 'code';
      i++; continue;
    }
  }
  return out;
}

/**
 * 收集模板字符串插值 ${...} 中出现的成员访问与调用名。
 * 主扫描会整体丢弃模板字面量，若不单独扫这里，形如 `...${state.x}...` 的
 * 引用就会漏检（gallery.js 曾因此漏掉 state 导入）。
 * @param {string} src 原始源码
 * @returns {string[]} 插值中出现的标识符
 */
function collectTemplateExprRefs(src) {
  const refs = [];
  const declared = new Set();
  for (const m of src.matchAll(/\$\{([^{}]*)\}/g)) {
    const expr = m[1];
    // 表达式内的箭头函数参数视为已声明，例如 ${list.map((x) => x.name)}
    for (const p of expr.matchAll(/\(([^()]*)\)\s*=>/g)) {
      for (const part of p[1].split(',')) declared.add(part.trim().split('=')[0].trim().split(':').pop().trim());
    }
    for (const p of expr.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(p[1]);
    for (const ref of expr.matchAll(/(^|[^.\w$'"])([A-Za-z_$][\w$]*)\s*\(/g)) refs.push(ref[2]);
    for (const ref of expr.matchAll(/(^|[^.\w$'"?])([A-Za-z_$][\w$]*)\./g)) refs.push(ref[2]);
  }
  return { refs, declared };
}
// 正则字面量剥离用到的「斜杠前允许的字符」，避免与除法混淆
const REGEX_START_AFTER = '(,=:[!&|?{};';

/**
 * 去掉正则字面量（例如 /not in/i），否则其中的 i.test 会被误判为属性访问。
 * 启发式：斜杠前一个有效字符属于 (,=:[!&|?{}; 或处于行首时视为正则开始。
 * @param {string} src 已剥离注释与字符串的源码
 * @returns {string} 去掉正则字面量后的源码
 */
function stripRegexLiterals(src) {
  let out = '';
  let i = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && prev !== ')' && (prev === '' || REGEX_START_AFTER.includes(prev))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        // 连同标志位（gimsuyvd）一起吃掉，否则 /x/i.test 会残留 "i.test"
        let k = j + 1;
        while (k < src.length && /[a-z]/.test(src[k]) && 'gimsuyvd'.includes(src[k])) k++;
        out += ' ';
        i = k;
        prev = ')';
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** 扫描前处理：先剥离注释与字符串，再剥离正则字面量。 */
function sanitize(src) {
  return stripRegexLiterals(stripCommentsAndStrings(src));
}

function declaredNames(src) {
  const names = new Set();
  const add = (n) => { if (n) names.add(n); };
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const part of m[1].split(',')) add(part.trim().split(/\s+as\s+/).pop().trim());
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) add(m[1]);
  for (const m of src.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
  for (const m of src.matchAll(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
  for (const m of src.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[,=]/g)) add(m[1]);
  // 数组解构：const [a, b] = ...
  for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]+)\]/g)) {
    for (const part of m[1].split(',')) add(part.trim().split('=')[0].trim().replace(/^\.\.\./, ''));
  }
  // 解构与多声明：const {a, b} = ... / const a = 1, b = 2;
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const namePart = part.trim().split('=')[0].trim().split(':').pop().trim();
      add(namePart.replace(/^\.\.\./, ''));
    }
  }
  // 函数参数（支持默认值、rest、对象/数组解构）
  const addParamNames = (raw) => {
    for (const part of raw.split(',')) {
      let namePart = part.trim().split('=')[0].trim();
      namePart = namePart.replace(/^\.\.\./, '');          // rest 参数
      if (namePart.startsWith('{') || namePart.startsWith('[')) {
        for (const sub of namePart.replace(/[{}[\]]/g, '').split(',')) {
          add(sub.trim().split(':').pop().trim().replace(/^\.\.\./, ''));
        }
      } else add(namePart);
    }
  };
  for (const m of src.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) addParamNames(m[1]);
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1].split(',')) add(part.trim().split('=')[0].trim());
  }
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  // for (...) 头部声明的所有名字（含解构、逗号分隔）
  for (const m of src.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([^;)\n]+)/g)) {
    addParamNames(m[1].split(/\s+of\s+|\s+in\s+/)[0]);
  }
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // 类与对象简短方法：name(...) { } 形式
  for (const m of src.matchAll(/^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) add(m[1]);
  // 对象字面量简写：{ foo, bar }
  for (const m of src.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*[,}]/g)) add(m[1]);
  return names;
}

/**
 * 找出「被调用」或「被当对象访问属性」但未声明的顶层标识符。
 * @param {string} src 已剥离注释与字符串的源码
 * @returns {string[]} 未声明的标识符列表
 */
function undeclaredRefs(src) {
  const declared = declaredNames(src);
  const bad = new Set();
  const known = (name) => BUILTINS.has(name) || declared.has(name);
  // 1) 函数调用：name(
  for (const m of src.matchAll(/(^|[^.\w$'"])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!known(m[2])) bad.add(m[2]);
  }
  // 2) 属性访问：name.xxx（前一个字符不是点号/问号/字面量，排除 obj.name.xxx 与 obj?.name）
  for (const m of src.matchAll(/(^|[^.\w$'"?])([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
    if (!known(m[2])) bad.add(m[2]);
  }
  return [...bad];
}

test('前端模块不存在未声明的标识符引用（调用与属性访问）', () => {
  const problems = [];
  for (const file of FILES) {
    const raw = fs.readFileSync(file, 'utf8');
    const bad = new Set(undeclaredRefs(stripRegexLiterals(stripCommentsAndStrings(raw))));
    // 模板插值里的引用单独补扫（主扫描丢弃模板字面量）
    const declared = declaredNames(stripCommentsAndStrings(raw));
    const known = (n) => BUILTINS.has(n) || declared.has(n);
    const tpl = collectTemplateExprRefs(raw);
    for (const name of tpl.refs) {
      if (tpl.declared.has(name) || known(name)) continue;
      bad.add(name);
    }
    if (bad.size) problems.push(`${file}: ${[...bad].join(', ')}`);
  }
  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});
