/**
 * 文本输入框的撤销/重做历史：给提示词等输入框提供后退/前进按钮的引擎。
 *
 * 语义：
 * - 连续键入在 MERGE_MS 内合并为一次编辑（一次撤销回到这串输入之前）；停顿超过
 *   MERGE_MS 或输入框失焦，当前内容才提交为一条记录。
 * - 程序化改写（提示词助手插入、回放）都会派发 input 事件，与手输同一条路径被记录。
 * - 撤销/重做回放会向输入框派发 input 事件，表单值联动（onChange）随之更新。
 * - 传入 key 时历史进模块级登记表：运行页是 hash 路由整页重建的，切页签/返回后
 *   重新挂接，只要当前文字与登记栈顶一致就接回原历史继续撤销/重做；不一致（文字
 *   在别处被改）才另起新栈。无 key 则历史仅随输入框元素存活。
 */

/** 连续输入合并窗口：窗口内反复键入只算一次编辑 */
const MERGE_MS = 800;
/** 单条历史上限：超出丢最旧记录 */
const LIMIT = 200;
/** 登记表容量上限（按登记键计），超出淘汰最久未提交的 */
const REGISTRY_LIMIT = 50;

/** 跨视图重建延续的历史：key → 最近挂接的 {stack, idx}。借 Map 插入序做 LRU。 */
const registry = new Map();

/** 刷新登记键的最近使用位次；超限淘汰最旧。 */
function touchRegistry(key, entry) {
  registry.delete(key);
  registry.set(key, entry);
  if (registry.size > REGISTRY_LIMIT) registry.delete(registry.keys().next().value);
}

/**
 * 挂接历史引擎并监听输入框。
 * @param {HTMLTextAreaElement|HTMLInputElement} ta 目标输入框
 * @param {{ key?: string, onStateChange?: () => void }} opts
 *   key：跨视图延续历史的登记键（如「工作流:字段」）；onStateChange：记录/游标变化后的回调（用于刷新按钮可用态）
 * @returns {{
 *   undo: () => void,
 *   redo: () => void,
 *   canUndo: () => boolean,
 *   canRedo: () => boolean,
 * }} 撤销/重做操作与可用态查询
 */
export function attachTextHistory(ta, opts = {}) {
  const onStateChange = opts.onStateChange ?? (() => {});
  const prev = opts.key ? registry.get(opts.key) : null;
  /** 已提交的编辑快照；entry.stack[entry.idx] 与输入框当前内容一致（正在输入、尚未提交时除外） */
  const entry = prev && prev.stack[prev.idx] === ta.value
    ? prev
    : { stack: [ta.value], idx: 0 };
  let commitTimer = 0;

  const canUndo = () => entry.idx > 0;
  const canRedo = () => entry.idx < entry.stack.length - 1;

  /** 把输入框当前内容提交为一条记录；与栈顶同值（含空转的合并计时器）时不产生记录 */
  function commit() {
    clearTimeout(commitTimer);
    commitTimer = 0;
    const v = ta.value;
    if (v === entry.stack[entry.idx]) return;
    entry.stack = entry.stack.slice(0, entry.idx + 1);
    entry.stack.push(v);
    if (entry.stack.length > LIMIT) entry.stack.shift();
    entry.idx = entry.stack.length - 1;
    if (opts.key) touchRegistry(opts.key, entry);
    onStateChange();
  }

  /** 回放：写回值并派发 input 联动表单；引擎自己的 input 监听会重排计时器，等值提交是空操作 */
  function apply(v) {
    ta.value = v;
    const end = v.length;
    try { ta.setSelectionRange(end, end); } catch { /* 个别输入类型不支持选区，光标位置不重要 */ }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function onInput() {
    // 不立即入栈：停顿 MERGE_MS 后才把当前内容提交，这串输入在窗口内可被整体撤销
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, MERGE_MS);
  }

  function undo() {
    commit(); // 未提交的输入先入栈（成为重做的终点），再回退一步
    if (!canUndo()) return;
    entry.idx -= 1;
    apply(entry.stack[entry.idx]);
    if (opts.key) touchRegistry(opts.key, entry);
    onStateChange();
  }

  function redo() {
    if (!canRedo()) return;
    entry.idx += 1;
    apply(entry.stack[entry.idx]);
    if (opts.key) touchRegistry(opts.key, entry);
    onStateChange();
  }

  ta.addEventListener('input', onInput);
  ta.addEventListener('blur', commit);

  return { undo, redo, canUndo, canRedo };
}
