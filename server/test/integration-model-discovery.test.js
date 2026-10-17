/** 集成测试：/gw/enhance-models 实时探测 OpenAI 兼容端点，并把选中模型路由回 /gw/enhance-prompt。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../src/gateway.js';
import { loadConfig } from '../src/config.js';
import { discoverModels } from '../src/model-discovery.js';

const TOKEN = 'model-discovery-token';
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

test('discoverModels 支持 Ollama /api/tags', async () => {
  const ollama = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.2:latest' }] }));
      return;
    }
    res.writeHead(404).end();
  });
  const port = await listen(ollama);
  try {
    const models = await discoverModels({ baseUrl: `http://127.0.0.1:${port}` }, { fresh: true });
    assert.deepEqual(models, ['llama3.2:latest', 'qwen2.5:7b']);
  } finally {
    await close(ollama);
  }
});

test('同一端点多条配置去重；探测成功时已删除的旧模型不再显示', async () => {
  const fake = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'live-a' }, { id: 'live-b' }] }));
      return;
    }
    res.writeHead(404).end();
  });
  const fakePort = await listen(fake);
  const cfg = loadConfig({
    configFile: '',
    overrides: {
      token: TOKEN,
      upstream: 'http://127.0.0.1:1',
      webDir: webRoot,
      promptLlm: {
        enabled: true,
        models: [
          { name: 'A', baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: '', model: 'live-a' },
          { name: 'Deleted', baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: '', model: 'gone-model' },
          { name: 'B', baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: '', model: 'live-b', timeoutMs: 240000 },
        ],
      },
    },
  });
  const gw = createGateway(cfg, webRoot);
  const gwPort = await listen(gw.server);
  try {
    const res = await fetch(`http://127.0.0.1:${gwPort}/gw/enhance-models`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const data = await res.json();
    assert.equal(data.live, true);
    assert.deepEqual(data.models.map(({ name, model, route }) => ({ name, model, route })), [
      { name: 'A', model: 'live-a', route: 0 },
      { name: 'B', model: 'live-b', route: 2 },
    ]);
    assert.equal(data.models.some((m) => m.model === 'gone-model'), false, '探测成功时不应保留已删除的配置模型');
  } finally {
    await close(gw.server);
    await close(fake);
  }
});

test('端点不可达时回退配置模型并标记 live:false', async () => {
  const dead = http.createServer((req, res) => res.writeHead(404).end());
  const deadPort = await listen(dead);
  const cfg = loadConfig({
    configFile: '',
    overrides: {
      token: TOKEN,
      upstream: 'http://127.0.0.1:1',
      webDir: webRoot,
      promptLlm: {
        enabled: true,
        models: [{ name: 'Legacy', baseUrl: `http://127.0.0.1:${deadPort}/v1`, apiKey: '', model: 'gone-model' }],
      },
    },
  });
  const gw = createGateway(cfg, webRoot);
  const gwPort = await listen(gw.server);
  try {
    const res = await fetch(`http://127.0.0.1:${gwPort}/gw/enhance-models`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const data = await res.json();
    assert.equal(data.live, false, '探测失败应标记为回退列表');
    assert.deepEqual(data.models.map(({ name, model }) => ({ name, model })), [
      { name: 'Legacy', model: 'gone-model' },
    ]);
  } finally {
    await close(gw.server);
    await close(dead);
  }
});

test('增强模型实时探测与路由', async () => {
  let lastChatBody = null;
  const fake = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-model-a' }, { id: 'fake-model-b' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastChatBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'enhanced prompt' } }] }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  const fakePort = await listen(fake);

  const cfg = loadConfig({
    configFile: '',
    overrides: {
      token: TOKEN,
      upstream: 'http://127.0.0.1:1',
      webDir: webRoot,
      // model 留空：只靠实时探测
      promptLlm: {
        enabled: true,
        models: [{ name: 'Fake', baseUrl: `http://127.0.0.1:${fakePort}`, apiKey: '' }],
      },
    },
  });
  const gw = createGateway(cfg, webRoot);
  const gwPort = await listen(gw.server);
  const base = `http://127.0.0.1:${gwPort}`;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  try {
    const res = await fetch(`${base}/gw/enhance-models`, { headers: auth });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.enabled, true);
    assert.deepEqual(data.models.map((m) => m.model).sort(), ['fake-model-a', 'fake-model-b']);
    assert.ok(data.models.every((m) => m.route === 0 && m.key), '探测结果应带 route/key');
    assert.ok(data.default, '应给出默认模型 key');

    const target = data.models.find((m) => m.model === 'fake-model-b');
    const enh = await fetch(`${base}/gw/enhance-prompt`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'a cat', model: target.model, route: target.route }),
    });
    assert.equal(enh.status, 200);
    assert.equal((await enh.json()).text, 'enhanced prompt');
    assert.equal(lastChatBody.model, 'fake-model-b', '应把探测到的模型 ID 发给对应端点');
  } finally {
    await close(gw.server);
    await close(fake);
  }
});
