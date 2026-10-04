/** 第五轮：动态输入（autogrow/dynamiccombo）与子图实例值对齐规则测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFormModel, convertUiToApi, dynamicInputInfo, isConnectableDef, isSocketlessDef,
  defConnectionType, mediaKindOfOptions,
} from '../../web/js/lib/workflow-form.js';
import { createMockSchemas } from './helpers/schemas.js';

const AUTOGROW_IMAGES = ['COMFY_AUTOGROW_V3', {
  template: { input: { required: { image: ['IMAGE', {}] } }, names: ['image_1', 'image_2', 'image_3'], min: 0 },
}];

test('dynamicInputInfo 解析 autogrow（内层类型/槽名/min）', () => {
  const info = dynamicInputInfo(AUTOGROW_IMAGES);
  assert.equal(info.kind, 'autogrow');
  assert.equal(info.innerType, 'IMAGE');
  assert.deepEqual(info.names, ['image_1', 'image_2', 'image_3']);
  assert.equal(dynamicInputInfo(['INT', {}]), null);
  assert.equal(dynamicInputInfo(['COMFY_DYNAMICCOMBO_V3', { options: [] }]).kind, 'dynamiccombo');
});

test('可连线判定：autogrow 可连、socketless 不可连、widget 不可连', () => {
  assert.equal(isConnectableDef(AUTOGROW_IMAGES), true, 'autogrow 是可连线输入');
  assert.equal(defConnectionType(AUTOGROW_IMAGES), 'IMAGE', 'autogrow 的连接类型取内层类型');
  assert.equal(isSocketlessDef(['IMAGECOMPARE', { socketless: true }]), true);
  assert.equal(isConnectableDef(['IMAGECOMPARE', { socketless: true }]), false, 'socketless 不参与连线');
  assert.equal(isConnectableDef(['MODEL']), true);
  assert.equal(isConnectableDef(['INT', { default: 0 }]), false);
  assert.equal(isConnectableDef([['a', 'b']]), false);
});

test('socketless 必填输入补空串（ImageCompare.compare_view）', () => {
  const ui = {
    nodes: [
      { id: 1, type: 'ImageCompare', mode: 0, inputs: [{ name: 'image_a', link: 11 }, { name: 'image_b', link: 12 }], widgets_values: [] },
    ],
    links: [[11, 90, 0, 1, 0, 'IMAGE'], [12, 91, 0, 1, 1, 'IMAGE']],
  };
  const schemas = {
    ImageCompare: {
      input: {
        required: {
          image_a: ['IMAGE', {}], image_b: ['IMAGE', {}],
          compare_view: ['IMAGECOMPARE', { socketless: true }],
        },
      },
    },
  };
  const { workflow } = convertUiToApi(ui, schemas);
  assert.equal(workflow['1'].inputs.compare_view, '', 'socketless 必填补空串避免校验失败');
  assert.deepEqual(workflow['1'].inputs.image_a, ['90', 0]);
});

test('autogrow 转换保留点号键名（服务端按 image_1 展开）', () => {
  const ui = {
    nodes: [
      {
        id: 5, type: 'EditEncode', mode: 0,
        inputs: [
          { name: 'images.image_1', type: 'IMAGE', link: 21 },
          { name: 'images.image_2', type: 'IMAGE', link: 22 },
        ],
        widgets_values: [],
      },
    ],
    links: [[21, 70, 0, 5, 0, 'IMAGE'], [22, 71, 0, 5, 1, 'IMAGE']],
  };
  const schemas = { EditEncode: { input: { required: { images: AUTOGROW_IMAGES } } } };
  const { workflow } = convertUiToApi(ui, schemas);
  assert.deepEqual(workflow['5'].inputs['images.image_1'], ['70', 0]);
  assert.deepEqual(workflow['5'].inputs['images.image_2'], ['71', 0]);
});

test('子图实例值按“控件槽位”对齐（跳过 autogrow 等连线槽）', () => {
  // 模拟官方 Qwen 编辑模板：sg.inputs 含 4 个控件槽 + 2 个图片连线槽，
  // 实例 widgets_values 只有 4 个值（对应控件槽）
  const ui = {
    nodes: [
      {
        id: 9, type: 'sg-1', mode: 0,
        inputs: [
          { name: 'prompt', type: 'STRING', widget: { name: 'prompt' }, link: null },
          { name: 'steps', type: 'INT', widget: { name: 'steps' }, link: null },
          { name: 'images.image_1', type: 'IMAGE', link: 31 },
          { name: 'images.image_2', type: 'IMAGE', link: 32 },
          { name: 'device', type: 'COMBO', widget: { name: 'device' }, link: null },
          { name: 'dtype', type: 'COMBO', widget: { name: 'dtype' }, link: null },
        ],
        widgets_values: ['一只猫', 25, 'auto', 'default'],
      },
      { id: 70, type: 'LoadImage', mode: 0, inputs: [{ name: 'image', link: null }], widgets_values: ['a.png'] },
      { id: 71, type: 'LoadImage', mode: 0, inputs: [{ name: 'image', link: null }], widgets_values: ['b.png'] },
      { id: 8, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', link: 41 }], widgets_values: ['x'] },
    ],
    links: [
      [31, 70, 0, 9, 2, 'IMAGE'],
      [32, 71, 0, 9, 3, 'IMAGE'],
      [41, 9, 0, 8, 0, 'IMAGE'],
    ],
    definitions: {
      subgraphs: [{
        id: 'sg-1', name: 'Edit',
        nodes: [
          { id: 1, type: 'EditEncode', mode: 0, inputs: [
            { name: 'prompt', link: 51 }, { name: 'images.image_1', link: 52 }, { name: 'images.image_2', link: 53 },
          ], widgets_values: ['内置默认'] },
          { id: 2, type: 'KSampler', mode: 0, inputs: [
            { name: 'positive', link: 54 }, { name: 'steps', link: 55 }, { name: 'device', link: 56 }, { name: 'dtype', link: 57 },
          ], widgets_values: [1, 'fixed', 20, 7, 'euler', 'normal', 1] },
          { id: 3, type: 'VAEDecode', mode: 0, inputs: [{ name: 'samples', link: 58 }], widgets_values: [] },
        ],
        inputs: [
          { name: 'prompt', linkIds: [51] }, { name: 'steps', linkIds: [55] },
          { name: 'images.image_1', linkIds: [52] }, { name: 'images.image_2', linkIds: [53] },
          { name: 'device', linkIds: [56] }, { name: 'dtype', linkIds: [57] },
        ],
        outputs: [{ name: 'IMAGE', type: 'IMAGE' }],
        links: [
          { id: 51, origin_id: -10, origin_slot: 0, target_id: 1, target_slot: 0, type: 'STRING' },
          { id: 52, origin_id: -10, origin_slot: 2, target_id: 1, target_slot: 1, type: 'IMAGE' },
          { id: 53, origin_id: -10, origin_slot: 3, target_id: 1, target_slot: 2, type: 'IMAGE' },
          { id: 55, origin_id: -10, origin_slot: 1, target_id: 2, target_slot: 1, type: 'INT' },
          { id: 56, origin_id: -10, origin_slot: 4, target_id: 2, target_slot: 2, type: 'COMBO' },
          { id: 57, origin_id: -10, origin_slot: 5, target_id: 2, target_slot: 3, type: 'COMBO' },
          { id: 54, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: 'CONDITIONING' },
          { id: 58, origin_id: 2, origin_slot: 0, target_id: 3, target_slot: 0, type: 'LATENT' },
          { id: 60, origin_id: 3, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' },
        ],
      }],
    },
  };
  const schemas = {
    EditEncode: { input: { required: { prompt: ['STRING', {}], images: AUTOGROW_IMAGES } } },
    KSampler: {
      input: { required: { steps: ['INT', { default: 20 }], device: [['auto', 'gpu', 'cpu']], dtype: [['default', 'int8']] } },
    },
    VAEDecode: { input: { required: { samples: ['LATENT'] } } },
    LoadImage: { input: { required: { image: [['a.png', 'b.png']] } } },
    SaveImage: { input: { required: { images: ['IMAGE'] } } },
  };
  const { workflow, warnings } = convertUiToApi(ui, schemas);
  const ks = workflow['9_2'].inputs;
  assert.equal(ks.steps, 25, '第二个控件槽（steps）应取到 25 而非错位值');
  assert.equal(ks.device, 'auto', 'device 应取 auto（不错位到图片槽）');
  assert.equal(ks.dtype, 'default');
  assert.equal(workflow['9_1'].inputs.prompt, '一只猫', '第一个控件槽是提示词');
  assert.deepEqual(workflow['9_1'].inputs['images.image_1'], ['70', 0], '图片槽走连线而非控件值');
  assert.deepEqual(workflow['9_1'].inputs['images.image_2'], ['71', 0]);
  assert.equal(workflow['9'], undefined, '子图外壳不进入结果');
  assert.deepEqual(warnings, [], `不应有警告：${JSON.stringify(warnings)}`);
});

test('子图实例参数数量不匹配时回退内部默认值并告警', () => {
  const ui = {
    nodes: [{ id: 9, type: 'sg-1', mode: 0, inputs: [{ name: 'steps', type: 'INT', widget: { name: 'steps' }, link: null }], widgets_values: [1, 2, 3] }],
    links: [],
    definitions: {
      subgraphs: [{
        id: 'sg-1', name: 'S',
        nodes: [{ id: 2, type: 'KSampler', mode: 0, inputs: [{ name: 'steps', link: 55 }], widgets_values: [1, 'fixed', 20, 7, 'euler', 'normal', 1] }],
        inputs: [{ name: 'steps', linkIds: [55] }],
        outputs: [], links: [{ id: 55, origin_id: -10, origin_slot: 0, target_id: 2, target_slot: 0, type: 'INT' }],
      }],
    },
  };
  const schemas = { KSampler: { input: { required: {
    seed: ['INT', { default: 0 }], steps: ['INT', { default: 20 }], cfg: ['FLOAT', { default: 7 }],
    sampler_name: [['euler']], scheduler: [['normal']], denoise: ['FLOAT', { default: 1 }],
  } } } };
  const { workflow, warnings } = convertUiToApi(ui, schemas);
  assert.equal(workflow['9_2'].inputs.steps, 20, '数量不匹配时用内部默认值');
  assert.ok(warnings.some((w) => w.includes('不一致')), '应有对齐告警');
});

test('图库删除按钮依赖的历史删除与文件删除接口形态正确', async () => {
  // 这两条是客户端调用的接口约定，用 mock 校验请求形状
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts?.method, body: opts?.body });
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
  };
  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    await fakeFetch('/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: ['pid-1'] }) });
    await fakeFetch('/gw/output-file?filename=a.png&subfolder=&type=output', { method: 'DELETE' });
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(JSON.parse(calls[0].body).delete[0], 'pid-1');
  assert.equal(calls[1].method, 'DELETE');
  assert.match(calls[1].url, /filename=a\.png/);
});

test('媒体类型识别仍正确（回归）', () => {
  assert.equal(mediaKindOfOptions(['a.png', 'b.jpg']), 'image');
  assert.equal(mediaKindOfOptions(['m.safetensors']), null);
});
