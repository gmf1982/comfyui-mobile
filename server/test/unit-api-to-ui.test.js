/** graph.js apiToUi 单元测试：API → 桌面 UI 图序列化（保存格式），与 convertUiToApi 互逆。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apiToUi } from '../../web/js/lib/graph.js';
import { convertUiToApi, detectFormat, listApiNodes } from '../../web/js/lib/workflow-form.js';
import { createMockSchemas } from './helpers/schemas.js';

const SD_T2I = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model_a.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1024, batch_size: 2 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '一只猫', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '模糊', clip: ['4', 1] } },
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 42, steps: 25, cfg: 7.5, sampler_name: 'euler', scheduler: 'karras', denoise: 1,
      model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
    },
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'cat', images: ['8', 0] } },
};

// mock 基础集不含 output 声明，这里按真实 object_info 补上 Checkpoint 三输出
const baseSchemas = createMockSchemas();
const schemas = {
  ...baseSchemas,
  CheckpointLoaderSimple: {
    ...baseSchemas.CheckpointLoaderSimple,
    output: ['MODEL', 'CLIP', 'VAE'],
    output_name: ['MODEL', 'CLIP', 'VAE'],
  },
};

test('apiToUi 产出桌面 UI 图结构（nodes/links/版本/坐标）', () => {
  const ui = apiToUi(SD_T2I, schemas);
  assert.equal(detectFormat(ui), 'ui');
  assert.equal(ui.version, 0.4);
  assert.equal(ui.nodes.length, 7);
  assert.equal(ui.links.length, 9);
  assert.equal(ui.last_node_id, 7);
  assert.equal(ui.last_link_id, 9);
  for (const n of ui.nodes) {
    assert.ok(Array.isArray(n.pos) && n.pos.length === 2, '节点应有坐标');
    assert.ok(Array.isArray(n.size) && n.size[0] > 0, '节点应有尺寸');
    assert.equal(n.properties['Node name for S&R'], n.type);
  }
});

test('widgets_values 按 schema 控件序排列，seed 后随 control 槽位', () => {
  const ui = apiToUi(SD_T2I, schemas);
  const ks = ui.nodes.find((n) => n.type === 'KSampler');
  assert.deepEqual(ks.widgets_values, [42, 'fixed', 25, 7.5, 'euler', 'karras', 1]);
  // 连线输入按 schema 顺序占据 inputs 槽位，link 指向连线表
  assert.deepEqual(ks.inputs.map((i) => i.name), ['model', 'positive', 'negative', 'latent_image']);
  assert.equal(ks.inputs.filter((i) => i.link != null).length, 4);
  const save = ui.nodes.find((n) => n.type === 'SaveImage');
  assert.deepEqual(save.widgets_values, ['cat']);
  assert.deepEqual(save.outputs, []); // 输出节点无输出槽
});

test('连线 target_slot 与 inputs 槽位序号一致，来源输出槽回填 links', () => {
  const ui = apiToUi(SD_T2I, schemas);
  const ks = ui.nodes.find((n) => n.type === 'KSampler');
  ks.inputs.forEach((slot, idx) => {
    const link = ui.links.find((l) => l[0] === slot.link);
    assert.equal(link[4], idx, `${slot.name} 的 target_slot 应等于槽位下标`);
    assert.equal(link[3], ks.id, 'target_id 应是 KSampler');
    const src = ui.nodes.find((n) => n.id === link[1]);
    assert.ok(src.outputs[link[2]].links.includes(link[0]), '来源输出槽应回填 link id');
  });
  const ckpt = ui.nodes.find((n) => n.type === 'CheckpointLoaderSimple');
  assert.equal(ckpt.outputs.length, 3); // MODEL/CLIP/VAE 三槽
  assert.deepEqual(ckpt.outputs.map((o) => o.type), ['MODEL', 'CLIP', 'VAE']);
  const vaedecode = ui.nodes.find((n) => n.type === 'VAEDecode');
  assert.equal(vaedecode.id, 6); // listApiNodes 数值序重编号 1..N
});

test('convertUiToApi(apiToUi(wf)) 往返还原（id 重编号后连线与取值一致）', () => {
  const ui = apiToUi(SD_T2I, schemas);
  const { workflow, warnings } = convertUiToApi(JSON.parse(JSON.stringify(ui)), schemas);
  assert.deepEqual(warnings, []);
  // listApiNodes 数值序：3→1, 4→2, 5→3, 6→4, 7→5, 8→6, 9→7
  assert.equal(workflow['7'].class_type, 'SaveImage');
  assert.deepEqual(workflow['7'].inputs.images, ['6', 0]);
  assert.deepEqual(workflow['6'].inputs.samples, ['1', 0]);
  assert.deepEqual(workflow['6'].inputs.vae, ['2', 2]);
  assert.equal(workflow['4'].inputs.text, '一只猫');
  assert.deepEqual(workflow['4'].inputs.clip, ['2', 1]);
  assert.equal(workflow['1'].inputs.seed, 42);
  assert.equal(workflow['1'].inputs.sampler_name, 'euler');
  assert.equal(workflow['7'].inputs.filename_prefix, 'cat');
});

test('被连线占用的控件照占 widgets 槽位（缺值补 schema 默认）', () => {
  const wf = {
    '13': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model_a.safetensors' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: ['13', 0] } }, // width 被连线、height/batch_size 缺值
  };
  const ui = apiToUi(wf, schemas);
  const empty = ui.nodes.find((n) => n.type === 'EmptyLatentImage');
  // 三个控件槽都在：width 占位默认 512、height 缺值默认 512、batch_size 缺值默认 1
  assert.deepEqual(empty.widgets_values, [512, 512, 1]);
  assert.deepEqual(empty.inputs.map((i) => i.name), ['width']);
  // 数值序：5→1, 13→2
  const { workflow } = convertUiToApi(JSON.parse(JSON.stringify(ui)), schemas);
  assert.deepEqual(workflow['1'].inputs.width, ['2', 0]);
  assert.equal(workflow['1'].inputs.batch_size, 1);
});

test('autogrow 点号子键成为连线槽位', () => {
  const qwenSchemas = {
    ...schemas,
    TextEncodeQwenImage21: {
      input: {
        required: {
          clip: ['CLIP'],
          images: ['COMFY_AUTOGROW_V3', { template: { names: ['image_1', 'image_2'], input: { required: { image: ['IMAGE'] } } } }],
          vae: ['VAE'],
          prompt: ['STRING', { multiline: true, default: '' }],
          resolution: ['INT', { default: 1024 }],
        },
      },
      output: ['CONDITIONING', 'CONDITIONING', 'LATENT'],
      output_name: ['positive', 'negative', 'latent'],
    },
  };
  const wf = {
    '470': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model_a.safetensors' } },
    '459_474': {
      class_type: 'TextEncodeQwenImage21',
      inputs: { clip: ['470', 1], 'images.image_1': ['470', 0], vae: ['470', 2], prompt: 'hi', resolution: 1024 },
    },
  };
  const ui = apiToUi(wf, qwenSchemas);
  const enc = ui.nodes.find((n) => n.type === 'TextEncodeQwenImage21');
  assert.deepEqual(enc.widgets_values, ['hi', 1024]);
  const dot = enc.inputs.find((i) => i.name === 'images.image_1');
  assert.equal(dot.type, 'IMAGE');
  assert.ok(dot.link != null);
  // 字符串子图 id 排在数字 id 前：459_474→1, 470→2
  const { workflow } = convertUiToApi(JSON.parse(JSON.stringify(ui)), qwenSchemas);
  assert.deepEqual(workflow['1'].inputs['images.image_1'], ['2', 0]);
  assert.deepEqual(workflow['1'].inputs.clip, ['2', 1]);
  assert.equal(workflow['1'].inputs.prompt, 'hi');
});

test('DYNAMICCOMBO 选中项子输入紧随其后占槽（SaveImageAdvanced 形态）', () => {
  const advSchemas = {
    ...schemas,
    SaveImageAdvanced: {
      input: {
        required: {
          images: ['IMAGE'],
          filename_prefix: ['STRING', { default: 'ComfyUI' }],
          format: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'png', inputs: { required: { bit_depth: [['8-bit', '16-bit']] } } }] }],
        },
      },
    },
  };
  const wf = {
    '8': { class_type: 'VAEDecode', inputs: { samples: ['1', 0], vae: ['1', 0] } },
    '461': {
      class_type: 'SaveImageAdvanced',
      inputs: { images: ['8', 0], filename_prefix: 'x', format: 'png', 'format.bit_depth': '8-bit' },
    },
  };
  const ui = apiToUi(wf, advSchemas);
  const save = ui.nodes.find((n) => n.type === 'SaveImageAdvanced');
  assert.deepEqual(save.widgets_values, ['x', 'png', '8-bit']);
  const { workflow } = convertUiToApi(JSON.parse(JSON.stringify(ui)), advSchemas);
  assert.equal(workflow['2'].inputs.format, 'png');
  assert.equal(workflow['2'].inputs['format.bit_depth'], '8-bit');
});

test('缺 schema 的节点降级：数组值当连线、字面量当控件', () => {
  const wf = {
    '1': { class_type: 'TotallyUnknownNode', inputs: { model: ['2', 0], count: 3, name: 'a' } },
    '2': { class_type: 'AlsoUnknown', inputs: { x: 1 } },
  };
  const ui = apiToUi(wf, schemas);
  const n1 = ui.nodes.find((n) => n.type === 'TotallyUnknownNode');
  assert.deepEqual(n1.widgets_values, [3, 'a']);
  assert.deepEqual(n1.inputs.map((i) => i.name), ['model']);
  assert.equal(n1.inputs[0].type, '*');
  // 被消费但无 schema 声明的输出槽自动补齐，类型取 '*'
  const n2 = ui.nodes.find((n) => n.type === 'AlsoUnknown');
  assert.equal(n2.outputs.length, 1);
  assert.equal(n2.outputs[0].type, '*');
  assert.equal(listApiNodes(wf).length, 2);
});

test('apiToUi 还原 _meta 侧信道的 pos/size（桌面布局不乱）', () => {
  const wf = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model_a.safetensors' }, _meta: { title: '加载', _cm_pos: [123.5, 456.2], _cm_size: [315, 106] } },
  };
  const ui = apiToUi(wf, schemas);
  const n1 = ui.nodes.find((n) => n.type === 'CheckpointLoaderSimple');
  assert.deepEqual(n1.pos, [123.5, 456.2]);
  assert.deepEqual(n1.size, [315, 106]);
  assert.equal(n1.title, '加载');
});

test('apiToUi 无侧信道时仍按拓扑自动布局', () => {
  const ui = apiToUi(SD_T2I, schemas);
  for (const n of ui.nodes) {
    assert.ok(Number.isFinite(n.pos[0]) && Number.isFinite(n.pos[1]), '自动布局坐标合法');
  }
});

test('convertUiToApi → apiToUi 往返保留原布局 pos/size', () => {
  const uiIn = {
    last_node_id: 2,
    nodes: [
      { id: 1, type: 'CheckpointLoaderSimple', mode: 0, pos: [88, 66], size: [300, 100], inputs: [], widgets_values: ['model_b.safetensors'] },
      { id: 2, type: 'CLIPTextEncode', mode: 0, pos: [500, 66], size: [300, 120], inputs: [{ name: 'clip', link: 1 }], widgets_values: ['你好'] },
    ],
    links: [[1, 1, 1, 2, 1, 'CLIP']],
  };
  const { workflow } = convertUiToApi(uiIn, createMockSchemas());
  const uiOut = apiToUi(workflow, createMockSchemas());
  const ckpt = uiOut.nodes.find((n) => n.type === 'CheckpointLoaderSimple');
  assert.deepEqual(ckpt.pos, [88, 66]);
  assert.deepEqual(ckpt.size, [300, 100]);
  const enc = uiOut.nodes.find((n) => n.type === 'CLIPTextEncode');
  assert.deepEqual(enc.pos, [500, 66]);
  assert.deepEqual(enc.size, [300, 120]);
});
