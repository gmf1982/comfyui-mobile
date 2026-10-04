/** workflow-form.js 单元测试：格式识别、表单推导、值写回、媒体提取、UI 格式转换。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFormat, listApiNodes, buildFormModel, applyFormModel, extractMediaFromOutputs,
  convertUiToApi, starterWorkflow, schemaInputs, heroLayoutRows, buildRunLayout,
} from '../../web/js/lib/workflow-form.js';
import { createMockSchemas } from './helpers/schemas.js';

// 经典 SD 文生图工作流（API 格式）
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

test('detectFormat 识别 api/ui/unknown', () => {
  assert.equal(detectFormat(SD_T2I), 'api');
  assert.equal(detectFormat({ nodes: [{ id: 1, type: 'KSampler' }], links: [] }), 'ui');
  assert.equal(detectFormat({ foo: 1 }), 'unknown');
  assert.equal(detectFormat(null), 'unknown');
  assert.equal(detectFormat([]), 'unknown');
});

test('listApiNodes 按 id 数值排序', () => {
  const nodes = listApiNodes(SD_T2I);
  assert.deepEqual(nodes.map((n) => n.id), ['3', '4', '5', '6', '7', '8', '9']);
  assert.equal(nodes[0].class_type, 'KSampler');
});

test('buildFormModel 提取经典工作流主参数', () => {
  const model = buildFormModel({ workflow: SD_T2I, schemas: createMockSchemas() });
  const byKey = Object.fromEntries(model.heroes.map((f) => [f.key, f]));

  assert.equal(byKey['6:text'].role, 'positive');
  assert.equal(byKey['6:text'].value, '一只猫');
  assert.equal(byKey['7:text'].role, 'negative');
  assert.equal(byKey['5:width'].value, 768);
  assert.equal(byKey['5:height'].value, 1024);
  assert.equal(byKey['5:batch_size'].value, 2);
  assert.equal(byKey['3:seed'].value, 42);
  assert.equal(byKey['3:steps'].value, 25);
  assert.equal(byKey['3:cfg'].value, 7.5);
  assert.equal(byKey['3:sampler_name'].value, 'euler');
  assert.equal(byKey['3:scheduler'].value, 'karras');
  assert.equal(byKey['3:denoise'].value, 1);
  assert.ok(byKey['4:ckpt_name'], '模型字段应存在');
  assert.deepEqual(byKey['4:ckpt_name'].folders, ['checkpoints']);
  assert.ok(model.heroes.indexOf(byKey['6:text'])
    < model.heroes.indexOf(byKey['3:seed']), '正向提示词应排在种子前');
  assert.equal(byKey['5:width'].role, 'resolution');

  // 高级参数：未上主参数的 widget 应出现在对应节点组
  const groupsById = Object.fromEntries(model.groups.map((g) => [g.nodeId, g]));
  const saveGroup = groupsById['9'];
  assert.ok(saveGroup, 'SaveImage 应有高级参数组');
  assert.ok(saveGroup.fields.some((f) => f.inputName === 'filename_prefix' && f.value === 'cat'));
  // 主参数字段不应重复出现在高级组
  for (const group of model.groups) {
    for (const f of group.fields) {
      assert.ok(!model.heroes.some((h) => h.nodeId === f.nodeId && h.inputName === f.inputName),
        `${group.nodeId}:${f.inputName} 不应与主参数重复`);
    }
  }
});

test('buildFormModel 对 KSamplerAdvanced 使用 noise_seed', () => {
  const wf = {
    '1': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '2': {
      class_type: 'KSamplerAdvanced',
      inputs: {
        add_noise: 'enable', noise_seed: 7, steps: 20, cfg: 7, sampler_name: 'ddim', scheduler: 'normal',
        start_at_step: 0, end_at_step: 20, return_with_leftover_noise: 'disable',
        model: ['x', 0], positive: ['p', 0], negative: ['n', 0], latent_image: ['1', 0],
      },
    },
  };
  const model = buildFormModel({ workflow: wf, schemas: createMockSchemas() });
  const seed = model.heroes.find((f) => f.role === 'seed');
  assert.ok(seed, 'noise_seed 应提取为种子主参数');
  assert.equal(seed.inputName, 'noise_seed');
  assert.equal(seed.value, 7);
});

test('buildFormModel 无 schema 时按值类型推断且不崩溃', () => {
  const model = buildFormModel({ workflow: SD_T2I, schemas: {} });
  assert.ok(model.ok);
  assert.equal(model.heroes.find((f) => f.role === 'seed').value, 42);
});

test('applyFormModel 写回并做数值化', () => {
  const wf = JSON.parse(JSON.stringify(SD_T2I));
  const model = buildFormModel({ workflow: wf, schemas: createMockSchemas() });
  applyFormModel(wf, model.fields, {
    '6:text': '一只狗',
    '3:seed': '999',
    '5:width': 512,
    '3:sampler_name': 'ddim',
  });
  assert.equal(wf['6'].inputs.text, '一只狗');
  assert.equal(wf['3'].inputs.seed, 999, '字符串数字应转为数值');
  assert.equal(wf['5'].inputs.width, 512);
  assert.equal(wf['3'].inputs.sampler_name, 'ddim');
  assert.equal(wf['7'].inputs.text, '模糊', '未提供的字段不受影响');
});

test('extractMediaFromOutputs 提取图片/视频/音频并跳过未知类型', () => {
  const outputs = {
    '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
    '10': { gifs: [{ filename: 'v.mp4', subfolder: 'VHS', type: 'output' }] },
    '11': { audio: [{ filename: 's.mp3', subfolder: '', type: 'output' }] },
    '12': { images: [{ filename: 'log.txt', subfolder: '', type: 'output' }] },
  };
  const items = extractMediaFromOutputs(outputs);
  assert.deepEqual(items.map((i) => i.mediaType), ['image', 'video', 'audio']);
  assert.equal(items[1].subfolder, 'VHS');
});

test('extractMediaFromOutputs version 选项附加运行序号（URL 缓存版本用）', () => {
  const outputs = { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } };
  const withV = extractMediaFromOutputs(outputs, { version: 392 });
  assert.equal(withV[0].version, 392);
  // 未传时不带 version 字段（URL 不加 v 参数，保持旧行为）
  const withoutV = extractMediaFromOutputs(outputs);
  assert.equal('version' in withoutV[0], false);
});

test('convertUiToApi 尽力转换 UI 格式', () => {
  const ui = {
    last_node_id: 3,
    nodes: [
      { id: 1, type: 'CheckpointLoaderSimple', mode: 0, inputs: [], widgets_values: ['model_b.safetensors'] },
      { id: 2, type: 'CLIPTextEncode', mode: 0, inputs: [{ name: 'clip', link: 1 }, { name: 'text', widget: { name: 'text' }, link: 2 }], widgets_values: ['你好'] },
      { id: 3, type: 'SaveImage', mode: 4, inputs: [], widgets_values: ['x'] },
    ],
    links: [[1, 1, 1, 2, 1, 'CLIP'], [2, 5, 0, 2, 0, 'STRING']],
  };
  const { workflow, warnings } = convertUiToApi(ui, createMockSchemas());
  assert.equal(workflow['1'].class_type, 'CheckpointLoaderSimple');
  assert.equal(workflow['1'].inputs.ckpt_name, 'model_b.safetensors', 'widget 按 schema 顺序回填');
  assert.deepEqual(workflow['2'].inputs.clip, ['1', 1], '连线输入映射到源节点');
  assert.deepEqual(workflow['2'].inputs.text, ['5', 0], '被转换成连线的 widget 以连线为准');
  assert.equal(workflow['3'], undefined, '旁路节点跳过');
});

test('convertUiToApi 旁路节点按同类型穿通改写', () => {
  const ui = {
    nodes: [
      { id: 1, type: 'CheckpointLoaderSimple', mode: 0, inputs: [], widgets_values: ['model_b.safetensors'] },
      {
        id: 2, type: 'LoraLoader', mode: 4,
        inputs: [{ name: 'model', link: 1 }, { name: 'clip', link: 2 }],
        widgets_values: ['mock_lora.safetensors', 1.0, 1.0],
      },
      { id: 3, type: 'KSampler', mode: 0, inputs: [{ name: 'model', link: 3 }], widgets_values: [1, 'fixed', 20, 7, 'euler', 'normal', 1] },
    ],
    links: [
      [1, 1, 0, 2, 0, 'MODEL'],
      [2, 1, 1, 2, 1, 'CLIP'],
      [3, 2, 0, 3, 0, 'MODEL'],
    ],
  };
  const { workflow, warnings } = convertUiToApi(ui, createMockSchemas());
  assert.equal(workflow['2'], undefined, '旁路节点不进入结果');
  assert.deepEqual(workflow['3'].inputs.model, ['1', 0], '消费方应改写为旁路节点同类型输入的来源');
  assert.ok(warnings.some((w) => w.includes('旁路')), '应有旁路提示');
});

test('convertUiToApi 消耗 seed 的 control_after_generate 槽位', () => {
  const ui = {
    nodes: [
      {
        id: 3, type: 'KSampler', mode: 0,
        inputs: [
          { name: 'model', link: 1 }, { name: 'positive', link: 2 }, { name: 'negative', link: 3 }, { name: 'latent_image', link: 4 },
        ],
        widgets_values: [999, 'randomize', 20, 7, 'euler', 'normal', 1],
      },
    ],
    links: [[1, '1', 0, 3, 0, 'MODEL'], [2, '2', 0, 3, 1, 'CONDITIONING'], [3, '3', 0, 3, 2, 'CONDITIONING'], [4, '4', 0, 3, 3, 'LATENT']],
  };
  const { workflow } = convertUiToApi(ui, createMockSchemas());
  const ks = workflow['3'].inputs;
  assert.equal(ks.seed, 999);
  assert.equal(ks.steps, 20, 'control_after_generate 槽位应被跳过');
  assert.equal(ks.cfg, 7);
  assert.equal(ks.sampler_name, 'euler');
  assert.equal(ks.scheduler, 'normal');
  assert.equal(ks.denoise, 1);
});

test('convertUiToApi 展平子图并改写输出连线', () => {
  const ui = {
    nodes: [
      {
        id: 57, type: 'sg-1', mode: 0,
        inputs: [
          { name: 'text', type: 'STRING', widget: { name: 'text' }, link: null },
          { name: 'width', type: 'INT', widget: { name: 'width' }, link: 9 },
          { name: 'height', type: 'INT', widget: { name: 'height' }, link: null },
          { name: 'seed', type: 'INT', widget: { name: 'seed' }, link: null },
        ],
        widgets_values: ['一只猫', 512, 768, 12345],
      },
      { id: 9, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', link: 2 }], widgets_values: ['out'] },
    ],
    links: [
      [9, 62, 0, 57, 1, 'INT'],
      [2, 57, 0, 9, 0, 'IMAGE'],
    ],
    definitions: {
      subgraphs: [{
        id: 'sg-1', name: 'T2I',
        nodes: [
          { id: 27, type: 'CLIPTextEncode', mode: 0, inputs: [{ name: 'clip', link: 28 }, { name: 'text', widget: { name: 'text' }, link: 34 }], widgets_values: ['内部默认'] },
          { id: 28, type: 'CheckpointLoaderSimple', mode: 0, inputs: [], widgets_values: ['m.safetensors'] },
          {
            id: 3, type: 'KSampler', mode: 0,
            inputs: [
              { name: 'model', link: 21 }, { name: 'positive', link: 30 }, { name: 'negative', link: 33 }, { name: 'latent_image', link: 25 }, { name: 'seed', widget: { name: 'seed' }, link: 71 },
            ],
            widgets_values: [999, 'randomize', 20, 7, 'euler', 'normal', 1],
          },
          { id: 13, type: 'EmptySD3LatentImage', mode: 0, inputs: [{ name: 'width', link: 101 }, { name: 'height', link: 102 }], widgets_values: [1024] },
          { id: 8, type: 'VAEDecode', mode: 0, inputs: [{ name: 'samples', link: 31 }, { name: 'vae', link: 27 }], widgets_values: [] },
        ],
        inputs: [
          { name: 'text', linkIds: [34] }, { name: 'width', linkIds: [101] },
          { name: 'height', linkIds: [102] }, { name: 'seed', linkIds: [71] },
        ],
        outputs: [{ name: 'IMAGE', type: 'IMAGE' }],
        links: [
          { id: 34, origin_id: -10, origin_slot: 0, target_id: 27, target_slot: 1, type: 'STRING' },
          { id: 101, origin_id: -10, origin_slot: 1, target_id: 13, target_slot: 0, type: 'INT' },
          { id: 102, origin_id: -10, origin_slot: 2, target_id: 13, target_slot: 1, type: 'INT' },
          { id: 71, origin_id: -10, origin_slot: 3, target_id: 3, target_slot: 4, type: 'INT' },
          { id: 28, origin_id: 28, origin_slot: 1, target_id: 27, target_slot: 0, type: 'CLIP' },
          { id: 21, origin_id: 28, origin_slot: 0, target_id: 3, target_slot: 0, type: 'MODEL' },
          { id: 30, origin_id: 27, origin_slot: 0, target_id: 3, target_slot: 1, type: 'CONDITIONING' },
          { id: 33, origin_id: 27, origin_slot: 0, target_id: 3, target_slot: 2, type: 'CONDITIONING' },
          { id: 25, origin_id: 13, origin_slot: 0, target_id: 3, target_slot: 3, type: 'LATENT' },
          { id: 31, origin_id: 3, origin_slot: 0, target_id: 8, target_slot: 0, type: 'LATENT' },
          { id: 27, origin_id: 28, origin_slot: 2, target_id: 8, target_slot: 1, type: 'VAE' },
          { id: 16, origin_id: 8, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' },
        ],
      }],
    },
  };
  const { workflow, warnings } = convertUiToApi(ui, createMockSchemas());
  assert.equal(workflow['57_3'].inputs.seed, 12345, '子图输入应取外层 widget 值');
  assert.deepEqual(workflow['57_13'].inputs.width, ['62', 0], '子图输入应取外层连线源');
  assert.equal(workflow['57_13'].inputs.height, 768, '子图输入应取外层 widget 值');
  assert.equal(workflow['57_27'].inputs.text, '一只猫', '子图输入连线优先于内部默认 widget 值');
  assert.equal(workflow['57_27'].inputs.clip[0], '57_28', '子图内部连线映射到实例 id');
  assert.deepEqual(workflow['9'].inputs.images, ['57_8', 0], '子图输出连线应改写为内部来源');
  assert.equal(workflow['57_3'].inputs.steps, 20, '子图内 seed 槽位对齐');
  assert.equal(workflow['57_28'].inputs.ckpt_name, 'm.safetensors');
  assert.equal(workflow['57'], undefined, '子图外壳节点不应出现在结果中');
  assert.deepEqual(warnings, [], `不应有警告：${JSON.stringify(warnings)}`);
});

test('convertUiToApi 缺 schema 时给出警告且保留连线', () => {
  const ui = {
    nodes: [{ id: 5, type: 'UnknownNode', mode: 0, inputs: [{ name: 'model', link: 3 }], widgets_values: ['ignored'] }],
    links: [[3, 9, 0, 5, 0, 'MODEL']],
  };
  const { workflow, warnings } = convertUiToApi(ui, {});
  assert.deepEqual(workflow['5'].inputs.model, ['9', 0]);
  assert.ok(warnings.some((w) => w.includes('UnknownNode')));
});

test('starterWorkflow 可被表单推导识别', () => {
  const wf = starterWorkflow();
  const model = buildFormModel({ workflow: wf, schemas: createMockSchemas() });
  assert.ok(model.heroes.some((f) => f.role === 'positive'));
  assert.ok(model.heroes.some((f) => f.role === 'negative'));
  assert.ok(model.heroes.some((f) => f.role === 'resolution'));
});

test('schemaInputs 顺序：required 在前、optional 在后', () => {
  const schema = { input: { required: { a: ['INT'] }, optional: { b: ['INT'] } } };
  assert.deepEqual(schemaInputs(schema), [['a', ['INT']], ['b', ['INT']]]);
  assert.deepEqual(schemaInputs(null), []);
});

// ---------------- 主参数行布局（附图 1 统一布局 + 拖拽记忆） ----------------

const LORA_WF = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model_a.safetensors' } },
  '10': { class_type: 'LoraLoader', inputs: { lora_name: 'detail.safetensors', strength_model: 0.8, strength_clip: 0.7, model: ['4', 0], clip: ['4', 1] } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1024, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '一只猫', clip: ['10', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '模糊', clip: ['10', 1] } },
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 42, steps: 25, cfg: 7.5, sampler_name: 'euler', scheduler: 'karras', denoise: 1,
      model: ['10', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
    },
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'cat', images: ['8', 0] } },
};

test('heroLayoutRows 默认顺序与附图一致：成对字段合并为一行', () => {
  const model = buildFormModel({ workflow: SD_T2I, schemas: createMockSchemas() });
  const rows = heroLayoutRows(model.heroes);
  assert.deepEqual(rows.map((r) => r.key), [
    'positive', 'negative', 'resolution', 'steps+cfg', 'seed+denoise', 'sampler+scheduler', 'model', 'batch',
  ]);
  const pair = rows.find((r) => r.key === 'steps+cfg');
  assert.deepEqual(pair.fields.map((f) => f.inputName), ['steps', 'cfg']);
  const seedRow = rows.find((r) => r.key === 'seed+denoise');
  assert.deepEqual(seedRow.fields.map((f) => f.inputName), ['seed', 'denoise']);
});

test('heroLayoutRows LoRA 强度提升为主参数，排在 LoRA 选择之后', () => {
  const model = buildFormModel({ workflow: LORA_WF, schemas: createMockSchemas() });
  const byKey = Object.fromEntries(model.heroes.map((f) => [f.key, f]));
  assert.equal(byKey['10:strength_model'].role, 'lora.strength');
  assert.equal(byKey['10:strength_model'].value, 0.8);
  assert.equal(byKey['10:strength_clip'].role, 'lora.strength');
  const rows = heroLayoutRows(model.heroes);
  const keys = rows.map((r) => r.key);
  assert.ok(keys.indexOf('lora') !== -1 && keys.indexOf('lora.strength') !== -1);
  assert.ok(keys.indexOf('lora') < keys.indexOf('lora.strength'), 'lora 应在 lora.strength 之前');
  // 高级组不再重复出现 LoRA 强度
  const group10 = model.groups.find((g) => g.nodeId === '10');
  assert.ok(!group10?.fields.some((f) => f.inputName === 'strength_model'), '强度不应留在高级组');
});

test('heroLayoutRows 记忆顺序生效，未记忆的新行按默认序追加', () => {
  const model = buildFormModel({ workflow: SD_T2I, schemas: createMockSchemas() });
  const rows = heroLayoutRows(model.heroes, ['model', 'positive', 'steps+cfg']);
  assert.deepEqual(rows.map((r) => r.key), ['model', 'positive', 'steps+cfg', 'negative', 'resolution', 'seed+denoise', 'sampler+scheduler', 'batch']);
  // 模型族旧记忆（model/clip/vae/lora 等键）归一到 model.family
  const zones = buildRunLayout(model.heroes, model.groups, { main: ['clip', 'positive'], advanced: [] });
  const mainKeys = zones.main.map((r) => r.key);
  assert.equal(mainKeys.filter((k) => k === 'model.family').length, 1, '族别名去重');
  assert.deepEqual(mainKeys, ['model.family', 'positive', 'negative', 'resolution', 'steps+cfg', 'seed+denoise', 'sampler+scheduler', 'batch']);
});

test('heroLayoutRows 成对字段只剩其一时保持原角色行', () => {
  const wf = JSON.parse(JSON.stringify(SD_T2I));
  delete wf['3'].inputs.cfg;
  const model = buildFormModel({ workflow: wf, schemas: createMockSchemas() });
  const keys = heroLayoutRows(model.heroes).map((r) => r.key);
  assert.ok(keys.includes('steps'), '单成员应保留原角色行');
  assert.ok(!keys.includes('steps+cfg'), '不成对时不合并');
});

// ---------------- 运行页分区布局（主区/高级区跨区拖动） ----------------

test('buildRunLayout 默认：角色行进主区、节点组进高级区（按 classType 合并）', () => {
  const model = buildFormModel({ workflow: SD_T2I, schemas: createMockSchemas() });
  const zones = buildRunLayout(model.heroes, model.groups, {});
  const mainKeys = zones.main.map((u) => u.key);
  const advKeys = zones.advanced.map((u) => u.key);
  assert.ok(mainKeys.includes('positive') && mainKeys.includes('steps+cfg'));
  assert.ok(advKeys.includes('group:SaveImage'), 'SaveImage 组默认在高级区');
  // 高级区行已按 classType 合并（多实例 count 累加）
  const saveUnit = zones.advanced.find((u) => u.key === 'group:SaveImage');
  assert.equal(saveUnit.count, 1);
  assert.ok(saveUnit.fields.length >= 1);
});

test('buildRunLayout 记忆分区：组可提升到主区、角色行可折叠到高级区', () => {
  const model = buildFormModel({ workflow: SD_T2I, schemas: createMockSchemas() });
  const zones = buildRunLayout(model.heroes, model.groups, {
    main: ['positive', 'group:SaveImage', 'negative'],
    advanced: ['steps+cfg'],
  });
  // 已归类的按记忆顺序在前；未归类的角色行默认追加主区，未归类的组追加高级区
  assert.deepEqual(zones.main.map((u) => u.key),
    ['positive', 'group:SaveImage', 'negative', 'resolution', 'seed+denoise', 'sampler+scheduler', 'model.family', 'batch']);
  // mock schema 下其余节点没有剩余 widget，只有 SaveImage 产生组（且已被提升到主区）
  assert.deepEqual(zones.advanced.map((u) => u.key), ['steps+cfg']);
});

test('buildRunLayout 忽略已不存在的行 key（换工作流不串位）', () => {
  const model = buildFormModel({ workflow: SD_T2I, schemas: createMockSchemas() });
  const zones = buildRunLayout(model.heroes, model.groups, {
    main: ['group:GhostNode', 'positive'],
    advanced: ['gone-role'],
  });
  assert.equal(zones.main[0].key, 'positive');
});

test('buildRunLayout 多实例同名节点合并并计数', () => {
  const wf = JSON.parse(JSON.stringify(SD_T2I));
  wf['99'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'b', images: ['8', 0] } };
  const model = buildFormModel({ workflow: wf, schemas: createMockSchemas() });
  const zones = buildRunLayout(model.heroes, model.groups, {});
  const saveUnit = zones.advanced.find((u) => u.key === 'group:SaveImage');
  assert.equal(saveUnit.count, 2);
  assert.equal(saveUnit.fields.filter((f) => f.inputName === 'filename_prefix').length, 2);
});

test('采样器/调度器选项优先用 schema 的真实 combo 列表', () => {
  const model = buildFormModel({ workflow: SD_T2I, schemas: createMockSchemas() });
  const sampler = model.heroes.find((h) => h.role === 'sampler');
  const scheduler = model.heroes.find((h) => h.role === 'scheduler');
  assert.equal(sampler.classType, 'KSampler');
  assert.ok(sampler.options.includes('dpmpp_2m'), 'schema 列表项应在选项里');
  assert.ok(!sampler.options.includes('uni_pc'), '不再混入硬编码内置表');
  assert.equal(sampler.options[0], String(sampler.value), '当前值排首位');
  assert.ok(!scheduler.options.includes('beta'), '调度器同样取 schema 列表');
});

test('采样器选项缺 schema 时回退内置表', () => {
  const model = buildFormModel({ workflow: SD_T2I, schemas: {} });
  const sampler = model.heroes.find((h) => h.role === 'sampler');
  assert.ok(sampler.options.includes('uni_pc'), '无 schema 用内置 SAMPLERS 兜底');
  assert.equal(sampler.options[0], String(sampler.value), '当前值仍排首位');
});

test('convertUiToApi 保留原 UI 图 pos/size 到 _meta 侧信道', () => {
  const ui = {
    last_node_id: 2,
    nodes: [
      { id: 1, type: 'CheckpointLoaderSimple', mode: 0, pos: [120, 80], size: [280, 90], inputs: [], widgets_values: ['model_b.safetensors'] },
      { id: 2, type: 'CLIPTextEncode', mode: 0, inputs: [{ name: 'clip', link: 1 }], widgets_values: ['你好'] },
    ],
    links: [[1, 1, 1, 2, 1, 'CLIP']],
  };
  const { workflow } = convertUiToApi(ui, createMockSchemas());
  assert.deepEqual(workflow['1']._meta._cm_pos, [120, 80]);
  assert.deepEqual(workflow['1']._meta._cm_size, [280, 90]);
  assert.equal(workflow['1']._meta.title, '');
  assert.equal(workflow['2']._meta._cm_pos, undefined, '无 pos 的节点不写侧信道');
});
