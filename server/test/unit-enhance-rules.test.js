/**
 * 增强规则测试：系统提示词按模式取自 server/prompts/*.txt（用户可直接改文件），
 * 图像规则要求模型返回 JSON，网关只取 rewritten_prompt；长描述输出的退化判定不误杀。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { buildSystemPrompt, parseRewrittenPrompt, isDegenerate, enhanceWithLlm } from '../src/enhance.js';

const RULE_FILES = { t2i: 't2i.txt', edit: 'i2i.txt', video: 'h3.txt' };

function readRule(file) {
  return readFileSync(`server/prompts/${file}`, 'utf8').trim();
}

/** OpenAI 兼容桩：记录收到的请求体，按 content 回固定内容。 */
function stubLlm(content) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    port: server.address().port,
    seen,
    close: () => { server.closeAllConnections?.(); return new Promise((done) => server.close(done)); },
  })));
}

test('三种模式各自加载对应规则文件，未知模式回退文生图', () => {
  for (const [mode, file] of Object.entries(RULE_FILES)) {
    const onDisk = readRule(file);
    assert.equal(buildSystemPrompt(mode), onDisk, `${mode} 应原样透传 ${file}`);
    assert.ok(onDisk.length > 500, `${file} 规则不应为空壳`);
  }
  assert.notEqual(buildSystemPrompt('edit'), buildSystemPrompt('t2i'), '编辑规则与文生图规则是两份');
  assert.equal(buildSystemPrompt('whatever'), buildSystemPrompt('t2i'));
});

test('图像规则的 JSON 输出只取 rewritten_prompt，宽高比不落地', () => {
  const prompt = '这是一张竖构图写实摄影，一只猫坐在洒满阳光的窗台上，浅景深，暖色调。';
  assert.equal(parseRewrittenPrompt(JSON.stringify({ rewritten_prompt: prompt, wh_ratio: '2:3', ratio_follow: '' })), prompt);
  assert.equal(parseRewrittenPrompt('```json\n' + JSON.stringify({ rewritten_prompt: prompt }) + '\n```'), prompt);
  assert.equal(parseRewrittenPrompt('前置说明一句话。\n' + JSON.stringify({ rewritten_prompt: prompt })), prompt);
});

test('JSON 被 max_tokens 截断时仍抠出正文，纯文本原样放行', () => {
  const prompt = '一只猫坐在窗台上，光线柔和';
  // 截断：闭合引号与右花括号都还没输出
  assert.equal(parseRewrittenPrompt(`{"rewritten_prompt": "${prompt}，背景是`), prompt + '，背景是');
  // 正文里的转义引号不能被当成闭合
  assert.equal(parseRewrittenPrompt(`{"rewritten_prompt": "标题写着 \\"夏日\\" 在顶部"`), '标题写着 "夏日" 在顶部');
  assert.equal(parseRewrittenPrompt('模型没按 JSON 输出，直接给了提示词'), '');
});

test('长描述按循环塌缩判退化，不按词频误杀', () => {
  // 真实长描述：the / 画面 这类短词高频，但不会同一片段连续重复三遍
  const long = '这是一张竖构图写实摄影。' + Array.from({ length: 20 }, (_, i) => `画面左侧的第 ${i + 1} 件器物是 the object ${i}，投影向右。`).join('');
  assert.ok(long.length > 160);
  assert.equal(isDegenerate(long), false, '三四百词的描述里方位短词高频重复是正常行文');
  const loop = '一只猫坐在窗台上，柔和的自然光洒在毛发上。'.repeat(10);
  assert.equal(isDegenerate(loop), true, '长输出里同一片段连续重复三遍要拦住');
  assert.equal(isDegenerate('海浪，海浪，海浪，海浪，海浪'), true, '短句复读仍照旧拦截');
});

test('enhanceWithLlm：按模式装配规则，放宽长度上限，返回抠出的正文', async (t) => {
  const prompt = '一张竖构图写实摄影，一只猫蜷在窗台上，柔和的晨光，浅景深。';
  const stub = await stubLlm(JSON.stringify({ rewritten_prompt: prompt, wh_ratio: '2:3', ratio_follow: '' }));
  t.after(() => stub.close());

  const out = await enhanceWithLlm(
    { baseUrl: `http://127.0.0.1:${stub.port}`, model: 'm', apiKey: 'k' },
    { text: '一只猫', mode: 't2i' },
  );
  assert.equal(out.text, prompt);
  const req = stub.seen[0];
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.messages[0].content, buildSystemPrompt('t2i'), '系统提示词应是 t2i.txt 全文');
  assert.equal(req.messages[1].content, '一只猫');
  assert.ok(req.max_tokens >= 6000, '字数不限：长描述不能被旧上限截断');
});

test('视频模式不做 JSON 抽取，规则文件为 h3.txt', async (t) => {
  const text = 'integrated_multimodal_description: [Shot 1] 电影感，一只猫缓缓抬头。';
  const stub = await stubLlm(text);
  t.after(() => stub.close());
  const out = await enhanceWithLlm({ baseUrl: `http://127.0.0.1:${stub.port}`, model: 'm' }, { text: '一只猫', mode: 'video' });
  assert.equal(out.text, text);
  assert.equal(stub.seen[0].messages[0].content, buildSystemPrompt('video'));
});
