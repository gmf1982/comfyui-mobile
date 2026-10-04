/** 集成测试：/gw/enhance-prompt（LLM 提示词增强）——多模型选择、未配置 501、端点故障 502、列表不泄露端点。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../src/gateway.js';
import { loadConfig } from '../src/config.js';

const TOKEN = 'enhance-test-token';
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

function makeGateway(overrides = {}) {
  const cfg = loadConfig({
    configFile: '',
    overrides: { token: TOKEN, upstream: 'http://127.0.0.1:9', ...overrides },
  });
  const gw = createGateway(cfg, webRoot);
  return listen(gw.server).then((port) => ({ gw, base: `http://127.0.0.1:${port}`, cfg }));
}

function post(base, body) {
  return fetch(`${base}/gw/enhance-prompt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** OpenAI 兼容桩：回显被选中的 Authorization 与 payload.model，便于断言路由。 */
async function stubLlm() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, payload: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `ok:${seen[seen.length - 1].payload.model}` } }] }));
    });
  });
  const port = await listen(server);
  return { port, seen, close: () => new Promise((r) => server.close(r)) };
}

test('models 多模型列表：按 name 选择对应端点（不同 apiKey 分开走）', async (t) => {
  const stub = await stubLlm();
  const { base, gw } = await makeGateway({
    promptLlm: {
      enabled: true,
      default: '本地gemma',
      models: [
        { name: '本地gemma', baseUrl: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'key-local', model: 'gemma3:270m' },
        { name: 'GLM', baseUrl: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'key-glm', model: 'glm-4.7-flash' },
      ],
    },
  });
  t.after(async () => { await gw.close(); await stub.close(); });

  const res = await post(base, { text: '一只猫', profileKey: 'qwen', mode: 't2i', model: 'GLM' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.source, 'llm');
  assert.equal(data.model, 'glm-4.7-flash');
  assert.equal(data.name, 'GLM');
  assert.equal(stub.seen[0].auth, 'Bearer key-glm', '选中 GLM 应带 GLM 的 apiKey');
  assert.match(data.text, /ok:glm-4\.7-flash/);
});

test('未指定模型时用 default；GET /gw/enhance-models 不返回 baseUrl/apiKey', async (t) => {
  const stub = await stubLlm();
  const { base, gw } = await makeGateway({
    promptLlm: {
      enabled: true,
      models: [
        { name: '本地gemma', baseUrl: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'key-local', model: 'gemma3:270m' },
        { name: 'GLM', baseUrl: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'key-glm', model: 'glm-4.7-flash' },
      ],
    },
  });
  t.after(async () => { await gw.close(); await stub.close(); });

  const res = await post(base, { text: '一只猫' });
  const data = await res.json();
  assert.equal(data.name, '本地gemma', '无 model 字段应回退 default（列表首项）');
  assert.equal(stub.seen[0].auth, 'Bearer key-local');

  const list = await fetch(`${base}/gw/enhance-models`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(list.status, 200);
  const listData = await list.json();
  assert.equal(listData.enabled, true);
  assert.deepEqual(listData.models, [
    { name: '本地gemma', model: 'gemma3:270m' },
    { name: 'GLM', model: 'glm-4.7-flash' },
  ], '列表只含 name/model，无端点与密钥');
  assert.equal(JSON.stringify(listData).includes('baseUrl'), false, '绝不泄露 baseUrl');
  assert.equal(JSON.stringify(listData).includes('apiKey'), false, '绝不泄露 apiKey');
});

test('旧的单模型写法（baseUrl+model）仍兼容', async (t) => {
  const stub = await stubLlm();
  const { base, gw } = await makeGateway({
    promptLlm: { enabled: true, baseUrl: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'legacy', model: 'old-model' },
  });
  t.after(async () => { await gw.close(); await stub.close(); });
  const res = await post(base, { text: '一只猫', profileKey: 'qwen', mode: 't2i' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).model, 'old-model');
});

test('未配置 promptLlm 返回 501（手机端据此回退规则增强）；LLM 端点故障返回 502', async (t) => {
  const { base, gw } = await makeGateway({});
  t.after(() => gw.close());
  assert.equal((await post(base, { text: '一只猫' })).status, 501);

  const { base: base2, gw: gw2 } = await makeGateway({
    promptLlm: { enabled: true, baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'm' },
  });
  t.after(() => gw2.close());
  const res = await post(base2, { text: '一只猫' });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'llm_failed');
});

test('空文本返回 400；鉴权仍走网关令牌', async (t) => {
  const stub = await stubLlm();
  const { base, gw } = await makeGateway({
    promptLlm: { enabled: true, baseUrl: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'k', model: 'm' },
  });
  t.after(async () => { await gw.close(); await stub.close(); });

  const empty = await post(base, { text: '' });
  assert.equal(empty.status, 400);

  const bad = await fetch(`${base}/gw/enhance-prompt`, {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x' }),
  });
  assert.equal(bad.status, 401, '错误令牌被网关拒绝，不触达 LLM');
});
