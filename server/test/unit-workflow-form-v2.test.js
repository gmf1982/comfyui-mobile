/** 第二轮迭代的新特性测试：排序、媒体检测、动态组合、对象形 widgets、备注跳过、Reroute。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFormModel, applyFormModel, convertUiToApi, mediaKindOfOptions, detectFormat,
} from '../../web/js/lib/workflow-form.js';
import { createMockSchemas } from './helpers/schemas.js';

test('mediaKindOfOptions 按扩展名判断媒体类型', () => {
  assert.equal(mediaKindOfOptions(['a.png', 'b.jpg', 'c.webp']), 'image');
  assert.equal(mediaKindOfOptions(['a.mp4', 'b.webm']), 'video');
  assert.equal(mediaKindOfOptions(['a.mp3', 'b.wav', 'c.flac']), 'audio');
  assert.equal(mediaKindOfOptions(['model.safetensors', 'other.safetensors']), null);
  assert.equal(mediaKindOfOptions([]), null);
});

test('主参数统一排序：提示词 → 图片 → 分辨率 → 步数 → CFG → 种子…', () => {
  const schemas = createMockSchemas();
  // 给 LoadImage 增加 schema 形态（combo 图片列表）
  schemas.LoadImage = { input: { required: { image: [['in/a.png', 'in/b.png']], upload: ['IMAGEUPLOAD'] } } };
  schemas.ResolutionSelector = { input: { required: { resolution: [['1024x1024', '512x768']] } }, output: ['INT', 'INT'] };
  const wf = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
    '2': { class_type: 'LoadImage', inputs: { image: 'in/a.png' } },
    '3': { class_type: 'ResolutionSelector', inputs: { resolution: '1024x1024' } },
    '4': { class_type: 'EmptySD3LatentImage', inputs: { width: ['3', 0], height: ['3', 1], batch_size: 1 } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: '好天气', clip: ['1', 1] } },
    '6': {
      class_type: 'KSampler',
      inputs: {
        seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
        model: ['1', 0], positive: ['5', 0], negative: ['5', 0], latent_image: ['4', 0],
      },
    },
  };
  const model = buildFormModel({ workflow: wf, schemas });
  const roles = model.heroes.map((f) => f.role);
  const firstPositive = roles.indexOf('positive');
  const firstImage = roles.indexOf('image');
  const firstRes = roles.indexOf('resolution');
  const steps = roles.indexOf('steps');
  const cfg = roles.indexOf('cfg');
  const seed = roles.indexOf('seed');
  assert.ok(firstPositive < firstImage, '提示词在图片前');
  assert.ok(firstImage < firstRes, '图片在分辨率前');
  assert.ok(firstRes < steps, '分辨率在步数前');
  assert.ok(steps < cfg, '步数在 CFG 前');
  assert.ok(cfg < seed, 'CFG 在种子前');
  const imgField = model.heroes.find((f) => f.role === 'image');
  assert.equal(imgField.kind, 'media');
  assert.equal(imgField.mediaKind, 'image');
  assert.equal(imgField.value, 'in/a.png');
  assert.ok(Array.isArray(imgField.options), '媒体字段带现有文件列表');
});

test('分辨率提升：宽高来自连线时提升源节点的 resolution widget', () => {
  const model = buildFormModel({
    workflow: {
      '1': { class_type: 'ResolutionSelector', inputs: { resolution: '832x1216' } },
      '2': { class_type: 'EmptySD3LatentImage', inputs: { width: ['1', 0], height: ['1', 1] } },
      '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['x', 0], positive: ['p', 0], negative: ['n', 0], latent_image: ['2', 0] } },
    },
    schemas: {
      ...createMockSchemas(),
      ResolutionSelector: { input: { required: { resolution: [['1024x1024', '832x1216']] } }, output: ['INT', 'INT'] },
    },
  });
  const res = model.heroes.find((f) => f.role === 'resolution');
  assert.ok(res, '应提升分辨率主参数');
  assert.equal(res.nodeId, '1');
  assert.equal(res.value, '832x1216');
  // 不应再有空值宽高主参数
  assert.ok(!model.heroes.some((f) => f.inputName === 'width' && f.value == null));
});

test('convertUiToApi 支持 COMFY_DYNAMICCOMBO_V3（点号键名占槽）', () => {
  const ui = {
    nodes: [
      {
        id: 1, type: 'BlockSparse', mode: 0,
        inputs: [
          { name: 'model', type: 'MODEL', link: 1 },
          { name: 'selection', type: 'COMFY_DYNAMICCOMBO_V3', widget: { name: 'selection' }, link: null },
          { name: 'selection.keep_percent', type: 'FLOAT', widget: { name: 'selection.keep_percent' }, link: null },
          { name: 'start_percent', type: 'FLOAT', widget: { name: 'start_percent' }, link: null },
        ],
        widgets_values: ['sla', 10, 0.2],
      },
    ],
    links: [[1, 9, 0, 1, 0, 'MODEL']],
  };
  const schemas = {
    BlockSparse: {
      input: {
        required: {
          model: ['MODEL'],
          selection: ['COMFY_DYNAMICCOMBO_V3', { tooltip: 'method' }],
          start_percent: ['FLOAT', { default: 0 }],
        },
      },
      output: ['MODEL'],
    },
  };
  const { workflow } = convertUiToApi(ui, schemas);
  const inputs = workflow['1'].inputs;
  assert.equal(inputs.selection, 'sla');
  assert.equal(inputs['selection.keep_percent'], 10, '动态子 widget 用点号键名');
  assert.equal(inputs.start_percent, 0.2);
  assert.deepEqual(inputs.model, ['9', 0]);
});

test('convertUiToApi 支持对象形 widgets_values（VHS）', () => {
  const ui = {
    nodes: [
      {
        id: 5, type: 'VHS_LoadVideoFFmpeg', mode: 0, inputs: [],
        widgets_values: { video: 'a.mp4', frame_load_cap: 22, videopreview: { hidden: false } },
      },
    ],
    links: [],
  };
  const schemas = {
    VHS_LoadVideoFFmpeg: {
      input: {
        required: { video: [['a.mp4', 'b.mp4']] },
        optional: { frame_load_cap: ['INT', { default: 0 }] },
      },
    },
  };
  const { workflow } = convertUiToApi(ui, schemas);
  assert.equal(workflow['5'].inputs.video, 'a.mp4');
  assert.equal(workflow['5'].inputs.frame_load_cap, 22);
  assert.equal(workflow['5'].inputs.videopreview, undefined, '非 schema 键跳过');
});

test('convertUiToApi 跳过备注节点、Reroute 穿通、PrimitiveNode 取值', () => {
  const ui = {
    nodes: [
      { id: 1, type: 'MarkdownNote', mode: 0, inputs: [], widgets_values: ['说明文字'] },
      { id: 2, type: 'PrimitiveNode', mode: 0, inputs: [], widgets_values: [42] },
      { id: 3, type: 'Reroute', mode: 0, inputs: [{ name: '', type: 'INT', link: 1 }], widgets_values: [] },
      { id: 4, type: 'SomeSink', mode: 0, inputs: [{ name: 'value', link: 2 }], widgets_values: [] },
    ],
    links: [[1, 2, 0, 3, 0, 'INT'], [2, 3, 0, 4, 0, 'INT']],
  };
  const { workflow, warnings } = convertUiToApi(ui, { SomeSink: { input: { required: { value: ['INT'] } } } });
  assert.equal(workflow['1'], undefined, '备注节点丢弃');
  assert.equal(workflow['2'], undefined, 'PrimitiveNode 转为字面值');
  assert.equal(workflow['3'], undefined, 'Reroute 穿通');
  assert.equal(workflow['4'].inputs.value, 42, 'Reroute 链最终取 Primitive 值');
  assert.ok(warnings.length === 0, `不应有警告：${JSON.stringify(warnings)}`);
});

test('applyFormModel 兼容媒体字段写回', () => {
  const wf = { '2': { class_type: 'LoadImage', inputs: { image: 'old.png' } } };
  applyFormModel(wf, [{ key: '2:image', nodeId: '2', inputName: 'image', kind: 'media' }], { '2:image': '手机照片.png' });
  assert.equal(wf['2'].inputs.image, '手机照片.png');
});

test('detectFormat 不受备注节点干扰', () => {
  assert.equal(detectFormat({ nodes: [{ id: 1, type: 'Note' }], links: [] }), 'ui');
});
