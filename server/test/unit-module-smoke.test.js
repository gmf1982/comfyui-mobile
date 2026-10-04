/**
 * 前端模块冒烟测试：用最小 DOM/浏览器桩真正加载 web/js 下的模块并调用关键函数。
 *
 * 为什么需要它：`node --check` 只验证语法，抓不到「引用了未声明的模块级变量」
 * 这类运行时错误。2026-09-26 就因此把 `let fullObjInfo` 误删，直到用户在手机上
 * 点「＋ 节点」才暴露（fullObjInfo is not defined）。这里通过真实 import + 调用
 * 把这类错误挡在提交前。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** 安装最小浏览器环境桩；返回清理函数。 */
function installStubs() {
  const saved = {
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    location: globalThis.location,
    fetch: globalThis.fetch,
    crypto: globalThis.crypto,
    navigator: globalThis.navigator,
    XMLHttpRequest: globalThis.XMLHttpRequest,
    WebSocket: globalThis.WebSocket,
  };
  const store = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
      clear: () => map.clear(),
      key: (i) => [...map.keys()][i] ?? null,
      get length() { return map.size; },
    };
  };
  class StubNode {}
  globalThis.Node = StubNode;
  const makeEl = (tag) => Object.assign(new StubNode(), {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    attributes: {},
    textContent: '',
    value: '',
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    append(...kids) { this.children.push(...kids); },
    appendChild(k) { this.children.push(k); return k; },
    replaceChildren() { this.children.length = 0; },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
    click() {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
  });
  globalThis.document = {
    documentElement: makeEl('html'),
    body: makeEl('body'),
    cookie: '',
    createElement: (t) => makeEl(t),
    createElementNS: (_ns, t) => makeEl(t),
    createTextNode: (t) => ({ textContent: t }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  };
  globalThis.localStorage = store();
  globalThis.sessionStorage = store();
  globalThis.location = { hash: '#/gallery', href: 'http://localhost/', protocol: 'http:', host: 'localhost', origin: 'http://localhost', pathname: '/', search: '' };
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', serviceWorker: undefined, canShare: undefined }, configurable: true, writable: true });
  if (!globalThis.crypto?.randomUUID) {
    Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: () => 'test-uuid-' + Math.random().toString(16).slice(2) }, configurable: true, writable: true });
  }
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (url.includes('/object_info')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ KSampler: { input: { required: {} } }, LoadImage: { input: { required: {} } } }) };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  globalThis.XMLHttpRequest = class {
    open() {}
    setRequestHeader() {}
    send() { this.upload?.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 }); this.onload?.(); }
    get responseText() { return '{"name":"stub.png","subfolder":"","type":"input"}'; }
    get status() { return 200; }
    upload = {};
  };
  globalThis.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} };

  return () => {
    for (const [k, v] of Object.entries(saved)) {
      try {
        if (v === undefined) delete globalThis[k];
        else Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
      } catch { /* 只读内置项跳过 */ }
    }
  };
}

test('前端核心模块可加载且关键函数可执行（捕捉未声明的模块级变量）', async () => {
  const restore = installStubs();
  try {
    const api = await import('../../web/js/lib/api.js');
    const media = await import('../../web/js/lib/media.js');
    const state = await import('../../web/js/lib/state.js');
    const form = await import('../../web/js/lib/workflow-form.js');

    // api：全量节点列表（曾因 fullObjInfo 未声明而抛错）
    const all = await api.ensureFullObjectInfo();
    assert.ok(all && typeof all === 'object', 'ensureFullObjectInfo 应返回对象');
    assert.ok('KSampler' in all, '应包含节点定义');
    // 缓存命中路径
    assert.equal(await api.ensureFullObjectInfo(), all, '第二次应走内存缓存');

    // api：schema 缓存与失效
    const schemas = await api.ensureSchemas(['KSampler']);
    assert.ok('KSampler' in schemas);
    api.invalidateSchemaCache();
    api.clearSchemas();
    const fresh = await api.fetchFreshSchema('KSampler');
    assert.ok(fresh, 'fetchFreshSchema 应返回 schema');

    // api：上传（走桩 XHR）
    const up = await api.uploadMedia(new File([new Uint8Array(16)], 'a.png', { type: 'image/png' }), { compress: false });
    assert.equal(up.name, 'stub.png');

    // media：压缩与工具函数
    assert.equal(typeof media.compressImage, 'function');
    assert.equal(media.humanSize(2048), '2 KB');
    assert.match(media.thumbUrl({ filename: 'a.png', type: 'output' }), /preview=webp/);

    // state：运行统计与工作流持久化
    state.resetRunStats();
    assert.ok(state.runStats.startedAt);
    const progress = state.noteProgress(3, 20);
    assert.ok('rate' in progress && 'eta' in progress);
    state.markPendingRun();
    assert.equal(state.isPendingRun(), true);
    state.clearPendingRun();
    state.setWorkflow({ name: 'x.json', path: 'x.json', json: {}, format: 'api' });
    assert.deepEqual(state.rememberedWorkflow(), { path: 'x.json', name: 'x.json' });

    // workflow-form：表单推导
    const model = form.buildFormModel({ workflow: { '1': { class_type: 'KSampler', inputs: { seed: 1, steps: 8 } } }, schemas: {} });
    assert.ok(Array.isArray(model.heroes));
  } finally {
    restore();
  }
});

test('ui.js 与各视图模块可加载（捕捉模块级引用错误）', async () => {
  const restore = installStubs();
  try {
    const ui = await import('../../web/js/lib/ui.js');
    assert.equal(typeof ui.el, 'function');
    assert.equal(typeof ui.fileTrigger, 'function');
    assert.equal(typeof ui.fieldEditor, 'function');
    const node = ui.el('div', { class: 'x' }, 'hello');
    assert.equal(node.className, 'x');
    // fileTrigger 必须建立 for 关联并绑定显式触发
    const input = ui.el('input', { type: 'file' });
    input.id = 'probe';
    const label = ui.fileTrigger('btn', '上传', input);
    assert.equal(label.getAttribute('for'), 'probe');

    for (const view of ['login', 'workflows', 'run', 'queue', 'gallery', 'more', 'node-editor', 'settings', 'templates']) {
      const mod = await import(`../../web/js/views/${view}.js`);
      assert.ok(Object.keys(mod).length > 0, `${view}.js 应导出视图函数`);
    }
  } finally {
    restore();
  }
});
