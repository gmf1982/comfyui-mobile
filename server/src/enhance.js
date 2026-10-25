/**
 * LLM 提示词增强：调用 OpenAI 兼容的 chat/completions 端点为提示词做智能扩写。
 * 同一套客户端同时覆盖：在线（智谱开放平台 open.bigmodel.cn/api/paas/v4）与
 * 本地（Ollama http://127.0.0.1:11434/v1、llama.cpp 含多模型路由模式、LM Studio 等）。
 * API Key 只保存在网关配置里，永不下发手机端；未配置时网关回 501，手机端回退内置规则增强。
 *
 * 增强规则按模式取自 server/prompts/ 下的独立 txt（文生图 t2i.txt、图生图·编辑 i2i.txt、
 * 视频 h3.txt），每次请求实时读取：改完规则存盘即生效，不必重启网关。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pick } from './lang.js';

/** 手机端 detectMode 的三种模式 → 规则文件名。 */
const MODE_RULE_FILES = { t2i: 't2i.txt', edit: 'i2i.txt', video: 'h3.txt' };

const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

/** 读取规则文件（trim 顺带去掉首部 BOM）。缺失或为空即响，让调用方回退规则增强。 */
function loadRuleFile(mode) {
  const file = MODE_RULE_FILES[mode] ?? MODE_RULE_FILES.t2i;
  const full = path.join(PROMPT_DIR, file);
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    throw new Error(`规则文件缺失：server/prompts/${file}`);
  }
  const rule = text.trim();
  if (!rule) throw new Error(`规则文件为空：server/prompts/${file}`);
  return rule;
}

/**
 * 单次增强的默认硬超时，可被 promptLlm.models 条目的可选 timeoutMs（毫秒）按模型覆盖。
 * 本地 llama.cpp 路由（--models-max 1）按需换装模型，冷加载 27B 级 GGUF 可能
 * 需要一两分钟；新规则要求 400-500 词的长段描述，思考型模型还要先耗完思考预算，
 * 因此默认超时放宽到 3 分钟，大模型条目应再按实测放宽 timeoutMs。
 */
const TIMEOUT_MS = 180000;

/**
 * 长段扩写的输出上限：新规则要求三四百词（约 20 句）的完整画面描述，
 * 3000 token 会把中文描述拦腰截断；思考型模型的思考段也计在这份额里。
 */
const MAX_TOKENS = 8000;

/**
 * 检测"复读机"式退化输出，分长短两档：
 * - 短输出（≤160 字，旧规则的量级）：同一 ≤6 字片段出现 ≥4 次即判退化。
 * - 长输出（新规则的三四百词描述）：the / 画面 这类短词高频出现是正常行文，
 *   按词频判会误杀，只抓真正的循环塌缩——同一片段连续重复三遍。
 * 长片段重复可能是排比修辞，不判。退化时调用方按失败处理（手机端自动回退规则增强），
 * 绝不能把这种结果替换进输入框。
 */
export function isDegenerate(text) {
  const s = String(text);
  const hasWord = /[^\s，。,.;；、]/;
  if (s.length <= 160) {
    const parts = s.split(/[，。,.;；、\s]+/).filter(Boolean);
    const counts = new Map();
    for (const p of parts) counts.set(p, (counts.get(p) ?? 0) + 1);
    for (const [seg, n] of counts) {
      if (n >= 4 && seg.length <= 6) return true;
    }
    return false;
  }
  for (let len = 4; len <= 30; len++) {
    for (let i = 0; i + len * 3 <= s.length; i++) {
      const block = s.slice(i, i + len);
      if (hasWord.test(block) && s.startsWith(block, i + len) && s.startsWith(block, i + len * 2)) return true;
    }
  }
  return false;
}

/**
 * 构造系统提示词：直接返回当前模式对应的规则文件内容（见 server/prompts/）。
 * @param {'t2i'|'edit'|'video'} mode 手机端检测到的模式
 * @returns {string}
 */
export function buildSystemPrompt(mode) {
  return loadRuleFile(mode);
}

/** 从 open（指向开引号）之后找未转义的闭引号；被截断时返回 -1。 */
function findClosingQuote(raw, open) {
  for (let i = open; i < raw.length; i++) {
    if (raw[i] !== '"') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && raw[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

/**
 * t2i.txt / i2i.txt 要求模型返回单行 JSON（rewritten_prompt + wh_ratio + ratio_follow）。
 * 这里只取 rewritten_prompt：宽高比按选择不落地，既不混进提示词也不改工作流参数。
 * 长描述常在输出中途被 max_tokens 截断，JSON.parse 会整块失败，所以再手动抠一次字段值；
 * 抠不出来（模型没按 JSON 输出）返回空串，调用方保留原文。
 * @param {string} raw 已剥除思考段与围栏的模型输出
 * @returns {string} 提示词正文，或 ''
 */
export function parseRewrittenPrompt(raw) {
  const start = raw.indexOf('{');
  if (start === -1) return '';
  try {
    const value = JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1))?.rewritten_prompt;
    if (typeof value === 'string' && value.trim()) return value.trim();
  } catch { /* 截断或非法 JSON，走下面的字段兜底 */ }
  const key = '"rewritten_prompt"';
  const at = raw.indexOf(key, start);
  if (at === -1) return '';
  const colon = raw.indexOf(':', at + key.length);
  const open = colon === -1 ? -1 : raw.indexOf('"', colon + 1);
  if (open === -1) return '';
  const close = findClosingQuote(raw, open + 1);
  const body = close === -1 ? raw.slice(open + 1) : raw.slice(open + 1, close);
  return body.replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
}

/**
 * 调用 OpenAI 兼容 chat/completions 生成增强提示词。
 * @param {{baseUrl: string, apiKey?: string, model: string, timeoutMs?: number}} llm 网关 promptLlm 配置
 * @param {{text: string, mode: string, lang?: 'zh'|'en', image?: string|null}} input image 为当前输入图的 data URL（仅视觉模型可用）
 * @returns {Promise<{text: string}>}
 */
export async function enhanceWithLlm(llm, { text, mode, lang = 'zh', image = null }) {
  const base = String(llm.baseUrl).replace(/\/+$/, '');
  // 配置可能是 https://.../v1、https://.../api/paas/v4 或裸 Ollama 根地址；
  // 裸根地址先按原路径失败时再试 /v1，兼容 Ollama 的 OpenAI 兼容端点。
  const urls = [`${base}/chat/completions`];
  if (!/\/v1$/i.test(base)) urls.push(`${base}/v1/chat/completions`);
  const body = JSON.stringify({
    model: llm.model,
    temperature: 0.6,
    // 抗重复：小模型（270M 级）不加惩罚会输出"海浪，海浪，海浪…"式复读
    frequency_penalty: 0.4,
    presence_penalty: 0.3,
    // 思考型模型（如 reasoning 预算 2048 的本地路由预设）会先耗思考 token 再出正文，
    // 上限太小会让正文为空；思考段由下方剥除逻辑处理，不会进入结果。
    max_tokens: MAX_TOKENS,
    messages: [
      { role: 'system', content: buildSystemPrompt(mode) },
      // 图生图·编辑：网关已把当前输入图取成 data URL，按 OpenAI 多模态格式附带；
      // 纯文本模型会在端点侧报 400，由手机端回退无图重试。
      {
        role: 'user',
        content: image
          ? [
            { type: 'text', text },
            { type: 'image_url', image_url: { url: image } },
          ]
          : text,
      },
    ],
  });
  let res = null;
  for (let i = 0; i < urls.length; i++) {
    res = await fetch(urls[i], {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(Number(llm.timeoutMs) || TIMEOUT_MS),
    });
    // 只有「路径不存在」才换下一种写法；鉴权/限流/模型错误直接返回
    if ((res.status === 404 || res.status === 405) && i < urls.length - 1) continue;
    break;
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(pick(lang, `LLM 端点返回 ${res.status}${detail ? `：${detail}` : ''}`, `LLM endpoint returned ${res.status}${detail ? `: ${detail}` : ''}`));
  }
  const data = await res.json();
  let out = data?.choices?.[0]?.message?.content;
  if (typeof out !== 'string' || !out.trim()) throw new Error(pick(lang, 'LLM 返回内容为空', 'LLM returned an empty response'));
  // qwen3 等思考型模型会先输出 <think>…</think> 推理段，剥掉只留正文。
  // llama.cpp 路由开推理解析时可能吞掉开标签、只在正文残留闭合标签，
  // 此时闭标签之前整段都是思考残段，一并剥掉。
  out = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  out = out.replace(/^[\s\S]*?<\/think>/, '').trim();
  // 剥掉模型可能套上的 Markdown 围栏与首尾引号。
  // 注意：这里刻意不用含反引号的正则字面量——web 前端守卫测试的字符串/正则两段式
  // 剥离器会被正则里的反引号打乱（服务端模块同样保持一致，降低认知负担）。
  const fence = '```';
  out = out.trim();
  if (out.startsWith(fence)) {
    const nl = out.indexOf('\n');
    out = nl === -1 ? '' : out.slice(nl + 1);
  }
  if (out.endsWith(fence)) out = out.slice(0, -fence.length);
  // 图像两种模式的规则要求 JSON 输出，视频规则直接给正文——只在图像模式里取 rewritten_prompt。
  if (mode !== 'video') out = parseRewrittenPrompt(out) || out;
  out = out.replace(/^["“”']+|["“”']+$/g, '').trim();
  if (!out) throw new Error(pick(lang, 'LLM 返回内容为空', 'LLM returned an empty response'));
  if (isDegenerate(out)) throw new Error(pick(lang, '模型输出重复退化', 'Model output degenerated into repetition'));
  return { text: out };
}
