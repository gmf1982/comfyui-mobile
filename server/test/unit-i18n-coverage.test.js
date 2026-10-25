/**
 * i18n 覆盖测试：web/js 里所有 t()/tf() 用的中文字符串键都必须有 EN 词典词条，
 * 否则英文界面会漏出中文（回归防护：2026-10 更多页显存卡片曾整块漏翻）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { t, setLang } from '../../web/js/lib/i18n.js';
import {
  CLASS_NAMES_ZH, FIELD_LABELS, MODEL_LABELS, ROLE_ROW_TITLES, friendlyClassName, heroRowTitle,
} from '../../web/js/lib/workflow-form.js';
import { enhancePrompt, detectModelProfile, detectMode } from '../../web/js/lib/prompt-enhancer.js';
import { reqLang, pick } from '../src/lang.js';

const CJK = /[\u4e00-\u9fff]/;

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

test('工作流表单/节点图的标签都有英文词条', () => {
  setLang('en');
  try {
    const values = new Set([
      ...Object.values(CLASS_NAMES_ZH),
      ...Object.values(FIELD_LABELS),
      ...Object.values(MODEL_LABELS),
      ...Object.values(ROLE_ROW_TITLES),
    ]);
    const missing = [...values].filter((value) => CJK.test(value) && t(value) === value);
    assert.deepEqual(missing, [], '以下工作流标签缺 EN 词条');
    assert.doesNotMatch(friendlyClassName('KSampler'), CJK, '英文下节点类名不应是中文');
    assert.doesNotMatch(heroRowTitle('positive'), CJK, '英文下参数行标题不应是中文');
  } finally {
    setLang('zh');
  }
});

test('workflow-form 的动态标签都经过 t()/tf()', () => {
  const src = readFileSync('web/js/lib/workflow-form.js', 'utf8');
  const rawLabels = [...src.matchAll(/\blabel:\s*'([^']*[\u4e00-\u9fff][^']*)'/g)].map((m) => m[1]);
  const rawHeroes = [...src.matchAll(/addHero\([^,\n]+,\s*[^,\n]+,\s*'([^']*[\u4e00-\u9fff][^']*)'/g)].map((m) => m[1]);
  assert.deepEqual([...rawLabels, ...rawHeroes], [], '中文 label 必须包在 t() 里');
});

test('模型识别覆盖常见模型与当前表单选择', () => {
  assert.equal(detectModelProfile({ '4': { inputs: { ckpt_name: 'flux1-dev.safetensors' } } }), 'flux');
  assert.equal(detectModelProfile({ '4': { inputs: { ckpt_name: 'sdxl_base_1.0.safetensors' } } }), 'sdxl');
  assert.equal(detectModelProfile({ '4': { inputs: { ckpt_name: 'sd3.5_large.safetensors' } } }), 'sd3');
  assert.equal(detectModelProfile({ '4': { inputs: { ckpt_name: 'wan2.2_i2v.safetensors' } } }), 'wan');
  assert.equal(detectModelProfile({ '4': { inputs: { ckpt_name: 'hunyuan_video.safetensors' } } }), 'hunyuan');
  assert.equal(detectModelProfile({}, { '4:ckpt_name': 'qwen-image-2.1.safetensors' }), 'qwen');
  assert.equal(detectModelProfile({
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'qwen-image-2.1.safetensors' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a flux of light, krea style' } },
    '3': { class_type: 'FluxGuidance', inputs: {} },
  }), 'qwen', '提示词正文/辅助节点不应盖过实际 checkpoint');
  assert.equal(detectMode({}, 'wan'), 'video');
  assert.equal(detectMode({}, 'flux'), 't2i');
});

test('提示词增强按输入语言输出（英文输入不混中文）', () => {
  const t2i = enhancePrompt({ text: 'a cat sitting on a windowsill', profileKey: 'qwen', mode: 't2i' });
  assert.doesNotMatch(t2i.text, CJK);
  const video = enhancePrompt({ text: 'a girl walking in the rain', profileKey: 'h3', mode: 'video' });
  assert.doesNotMatch(video.text, CJK);
  const zh = enhancePrompt({ text: '一只猫坐在窗台上', profileKey: 'qwen', mode: 't2i' });
  assert.match(zh.text, CJK);
});

test('服务端按 X-App-Lang / Accept-Language 选择文案', () => {
  assert.equal(reqLang({ headers: { 'x-app-lang': 'en' } }), 'en');
  assert.equal(reqLang({ headers: { 'accept-language': 'en-US,en;q=0.9' } }), 'en');
  assert.equal(reqLang({ headers: {} }), 'zh');
  assert.equal(pick('en', '中文', 'English'), 'English');
  assert.equal(pick('zh', '中文', 'English'), '中文');
});
