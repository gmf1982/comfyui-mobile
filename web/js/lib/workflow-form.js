/**
 * 表单模式推导器：从 API 格式工作流 + object_info schema 推导手机友好的参数表单。
 * 纯逻辑模块，无 DOM 依赖，可在 Node 中直接单元测试。
 */
import { extType } from './media.js';

export const SAMPLER_CLASSES = ['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced'];

export const SAMPLERS = [
  'euler', 'euler_ancestral', 'heun', 'heunpp2', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpm_fast',
  'dpm_adaptive', 'dpmpp_2s_ancestral', 'dpmpp_sde', 'dpmpp_sde_gpu', 'dpmpp_2m', 'dpmpp_2m_sde',
  'dpmpp_2m_sde_gpu', 'dpmpp_3m_sde', 'dpmpp_3m_sde_gpu', 'ddpm', 'lcm', 'ddim', 'uni_pc', 'uni_pc_bh2',
];

export const SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta', 'linear_quadratic', 'kl_optimal'];

/** widget 名 → 可选的模型目录（按序取第一个在 /models/{folder} 命中的）。 */
export const MODEL_WIDGET_FOLDERS = {
  ckpt_name: ['checkpoints'],
  unet_name: ['diffusion_models', 'unet'],
  model_name: ['diffusion_models', 'unet'],
  lora_name: ['loras'],
  vae_name: ['vae'],
  clip_name: ['text_encoders', 'clip'],
  clip_name2: ['text_encoders', 'clip'],
  clip_name3: ['text_encoders', 'clip'],
  clip_name4: ['text_encoders', 'clip'],
  control_net_name: ['controlnet'],
  style_model_name: ['style_models'],
  upscale_model_name: ['upscale_models'],
  hypernetwork_name: ['hypernetworks'],
  photomaker_name: ['photomaker'],
};

const MODEL_LABELS = {
  ckpt_name: '大模型', unet_name: '扩散模型', model_name: '扩散模型', lora_name: 'LoRA',
  vae_name: 'VAE', clip_name: '文本编码器', clip_name2: '文本编码器 2', clip_name3: '文本编码器 3',
  clip_name4: '文本编码器 4', control_net_name: 'ControlNet', style_model_name: '风格模型',
  upscale_model_name: '放大模型', hypernetwork_name: '超网络', photomaker_name: 'PhotoMaker',
};

/** 主参数统一排序（附图 1 布局）：正/负提示词 → 图片 → 比例分辨率 → 步数|CFG → 种子|去噪 → 采样器|调度器 → 模型族。 */
export const ROLE_RANKS = {
  positive: 0,
  negative: 1,
  image: 2,
  resolution: 3,
  steps: 4,
  cfg: 5,
  seed: 6,
  denoise: 7,
  sampler: 8,
  scheduler: 9,
  model: 10,
  'lora.strength': 11,
  batch: 12,
  other: 20,
};
/** 模型类主参数内部排序：主模型 → 文本编码器 → VAE → ControlNet/放大 → LoRA → LoRA 强度 */
const MODEL_FOLDER_RANKS = [
  ['checkpoints', 'diffusion_models', 'unet'],
  ['text_encoders', 'clip'],
  ['vae'],
  ['controlnet', 'upscale_models'],
  ['loras'],
];

/** 模型类主参数归入哪一行（与 MODEL_FOLDER_RANKS 对应，供行布局使用）。 */
export function modelRowKeyOf(field) {
  const folders = field.folders ?? [];
  if (folders.some((f) => ['checkpoints', 'diffusion_models', 'unet'].includes(f))) return 'model';
  if (folders.some((f) => ['text_encoders', 'clip'].includes(f))) return 'clip';
  if (folders.some((f) => ['vae'].includes(f))) return 'vae';
  if (folders.some((f) => ['controlnet', 'upscale_models'].includes(f))) return 'controlnet';
  if (folders.some((f) => ['loras'].includes(f))) return 'lora';
  return 'model';
}

/** 常见节点类的直观中文名（高级参数分组标题等）。 */
const CLASS_NAMES_ZH = {
  KSampler: '采样器', KSamplerAdvanced: '采样器（高级）', SamplerCustom: '自定义采样',
  SamplerCustomAdvanced: '自定义采样（高级）', KSamplerSelect: '采样器选择', SchedulerSelector: '调度器选择',
  CheckpointLoaderSimple: '大模型', UNETLoader: '扩散模型', CLIPLoader: '文本编码器', CLIPLoader: '文本编码器',
  DualCLIPLoader: '双文本编码器', QuadrupleCLIPLoader: '四重文本编码器', VAELoader: 'VAE',
  LoraLoader: 'LoRA', LoraLoaderModelOnly: 'LoRA（仅模型）', CLIPTextEncode: '提示词编码',
  CLIPSetLastLayer: 'CLIP 层数', EmptyLatentImage: '空白潜在', EmptySD3LatentImage: '空白潜在（SD3）',
  EmptyHunyuanLatentVideo: '空白视频潜在', EmptyMochiLatentVideo: '空白视频潜在（Mochi）',
  VAEDecode: 'VAE 解码', VAEEncode: 'VAE 编码', VAEDecodeTiled: 'VAE 解码（分块）',
  SaveImage: '保存图像', PreviewImage: '预览图像', LoadImage: '加载图片', LoadImageMask: '加载图片（蒙版）',
  LoadImageOutput: '加载图片（输出目录）', ImageScale: '图像缩放', ImageScaleBy: '图像缩放（比例）',
  LatentUpscaleBy: '潜在放大', LatentUpscale: '潜在放大', UpscaleModelLoader: '放大模型',
  ImageUpscaleWithModel: '模型放大', SaveAudio: '保存音频', SaveAudioMP3: '保存音频（MP3）',
  SaveAudioOpus: '保存音频（Opus）', SaveAudioFlac: '保存音频（FLAC）', LoadAudio: '加载音频',
  VHS_VideoCombine: '合成视频', VHS_LoadVideo: '加载视频', VHS_LoadImagesPath: '加载图片序列',
  RandomNoise: '随机噪声', FluxGuidance: '引导强度', ModelSamplingAuraFlow: '模型采样设置',
  ModelSamplingFlux: '模型采样设置（Flux）', ConditioningZeroOut: '条件置零', ConditioningCombine: '条件合并',
  ControlNetLoader: 'ControlNet 加载', ControlNetApplyAdvanced: 'ControlNet 应用',
  CLIPVisionLoader: 'CLIP-Vision 加载', CLIPVisionEncode: 'CLIP-Vision 编码', StyleModelLoader: '风格模型',
  PrimitiveNode: '参数', PrimitiveInt: '整数参数', PrimitiveFloat: '小数参数', PrimitiveString: '文本参数',
  PrimitiveStringMultiline: '多行文本', Reroute: '转接', Note: '备注', MarkdownNote: '备注',
  ResolutionSelector: '分辨率选择', ImageResizeKJ: '图像调整', GetImageSize: '读取图像尺寸',
  ImpactWildcardProcessor: '通配符处理', UnetLoaderGGUF: '扩散模型（GGUF）',
};

/** 高级参数分组的重要性排序（数值越小越靠前）。 */
const GROUP_RANKS = [
  { rank: 0, names: ['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced', 'KSamplerSelect', 'SchedulerSelector'] },
  { rank: 1, names: ['CLIPTextEncode', 'TextEncodeQwenImage', 'T5TextEncode', 'CLIPTextEncodeSDXL'] },
  { rank: 2, names: ['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyHunyuanLatentVideo', 'EmptyMochiLatentVideo', 'EmptyLatentVideo', 'ResolutionSelector', 'GetImageSize'] },
  { rank: 3, names: ['CheckpointLoader', 'UNETLoader', 'UnetLoader', 'CLIPLoader', 'DualCLIPLoader', 'QuadrupleCLIPLoader', 'VAELoader'] },
  { rank: 4, names: ['LoraLoader', 'LoraLoaderModelOnly'] },
  { rank: 5, names: ['FluxGuidance', 'ModelSampling', 'RandomNoise', 'ConditioningZeroOut', 'ConditioningCombine', 'CLIPSetLastLayer'] },
  { rank: 6, names: ['Upscale', 'ImageScale', 'LatentUpscale', 'ImageResize', 'SUPIR', 'SeedVR'] },
  { rank: 7, names: ['SaveImage', 'SaveAudio', 'VHS_VideoCombine', 'PreviewImage'] },
];
function groupRankOf(classType) {
  for (const { rank, names } of GROUP_RANKS) {
    if (names.some((n) => classType.startsWith(n))) return rank;
  }
  return 8;
}

/** 转换 UI 格式时直接丢弃的文档类节点。 */
const SKIP_NODE_TYPES = new Set(['Note', 'MarkdownNote']);
/** 无 schema 也能按“输入穿通到输出”处理的节点。 */
const PASS_THROUGH_TYPES = new Set(['Reroute']);
/** 仅存在于前端、转换时应取其 widget 值作为字面量。 */
const FRONTEND_VALUE_TYPES = new Set(['PrimitiveNode']);

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'opus']);

/** combo 选项按扩展名判断媒体类型（供上传控件与主参数提升）。 */
export function mediaKindOfOptions(options) {
  if (!Array.isArray(options) || !options.length) return null;
  const counts = { image: 0, video: 0, audio: 0 };
  for (const opt of options) {
    const ext = String(opt).split('.').pop().toLowerCase();
    if (IMAGE_EXTS.has(ext)) counts.image++;
    else if (VIDEO_EXTS.has(ext)) counts.video++;
    else if (AUDIO_EXTS.has(ext)) counts.audio++;
  }
  const total = options.length;
  for (const [kind, n] of Object.entries(counts)) {
    if (n / total >= 0.5) return kind;
  }
  return null;
}

/** 展示用节点类名：有中文名用中文名，否则保留类名。 */
export function friendlyClassName(classType) {
  return CLASS_NAMES_ZH[classType] ?? classType;
}

/** 展示用节点 id：子图展平后的 75_61 显示为 61。 */
export function shortNodeId(id) {
  const parts = String(id).split('_');
  return parts[parts.length - 1];
}

/** @returns {'api'|'ui'|'unknown'} */
export function detectFormat(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return 'unknown';
  if (Array.isArray(json.nodes) && Array.isArray(json.links)) return 'ui';
  const values = Object.values(json);
  if (values.length > 0 && values.every((v) => v && typeof v === 'object' && typeof v.class_type === 'string')) {
    return 'api';
  }
  return 'unknown';
}

/** 统一的节点列表：API 格式 {id: {class_type, inputs}} → 数组。 */
export function listApiNodes(workflow) {
  if (!workflow || typeof workflow !== 'object') return [];
  return Object.entries(workflow)
    .filter(([, n]) => n && typeof n === 'object' && typeof n.class_type === 'string')
    .map(([id, n]) => ({ id, class_type: n.class_type, inputs: n.inputs ?? {}, title: n._meta?.title ?? '' }))
    .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
}

function isSamplerNode(node) {
  if (SAMPLER_CLASSES.includes(node.class_type)) return true;
  return /sampler/i.test(node.class_type) && node.inputs && ('positive' in node.inputs || 'steps' in node.inputs);
}

/** object_info 条目 → 有序 [[inputName, def]]（required 优先，随后 optional）。 */
export function schemaInputs(schema) {
  if (!schema?.input) return [];
  const out = [];
  for (const group of ['required', 'optional']) {
    for (const [name, def] of Object.entries(schema.input[group] ?? {})) {
      out.push([name, def]);
    }
  }
  return out;
}

export function schemaInputDef(schema, inputName) {
  for (const [name, def] of schemaInputs(schema)) {
    if (name === inputName) return def;
  }
  return null;
}

/** combo 定义 → 选项数组（兼容 [list] / [list, {}] / ['COMBO', {options}] 三种形态）。 */
export function comboOptions(def) {
  if (!Array.isArray(def)) return null;
  const first = def[0];
  if (Array.isArray(first)) return first;
  if (first === 'COMBO' && Array.isArray(def[1]?.options)) return def[1].options;
  return null;
}

function isSeedName(name) {
  return /(^|_)seed$/.test(name) || name === 'noise_seed';
}

function numberOpts(def) {
  const opts = Array.isArray(def) && def[1] && typeof def[1] === 'object' ? def[1] : {};
  const out = {};
  for (const k of ['min', 'max', 'step', 'default']) {
    if (typeof opts[k] === 'number') out[k] = opts[k];
  }
  return out;
}

function inferKind(inputName, value, def) {
  if (isSeedName(inputName)) return 'seed';
  if (MODEL_WIDGET_FOLDERS[inputName]) return 'model';
  if (inputName === 'sampler_name') return 'sampler';
  if (inputName === 'scheduler') return 'scheduler';
  if (comboOptions(def)) return 'combo';
  if (Array.isArray(def) && typeof def[0] === 'string') {
    if (def[0] === 'INT') return 'int';
    if (def[0] === 'FLOAT') return 'float';
    if (def[0] === 'BOOLEAN') return 'toggle';
    if (def[0] === 'STRING') return def[1]?.multiline ? 'textarea' : 'text';
    if (def[0] === 'IMAGE') return 'image-upload';
  }
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'boolean') return 'toggle';
  if (typeof value === 'string') return value.length > 60 || value.includes('\n') ? 'textarea' : 'text';
  return 'other';
}

const FIELD_LABELS = {
  text: '提示词', prompt: '提示词', positive: '正向提示词', negative_prompt: '负向提示词',
  seed: '种子', noise_seed: '种子', steps: '步数', cfg: 'CFG', denoise: '去噪强度',
  sampler_name: '采样器', scheduler: '调度器', width: '宽', height: '高', length: '时长（帧）',
  num_frames: '帧数', frame_rate: '帧率', fps: '帧率', duration: '时长', batch_size: '张数',
  image: '图片', image1: '图片 1', image2: '图片 2', ref_image: '参考图', video: '视频',
  audio: '音频', guidance: '引导强度', guidance_scale: '引导强度', shift: '采样偏移',
  base_shift: '基础偏移', max_shift: '最大偏移', strength: '强度', strength_model: '模型强度',
  strength_clip: '文本强度', upscale_by: '放大倍数', scale_by: '缩放比例', factor: '倍数',
  model: '模型', ckpt_name: '大模型', unet_name: '扩散模型', vae_name: 'VAE', clip_name: '文本编码器',
  clip_name2: '文本编码器 2', clip_name3: '文本编码器 3', clip_name4: '文本编码器 4',
  lora_name: 'LoRA', control_net_name: 'ControlNet', upscale_model_name: '放大模型',
  filename_prefix: '文件名前缀', resolution: '分辨率', aspect_ratio: '比例', mode: '模式',
  device: '设备', attention_mode: '注意力优化', quantization: '量化', interpolation: '插值',
  start_at_step: '起始步', end_at_step: '结束步', add_noise: '加噪', stop_at_clip_layer: 'CLIP 截止层',
  invert_mask: '反转蒙版', crop: '裁剪', interpolation_type: '插值方式', crf: '画质（CRF）',
  format: '格式', pingpong: '循环往复', save_output: '保存到输出', loop_count: '循环次数',
  quality: '音质', temperature: '温度', top_k: 'Top K', top_p: 'Top P', max_shift: '最大偏移',
  perc_threshold: '阈值', frame_load_cap: '最大加载帧数', select_every_nth: '抽帧间隔',
  opt_caption: '字幕', enable_vae_tiling: 'VAE 分块', roi: '作用区域', masks: '蒙版',
};

function fieldLabel(inputName) {
  return FIELD_LABELS[inputName] ?? inputName;
}

const MEDIA_LABELS = { image: '图片', video: '视频', audio: '音频' };

function makeField(node, inputName, value, def, kind, overrides = {}) {
  const field = {
    key: `${node.id}:${inputName}`,
    nodeId: node.id,
    inputName,
    kind,
    label: overrides.label ?? fieldLabel(inputName),
    value,
    def: null,
    classType: node.class_type, // 「刷新列表」按类重拉 object_info 必需
  };
  if (overrides.role) field.role = overrides.role;
  if (kind === 'int' || kind === 'float') Object.assign(field, numberOpts(def));
  if (kind === 'combo') field.options = comboOptions(def) ?? [];
  // 采样器/调度器优先用 object_info 的真实 combo 列表（随 ComfyUI 版本增长），缺 schema 才退回内置表
  if (kind === 'sampler') field.options = dedupePreserve([String(value), ...(comboOptions(def) ?? SAMPLERS)]);
  if (kind === 'scheduler') field.options = dedupePreserve([String(value), ...(comboOptions(def) ?? SCHEDULERS)]);
  if (kind === 'model') {
    field.folders = MODEL_WIDGET_FOLDERS[inputName];
    field.label = overrides.label ?? (MODEL_LABELS[inputName] ?? inputName);
  }
  if (kind === 'toggle' && typeof value === 'number') field.value = value !== 0;
  return field;
}

function dedupePreserve(list) {
  return [...new Set(list.filter((v) => v !== undefined && v !== null && v !== ''))];
}

/**
 * 推导表单模型。
 * @param {object} params
 * @param {object} params.workflow API 格式工作流
 * @param {Record<string, object|null>} params.schemas class_type → object_info 条目
 * @returns {{ok: boolean, heroes: object[], groups: object[], fields: object[]}}
 */
export function buildFormModel({ workflow, schemas = {} }) {
  const nodes = listApiNodes(workflow);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const used = new Set();
  const heroes = [];
  const mediaSeq = { image: 0, video: 0, audio: 0 };

  const linkSource = (nodeId, inputName) => {
    const v = byId.get(nodeId)?.inputs?.[inputName];
    return Array.isArray(v) ? byId.get(String(v[0])) : null;
  };

  const samplers = nodes.filter(isSamplerNode);

  const TEXT_INPUT_NAMES = ['text', 'prompt', 'positive_prompt'];
  const NEG_TEXT_INPUT_NAMES = ['text', 'negative_prompt', 'negative'];
  for (const sampler of samplers) {
    for (const [role, inputName, label, names] of [
      ['positive', 'positive', '正向提示词', TEXT_INPUT_NAMES],
      ['negative', 'negative', '负向提示词', NEG_TEXT_INPUT_NAMES],
    ]) {
      if (heroes.some((h) => h.role === role)) continue;
      const src = linkSource(sampler.id, inputName);
      if (!src) continue;
      const foundName = names.find((n) => typeof src.inputs?.[n] === 'string');
      if (!foundName) continue;
      const text = src.inputs[foundName];
      if (used.has(`${src.id}:${foundName}`)) continue;
      heroes.push({
        key: `${src.id}:${foundName}`, role, nodeId: src.id, inputName: foundName, kind: 'textarea', label, value: text,
      });
      used.add(`${src.id}:${foundName}`);
    }

    if (!heroes.some((h) => h.role === 'resolution')) {
      const latent = linkSource(sampler.id, 'latent_image');
      if (latent) {
        const w = latent.inputs?.width;
        const h = latent.inputs?.height;
        if (typeof w === 'number' && typeof h === 'number') {
          // 宽高是数值：直接作为主参数
          heroes.push({ key: `${latent.id}:width`, role: 'resolution', nodeId: latent.id, inputName: 'width', kind: 'int', label: '宽', value: w, min: 0, max: 16384, step: 8 });
          heroes.push({ key: `${latent.id}:height`, role: 'resolution', nodeId: latent.id, inputName: 'height', kind: 'int', label: '高', value: h, min: 0, max: 16384, step: 8 });
          used.add(`${latent.id}:width`);
          used.add(`${latent.id}:height`);
          if (typeof latent.inputs.batch_size === 'number') {
            heroes.push({ key: `${latent.id}:batch_size`, role: 'batch', nodeId: latent.id, inputName: 'batch_size', kind: 'int', label: '张数', value: latent.inputs.batch_size, min: 1, max: 64, step: 1 });
            used.add(`${latent.id}:batch_size`);
          }
        } else if (Array.isArray(w) && Array.isArray(h) && String(w[0]) === String(h[0])) {
          // 宽高来自同一连线源（如分辨率选择器）：提升源节点的比例 + 分辨率（百万像素）
          const src = byId.get(String(w[0]));
          if (src) {
            let lifted = false;
            for (const [inputName, value] of Object.entries(src.inputs ?? {})) {
              if (typeof value !== 'string' || used.has(`${src.id}:${inputName}`)) continue;
              if (!/aspect|ratio/i.test(inputName)) continue;
              const def = schemaInputDef(schemas[src.class_type], inputName);
              if (!comboOptions(def)) continue;
              heroes.push(makeField(src, inputName, value, def, 'combo', { role: 'resolution', label: '比例' }));
              used.add(`${src.id}:${inputName}`);
              lifted = true;
            }
            for (const [inputName, value] of Object.entries(src.inputs ?? {})) {
              if (typeof value !== 'number' || used.has(`${src.id}:${inputName}`)) continue;
              if (!/mega|pixel/i.test(inputName)) continue;
              heroes.push({ key: `${src.id}:${inputName}`, role: 'resolution', nodeId: src.id, inputName, kind: 'float', label: '分辨率（百万像素）', value, min: 0.1, max: 16, step: 0.05 });
              used.add(`${src.id}:${inputName}`);
              lifted = true;
            }
            if (!lifted) {
              const resName = Object.keys(src.inputs ?? {}).find((k) => /resolution/i.test(k) && typeof src.inputs[k] === 'string');
              if (resName) {
                const def = schemaInputDef(schemas[src.class_type], resName);
                heroes.push(makeField(src, resName, src.inputs[resName], def, 'combo', { role: 'resolution', label: '分辨率' }));
                used.add(`${src.id}:${resName}`);
              } else if (typeof src.inputs?.width === 'number' && typeof src.inputs?.height === 'number') {
                heroes.push({ key: `${src.id}:width`, role: 'resolution', nodeId: src.id, inputName: 'width', kind: 'int', label: '宽', value: src.inputs.width, min: 0, max: 16384, step: 8 });
                heroes.push({ key: `${src.id}:height`, role: 'resolution', nodeId: src.id, inputName: 'height', kind: 'int', label: '高', value: src.inputs.height, min: 0, max: 16384, step: 8 });
                used.add(`${src.id}:width`);
                used.add(`${src.id}:height`);
              }
            }
          }
        }
      }
    }
  }

  // 分辨率选择器兜底：任意名为 resolution 的字符串 combo 且未被使用
  if (!heroes.some((h) => h.role === 'resolution')) {
    for (const node of nodes) {
      const resName = Object.keys(node.inputs ?? {}).find((k) => /^resolution$/i.test(k) && typeof node.inputs[k] === 'string');
      if (!resName || used.has(`${node.id}:${resName}`)) continue;
      const def = schemaInputDef(schemas[node.class_type], resName);
      heroes.push(makeField(node, resName, node.inputs[resName], def, 'combo', { role: 'resolution', label: '分辨率' }));
      used.add(`${node.id}:${resName}`);
      break;
    }
  }

  const firstSampler = samplers[0];
  if (firstSampler) {
    const addHero = (role, inputName, label, kind, extra = {}) => {
      if (!(inputName in firstSampler.inputs) || Array.isArray(firstSampler.inputs[inputName])) return;
      const def = schemaInputDef(schemas[firstSampler.class_type], inputName);
      const hero = { key: `${firstSampler.id}:${inputName}`, role, nodeId: firstSampler.id, inputName, kind, label, value: firstSampler.inputs[inputName], classType: firstSampler.class_type, ...extra };
      // 采样器/调度器主参数必须带完整选项列表（否则下拉只有“当前值”一项）；有 schema 用真实列表
      if (kind === 'sampler') hero.options = dedupePreserve([String(hero.value), ...(comboOptions(def) ?? SAMPLERS)]);
      if (kind === 'scheduler') hero.options = dedupePreserve([String(hero.value), ...(comboOptions(def) ?? SCHEDULERS)]);
      heroes.push(hero);
      used.add(`${firstSampler.id}:${inputName}`);
    };
    const seedName = 'seed' in firstSampler.inputs ? 'seed' : ('noise_seed' in firstSampler.inputs ? 'noise_seed' : null);
    if (seedName) addHero('seed', seedName, '种子', 'seed');
    addHero('steps', 'steps', '步数', 'int', { min: 1, max: 200, step: 1 });
    addHero('cfg', 'cfg', 'CFG', 'float', { min: 0, max: 100, step: 0.1 });
    addHero('sampler', 'sampler_name', '采样器', 'sampler');
    addHero('scheduler', 'scheduler', '调度器', 'scheduler');
    addHero('denoise', 'denoise', '去噪强度', 'float', { min: 0, max: 1, step: 0.01 });
  }

  // 媒体输入（图片/视频/音频）：所有节点上的媒体文件 combo 都提为主参数，支持上传
  for (const node of nodes) {
    for (const [inputName, value] of Object.entries(node.inputs ?? {})) {
      if (typeof value !== 'string' || used.has(`${node.id}:${inputName}`)) continue;
      const def = schemaInputDef(schemas[node.class_type], inputName);
      const options = comboOptions(def) ?? [];
      const kindHint = mediaKindOfOptions(options)
        ?? (/^(LoadImage|LoadImageMask|LoadImageOutput)$/.test(node.class_type) && inputName === 'image' ? 'image' : null);
      if (!kindHint) continue;
      const seq = ++mediaSeq[kindHint];
      const mediaLabel = MEDIA_LABELS[kindHint];
      const nodeTitle = node.title && node.title !== node.class_type ? node.title : '';
      const label = nodeTitle ? `${mediaLabel}（${nodeTitle}）` : (seq === 1 ? mediaLabel : `${mediaLabel} ${seq}`);
      heroes.push({
        key: `${node.id}:${inputName}`, role: 'image', nodeId: node.id, inputName, kind: 'media',
        mediaKind: kindHint, options, label, value, def: null,
        classType: node.class_type, // 选择器「刷新列表」按类拉最新 schema 必需
      });
      used.add(`${node.id}:${inputName}`);
    }
  }

  // 模型选择器：任意节点上的模型 widget 都提为主参数
  for (const node of nodes) {
    for (const inputName of Object.keys(MODEL_WIDGET_FOLDERS)) {
      const value = node.inputs?.[inputName];
      if (typeof value !== 'string') continue;
      if (used.has(`${node.id}:${inputName}`)) continue;
      const def = schemaInputDef(schemas[node.class_type], inputName);
      const field = makeField(node, inputName, value, def, 'model', { role: 'model' });
      heroes.push(field);
      used.add(`${node.id}:${inputName}`);
    }
  }

  // LoRA 强度：LoraLoader 系节点的 strength 输入提为主参数（与 LoRA 选择相邻展示）
  for (const node of nodes) {
    if (!/^LoraLoader/.test(node.class_type)) continue;
    for (const inputName of ['strength_model', 'strength_clip']) {
      const value = node.inputs?.[inputName];
      if (typeof value !== 'number' || used.has(`${node.id}:${inputName}`)) continue;
      heroes.push({
        key: `${node.id}:${inputName}`, role: 'lora.strength', nodeId: node.id, inputName,
        kind: 'float', label: inputName === 'strength_clip' ? 'LoRA 强度（文本）' : 'LoRA 强度',
        value, min: -5, max: 5, step: 0.01,
      });
      used.add(`${node.id}:${inputName}`);
    }
  }

  // 兜底提示词：无正向提示词主参数时取任意 text widget
  if (!heroes.some((h) => h.role === 'positive')) {
    const node = nodes.find((n) => typeof n.inputs?.text === 'string' || typeof n.inputs?.prompt === 'string');
    if (node) {
      const name = typeof node.inputs.text === 'string' ? 'text' : 'prompt';
      heroes.push({ key: `${node.id}:${name}`, role: 'positive', nodeId: node.id, inputName: name, kind: 'textarea', label: '提示词', value: node.inputs[name] });
      used.add(`${node.id}:${name}`);
    }
  }

  // 高级参数：每个节点剩余的 widget 值
  const groups = [];
  for (const node of nodes) {
    const fields = [];
    for (const [inputName, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value)) continue;
      if (used.has(`${node.id}:${inputName}`)) continue;
      const def = schemaInputDef(schemas[node.class_type], inputName);
      const kind = inferKind(inputName, value, def);
      if (kind === 'other') continue;
      fields.push(makeField(node, inputName, value, def, kind));
    }
    if (fields.length) {
      const friendly = friendlyClassName(node.class_type);
      // 子图内部节点的 title 形如“子图名/节点名”，取最后一段；与类名相同时不重复展示
      const rawTitle = String(node.title ?? '').split('/').pop();
      const customTitle = rawTitle && rawTitle !== node.class_type ? rawTitle : '';
      groups.push({
        nodeId: node.id,
        displayId: shortNodeId(node.id),
        title: customTitle || friendly,
        classType: node.class_type,
        fields,
      });
    }
  }

  groups.sort((a, b) => groupRankOf(a.classType) - groupRankOf(b.classType) || (Number(a.nodeId) || 0) - (Number(b.nodeId) || 0));
  heroes.sort((a, b) => heroRank(a) - heroRank(b));
  return { ok: true, heroes, groups, fields: [...heroes, ...groups.flatMap((g) => g.fields)] };
}

function heroRank(field) {
  const role = field.role ?? 'other';
  const base = ROLE_RANKS[role] ?? ROLE_RANKS.other;
  if (role !== 'model') return base;
  // 模型类内部按文件夹重要性细分
  const folders = field.folders ?? [];
  let sub = MODEL_FOLDER_RANKS.length;
  MODEL_FOLDER_RANKS.forEach((group, i) => {
    if (folders.some((f) => group.includes(f)) && sub === MODEL_FOLDER_RANKS.length) sub = i;
  });
  return base + sub * 0.1;
}

/** 默认行布局（与附图 1 一致）：成对字段占一行；行 key 是拖拽排序记忆的单位。 */
export const HERO_ROW_DEFAULT = [
  'positive', 'negative', 'image', 'resolution', 'steps+cfg', 'seed+denoise',
  'sampler+scheduler', 'model', 'clip', 'vae', 'controlnet', 'lora', 'lora.strength', 'batch',
];

/** 成对主参数：两个都在时合并为一行（步数|CFG、种子|去噪、采样器|调度器）。 */
export const HERO_PAIRS = {
  'steps+cfg': ['steps', 'cfg'],
  'seed+denoise': ['seed', 'denoise'],
  'sampler+scheduler': ['sampler', 'scheduler'],
};

/** 角色行的展示标题（折叠进高级参数区时用）。 */
export const ROLE_ROW_TITLES = {
  positive: '正向提示词', negative: '负向提示词', image: '图片输入', resolution: '比例与分辨率',
  'steps+cfg': '步数 / CFG', 'seed+denoise': '种子 / 去噪强度', 'sampler+scheduler': '采样器 / 调度器',
  'model.family': '模型', model: '模型', clip: '文本编码器（CLIP）', vae: 'VAE', controlnet: 'ControlNet / 放大模型',
  lora: 'LoRA', 'lora.strength': 'LoRA 强度', batch: '生成张数',
};

/** 模型族：这些角色行合并为一个默认折叠的「模型」组（可整体拖动）。 */
export const MODEL_FAMILY_KEYS = ['model', 'clip', 'vae', 'controlnet', 'lora'];
export const MODEL_FAMILY_UNIT_KEY = 'model.family';

/** @param {string} key 行 key（角色 key 或 `group:<classType>`） */
export function heroRowTitle(key) {
  if (key.startsWith('group:')) return null;
  return ROLE_ROW_TITLES[key] ?? key;
}

/**
 * 计算运行页的分区布局：主参数区（展开）与高级参数区（折叠）。
 * 两个区的行都可拖动、可跨区移动：main/advanced 各存一份行 key 列表；
 * 没有归类记录的新行按默认归属（角色行 → 主区、节点组 → 高级区）追加。
 * 同 classType 的多个节点组会合并为一个行（key = `group:<classType>`），跨工作流稳定。
 * 模型/CLIP/VAE/ControlNet/LoRA 合并为一个默认折叠的「模型」组（key = model.family）。
 * @param {object[]} heroes buildFormModel().heroes
 * @param {object[]} groups buildFormModel().groups
 * @param {{main?: string[], advanced?: string[]}} [saved] 用户拖拽记忆的两区行序
 * @returns {{main: Array<{key: string, fields: object[], title: string, count?: number, isFamily?: boolean}>, advanced: Array<{key: string, fields: object[], title: string, count?: number, isFamily?: boolean}>}}
 */
export function buildRunLayout(heroes, groups, saved = {}) {
  const mainSaved = Array.isArray(saved.main) ? saved.main : [];
  const advSaved = Array.isArray(saved.advanced) ? saved.advanced : [];

  const roleRows = heroLayoutRows(heroes, []); // canonical 顺序（成对合并）
  // 模型族合并为一个折叠组，占据「模型」原本的 canonical 位置
  const familyRows = roleRows.filter((r) => MODEL_FAMILY_KEYS.includes(r.key));
  const familyUnit = {
    key: MODEL_FAMILY_UNIT_KEY,
    fields: familyRows.flatMap((r) => r.fields),
    title: '模型',
    isFamily: true,
  };
  const otherRows = roleRows.filter((r) => !MODEL_FAMILY_KEYS.includes(r.key));
  const allRoleUnits = [...otherRows];
  allRoleUnits.splice(Math.min(roleRows.indexOf(familyRows[0]), allRoleUnits.length), 0, familyUnit);

  const groupMap = new Map();
  for (const g of groups) {
    const key = `group:${g.classType}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, { key, fields: [], title: g.title, titles: new Set(), count: 0 });
    }
    const unit = groupMap.get(key);
    unit.fields.push(...g.fields);
    unit.titles.add(g.title);
    unit.count += 1;
  }
  // 组标题优先用节点自定义名（节点图里改的名字）：唯一则直接用，多个且全部相同也用；否则类名
  for (const unit of groupMap.values()) {
    if (unit.titles.size === 1) unit.title = [...unit.titles][0];
    else if (unit.count > 1) unit.title = friendlyClassName(unit.key.slice('group:'.length));
  }

  const zones = { main: [], advanced: [] };
  const norm = (k) => (MODEL_FAMILY_KEYS.includes(k) ? MODEL_FAMILY_UNIT_KEY : k);
  const place = (zone, rawKey) => {
    const key = norm(rawKey);
    const unit = key === MODEL_FAMILY_UNIT_KEY
      ? familyUnit
      : [...otherRows, ...groupMap.values()].find((u) => u.key === key);
    if (!unit) return; // 工作流里不存在了（换工作流）：忽略
    if (zones.main.includes(unit) || zones.advanced.includes(unit)) return; // family 别名去重
    zones[zone].push(unit);
  };
  for (const key of mainSaved) place('main', key);
  for (const key of advSaved) place('advanced', key);
  // 没有归类记录的新行：角色行进主区（canonical 序），节点组进高级区（GROUP_RANKS 序）
  for (const unit of allRoleUnits) {
    if (!zones.main.includes(unit) && !zones.advanced.includes(unit)) zones.main.push(unit);
  }
  for (const unit of groupMap.values()) {
    if (!zones.main.includes(unit) && !zones.advanced.includes(unit)) zones.advanced.push(unit);
  }
  return zones;
}

/**
 * 把主参数组织成可渲染、可拖拽排序的行。
 * 同类角色合并为一行（多张图片一行、宽高一行、多个 LoRA 强度一行）；
 * 成对字段双方都在时合并；顺序按 savedOrder（用户拖拽记忆），未记忆的行按默认顺序追加。
 * @param {object[]} heroes buildFormModel().heroes
 * @param {string[]} [savedOrder] 行 key 列表
 * @returns {Array<{key: string, fields: object[]}>}
 */
export function heroLayoutRows(heroes, savedOrder = []) {
  const rows = new Map();
  const rowOf = (key) => {
    if (!rows.has(key)) rows.set(key, { key, fields: [] });
    return rows.get(key);
  };
  for (const field of heroes) {
    const role = field.role ?? 'other';
    rowOf(role === 'model' ? modelRowKeyOf(field) : role).fields.push(field);
  }
  // 成对合并：两名成员都在时合成一行；只有一方时保持原角色行
  for (const [pairKey, members] of Object.entries(HERO_PAIRS)) {
    if (members.every((m) => rows.has(m))) {
      const merged = { key: pairKey, fields: members.flatMap((m) => rows.get(m).fields) };
      for (const m of members) rows.delete(m);
      rows.set(pairKey, merged);
    }
  }
  const rowsList = [...rows.values()];
  const savedIdx = new Map((savedOrder ?? []).map((k, i) => [k, i]));
  const canonicalIdx = (key) => {
    const i = HERO_ROW_DEFAULT.indexOf(key);
    return i === -1 ? HERO_ROW_DEFAULT.length : i;
  };
  rowsList.sort((a, b) => {
    const ra = savedIdx.has(a.key) ? savedIdx.get(a.key) : savedOrder.length + canonicalIdx(a.key);
    const rb = savedIdx.has(b.key) ? savedIdx.get(b.key) : savedOrder.length + canonicalIdx(b.key);
    return ra - rb || canonicalIdx(a.key) - canonicalIdx(b.key);
  });
  return rowsList;
}

/**
 * 把表单值写回工作流 JSON（就地修改并返回同一对象）。
 * @param {object} workflow API 格式工作流
 * @param {object[]} fields buildFormModel().fields
 * @param {Record<string, unknown>} values key → 新值
 */
export function applyFormModel(workflow, fields, values) {
  for (const field of fields) {
    if (!(field.key in values)) continue;
    const node = workflow[String(field.nodeId)];
    if (!node) continue;
    let value = values[field.key];
    if (field.kind === 'int' || field.kind === 'float' || field.kind === 'seed') {
      value = Number(value);
      if (Number.isNaN(value)) continue;
    }
    node.inputs[field.inputName] = value;
  }
  return workflow;
}

/**
 * 补齐 UI 不暴露的 socketless 必填输入（如 ImageCompare.compare_view）：
 * 节点编辑器添加的节点与手改 JSON 的节点可能缺这个键，服务端校验会报
 * "Required input is missing" 并拒绝整个提交，因此提交前统一补占位值。
 * @param {object} workflow API 格式工作流
 * @param {Record<string, object|null>} schemas class_type → object_info 条目
 */
export function fillSocketlessInputs(workflow, schemas = {}) {
  for (const node of listApiNodes(workflow)) {
    const schema = schemas[node.class_type];
    if (!schema) continue;
    for (const [name, def] of schemaInputs(schema)) {
      if (!isSocketlessDef(def) || name in (node.inputs ?? {})) continue;
      if (schema.input?.required && !(name in schema.input.required)) continue; // 可选输入缺省合法
      node.inputs[name] = typeof def[1]?.default === 'string' ? def[1].default : '';
    }
  }
  return workflow;
}

const OUTPUT_KEYS = ['images', 'a_images', 'b_images', 'video', 'audio', 'gifs', 'animated'];

/**
 * 从 history 条目的 outputs 提取媒体清单。
 * @param {object} outputs
 * @param {{compare?: boolean, version?: number|null}} opts compare=true 时纳入对比节点的 a_images/b_images
 *   （仅队列页滑块对比用；图库不收对比临时图）。version 传入 history 的运行序号，
 *   附加到媒体条目上供 /view URL 作缓存版本（防删除后文件名复用命中旧缓存）。
 * @returns {Array<{nodeId: string, key: string, filename: string, subfolder: string, type: string, mediaType: 'image'|'video'|'audio', version?: number}>}
 */
export function extractMediaFromOutputs(outputs, { compare = false, version = null } = {}) {
  const items = [];
  for (const [nodeId, nodeOut] of Object.entries(outputs ?? {})) {
    if (!nodeOut || typeof nodeOut !== 'object') continue;
    for (const key of OUTPUT_KEYS) {
      if (!compare && (key === 'a_images' || key === 'b_images')) continue;
      const arr = nodeOut[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (!item?.filename) continue;
        const mediaType = extType(item.filename);
        if (mediaType === 'other') continue;
        items.push({ nodeId, key, ...item, mediaType, ...(version != null ? { version } : {}) });
      }
    }
  }
  return items;
}

const CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize']);

export function isSeedInputName(name) {
  return name === 'seed' || name === 'noise_seed' || /(^|_)seed$/.test(name);
}

/**
 * 解析动态输入定义（Autogrow / DynamicCombo / DynamicSlot）。
 * @param {unknown} def object_info 输入定义
 * @returns {null|{kind: 'autogrow'|'dynamiccombo', names: string[], innerType: string, min: number}}
 */
export function dynamicInputInfo(def) {
  if (!Array.isArray(def) || typeof def[0] !== 'string') return null;
  const t = def[0];
  const opts = def[1] && typeof def[1] === 'object' ? def[1] : {};
  if (t === 'COMFY_AUTOGROW_V3') {
    const tpl = opts.template ?? {};
    const innerDefs = { ...(tpl.input?.required ?? {}), ...(tpl.input?.optional ?? {}) };
    const innerType = Object.values(innerDefs)[0];
    return {
      kind: 'autogrow',
      names: Array.isArray(tpl.names) ? tpl.names : [],
      innerType: Array.isArray(innerType) ? defConnectionTypeInner(innerType) : 'IMAGE',
      min: typeof tpl.min === 'number' ? tpl.min : 0,
      prefix: typeof tpl.prefix === 'string' ? tpl.prefix : '',
      max: typeof tpl.max === 'number' ? tpl.max : 100,
    };
  }
  if (t.includes('DYNAMICCOMBO')) return { kind: 'dynamiccombo', names: [], innerType: 'COMBO', min: 0 };
  return null;
}

function defConnectionTypeInner(innerDef) {
  if (!Array.isArray(innerDef)) return 'IMAGE';
  if (Array.isArray(innerDef[0])) return 'COMBODATA';
  return typeof innerDef[0] === 'string' ? innerDef[0] : 'IMAGE';
}

/** 是否为纯 UI 占位输入（无连线、无控件槽位）。 */
export function isSocketlessDef(def) {
  return Array.isArray(def) && typeof def[1] === 'object' && def[1]?.socketless === true;
}

/** 是否为可连线输入（供节点编辑器与连线候选使用）。 */
export function isConnectableDef(def) {
  if (isSocketlessDef(def)) return false;
  if (dynamicInputInfo(def)) return true; // autogrow/dynamiccombo 都可接线
  return !isWidgetAbleDef(def);
}

/** schema 输入定义是否为可成为 widget 的类型（否则是纯连线输入）。 */
export function isWidgetAbleDef(def) {
  if (!Array.isArray(def)) return false;
  const t = def[0];
  if (Array.isArray(t)) return true; // combo 列表
  if (typeof t !== 'string') return false;
  if (t.includes('COMBO')) return true; // COMBO / COMFY_DYNAMICCOMBO_V3 等
  return t === 'INT' || t === 'FLOAT' || t === 'STRING' || t === 'BOOLEAN';
}

/**
 * 按 schema 顺序把 UI widgets_values 回填到 API inputs。
 * 支持形态：
 * - 数组（常规）：槽位 = schema 中可成为 widget 的输入；被转换成连线的 widget 占槽不赋值；
 *   seed 类额外占一个 control_after_generate 槽位。
 * - COMFY_DYNAMICCOMBO_V3：选中项的子输入紧随其后占槽——子输入声明可能在 schema 的
 *   options 里（SaveImageAdvanced 形态），也可能只出现在 UI 输入的点号名里
 *   （BlockSparse 形态，API 键名为带点号的完整名）。
 * - 对象（VHS 等节点）：按键名回填 schema 中存在的项。
 */
function applyWidgetValues(inputs, schema, widgetValues, linkedNames, inputMetas = []) {
  if (widgetValues != null && !Array.isArray(widgetValues)) {
    if (typeof widgetValues !== 'object') return;
    for (const [name] of schemaInputs(schema)) {
      if (linkedNames.has(name)) continue;
      const value = widgetValues[name];
      if (value !== undefined && value !== null && typeof value !== 'object') inputs[name] = value;
    }
    return;
  }
  const wv = widgetValues ?? [];
  const metas = inputMetas ?? [];
  // UI 点号名（BlockSparse 形态）→ 归属父动态组合
  const dynByParent = new Map();
  for (const meta of metas) {
    if (meta.widget == null) continue;
    const dot = String(meta.name).lastIndexOf('.');
    if (dot === -1) continue;
    const parent = String(meta.name).slice(0, dot);
    const parentMeta = metas.find((x) => x.name === parent);
    if (parentMeta && /COMBO/.test(JSON.stringify(parentMeta.type ?? ''))) {
      dynByParent.set(parent, [...(dynByParent.get(parent) ?? []), meta.name]);
    }
  }

  let wi = 0;
  const consume = (entries, prefix, depth) => {
    if (depth > 3) return;
    for (const [rawName, def] of entries) {
      if (wi >= wv.length) return;
      if (!isWidgetAbleDef(def)) continue;
      const slotName = prefix ? `${prefix}.${rawName}` : rawName;
      const value = wv[wi++];
      if (isSeedInputName(slotName) && wi < wv.length && CONTROL_VALUES.has(wv[wi])) wi++;
      if (!linkedNames.has(slotName) && value !== undefined && value !== null && typeof value !== 'object') {
        inputs[slotName] = value;
      }
      if (Array.isArray(def) && typeof def[0] === 'string' && def[0].includes('DYNAMICCOMBO')) {
        const options = Array.isArray(def[1]?.options) ? def[1].options : null;
        let subEntries = null;
        if (options) {
          // SaveImageAdvanced 形态：选中项的子输入定义在 schema options 里
          const opt = options.find((o) => o.key === String(value ?? ''));
          if (opt) {
            subEntries = [
              ...Object.entries(opt.inputs?.required ?? {}),
              ...Object.entries(opt.inputs?.optional ?? {}),
            ];
          }
        } else {
          // BlockSparse 形态：子输入是 UI 里带父前缀点号名的输入项
          const subs = (dynByParent.get(rawName) ?? []).map((full) => {
            const meta = metas.find((m) => m.name === full);
            const leaf = full.slice(rawName.length + 1);
            return [leaf, [meta?.type ?? 'COMBO', {}]];
          });
          if (subs.length) subEntries = subs;
        }
        if (subEntries) consume(subEntries, slotName, depth + 1);
      }
    }
  };
  consume(schemaInputs(schema), '', 0);

  // UI 不暴露的 socketless 必填输入（如 ImageCompare.compare_view）补空字符串占位
  for (const [name, def] of schemaInputs(schema)) {
    if (!isSocketlessDef(def) || linkedNames.has(name) || name in inputs) continue;
    const dflt = Array.isArray(def[1]) && typeof def[1].default === 'string' ? def[1].default : '';
    inputs[name] = dflt;
  }
}

/**
 * UI 格式 → API 格式的尽力转换（实验特性，支持子图/subgraph 展平）。
 * @param {object} uiJson UI 导出格式
 * @param {Record<string, object|null>} schemas class_type → object_info 条目
 * @returns {{workflow: object, warnings: string[]}}
 */
export function convertUiToApi(uiJson, schemas = {}) {
  const workflow = {};
  const warnings = [];
  const links = new Map();
  for (const link of uiJson.links ?? []) {
    if (Array.isArray(link) && link.length >= 6) {
      links.set(link[0], { from: String(link[1]), slot: link[2], type: link[5] });
    }
  }
  const subgraphs = new Map();
  for (const sg of uiJson.definitions?.subgraphs ?? uiJson.subgraphs ?? []) {
    if (sg?.id) subgraphs.set(sg.id, sg);
  }
  const mutedIds = new Set();
  /** 旁路节点：finalId → { classType, inputs, outputTypes, inputTypeByName }（桌面端 bypass 语义为同类型穿通） */
  const bypassedInfos = new Map();
  /** 前端 PrimitiveNode：finalId → 字面 widget 值（转换为其消费者的输入值） */
  const primitiveValues = new Map();
  const subgraphNodeIds = new Set();
  /** 子图输出槽改写：`${外层节点}:${输出槽}` → [新节点id, 输出槽] */
  const outputRewrites = new Map();

  function resolveNodeInputs(node, linkMap, outerInputValue, mapSource = (id) => id) {
    const inputs = {};
    const linkedNames = new Set();
    for (const inp of node.inputs ?? []) {
      if (inp.link == null || !linkMap.has(inp.link)) continue;
      const link = linkMap.get(inp.link);
      if (link.from === -10) {
        if (!outerInputValue) continue;
        const value = outerInputValue(link.slot ?? 0);
        if (value !== undefined) {
          inputs[inp.name] = value;
          linkedNames.add(inp.name);
        }
        // 外层无覆盖值（官方模板形态）：不加 linkedNames，让内部 widgets_values 兜底
      } else if (link.from === -20) {
        continue;
      } else {
        inputs[inp.name] = [mapSource(link.from), link.slot];
        linkedNames.add(inp.name);
      }
    }
    return { inputs, linkedNames };
  }

  function inputTypeOf(def) {
    if (Array.isArray(def)) return typeof def[0] === 'string' && def[0] !== 'COMBO' ? def[0] : 'COMBO';
    return typeof def === 'string' ? def : 'COMBO';
  }

  function buildBypassInfo(finalId, classType, inputs) {
    const schema = schemas[classType];
    const outputTypes = schema?.output ?? [];
    const inputTypeByName = new Map();
    for (const [name, def] of schemaInputs(schema)) inputTypeByName.set(name, inputTypeOf(def));
    bypassedInfos.set(finalId, { classType, inputs, outputTypes, inputTypeByName });
  }

  function flattenSubgraph(node, sg, depth, idPrefix, linkMap, parentOuterValue) {
    if (depth > 4) {
      warnings.push(`子图嵌套超过 4 层（${sg.name ?? node.type}），未展平`);
      return;
    }
    const prefix = `${idPrefix}${node.id}_`;
    const outerInputs = node.inputs ?? [];
    const sgInputNames = (sg.inputs ?? []).map((i) => i.name);
    const wv = node.widgets_values ?? [];
    const widgetValueByName = {};

    // -10 的槽位号是子图定义 sg.inputs 的下标；实例可能只暴露其中一部分且顺序不同，
    // 必须按名字在实例输入里查找（实例没有的输入回退到内部 widgets_values 默认值）
    const instanceInputByName = new Map(outerInputs.map((i) => [i.name, i]));
    const outerInputValue = (index) => {
      const name = sgInputNames[index];
      if (name == null) return undefined;
      const inp = instanceInputByName.get(name);
      if (!inp) return undefined;
      if (inp.link != null && linkMap.has(inp.link)) {
        const link = linkMap.get(inp.link);
        if (link.from === -10) return parentOuterValue ? parentOuterValue(link.slot ?? 0) : undefined;
        return [link.from, link.slot];
      }
      const value = widgetValueByName[inp.name];
      if (value === '') return undefined; // 空串视为未覆盖，回退内部默认值
      return value;
    };
    // 统一内部连线形状：{id, from, slot, to, toSlot}
    const innerLinks = new Map();
    for (const l of sg.links ?? []) {
      if (l && typeof l === 'object' && 'id' in l) {
        innerLinks.set(l.id, { from: l.origin_id, slot: l.origin_slot, to: l.target_id, toSlot: l.target_slot, type: l.type });
      } else if (Array.isArray(l) && l.length >= 6) {
        innerLinks.set(l[0], { from: l[1], slot: l[2], to: l[3], toSlot: l[4], type: l[5] });
      }
    }
    const sgTitle = sg.name ?? node.type;
    const sgLinkList = [...innerLinks.values()];

    // 子图实例参数值的对齐规则：值按 sg.inputs 顺序存放，但**跳过纯连线槽位**
    // （如 autogrow 的 images.image_1…，它们只接连线、不占控件槽）。
    // 判定方式：跟随 -10 虚拟输入找到内部目标节点与该输入，再看它是否为可作控件的
    // schema 输入；带点号的动态子槽与 socketless 输入都不占槽。
    const sgInnerTarget = new Map(); // sg 输入下标 → { innerType, inputName }
    for (const l of sgLinkList) {
      if (l.from !== -10) continue;
      const target = (sg.nodes ?? []).find((n) => String(n.id) === String(l.to));
      const meta = target?.inputs?.[l.toSlot];
      if (target && meta) sgInnerTarget.set(l.slot, { innerType: target.type, inputName: meta.name });
    }
    const widgetSlotIndexes = [];
    sg.inputs.forEach((entry, i) => {
      const t = sgInnerTarget.get(i);
      if (!t) return;                       // 未知目标：保守跳过（由内部节点默认值兜底）
      if (String(t.inputName).includes('.')) return; // 动态子槽（autogrow 等）是连线输入
      const def = schemaInputDef(schemas[t.innerType], t.inputName);
      if (def && !isWidgetAbleDef(def)) return;      // 明确不可作控件（MODEL/CLIP 等）
      widgetSlotIndexes.push(i);
    });
    if (wv.length === widgetSlotIndexes.length) {
      widgetSlotIndexes.forEach((sgIdx, pos) => {
        const name = sgInputNames[sgIdx];
        if (name !== undefined) widgetValueByName[name] = wv[pos];
      });
    } else if (wv.length > 0) {
      warnings.push(`子图 ${sg.name ?? node.type} 的实例参数数量（${wv.length}）与控件槽位（${widgetSlotIndexes.length}）不一致，已改用节点内部默认值`);
    }
    // 子图虚拟输入（-10）→ 外层该槽位的连线值或 widget 值；嵌套时递归透传到更外层

    for (const inner of sg.nodes ?? []) {
      if (SKIP_NODE_TYPES.has(inner.type)) continue;
      const newId = `${prefix}${inner.id}`;
      if (inner.mode === 2) {
        mutedIds.add(newId);
        continue;
      }
      if (inner.mode === 4 || PASS_THROUGH_TYPES.has(inner.type)) {
        try {
          const { inputs } = resolveNodeInputs(inner, innerLinks, outerInputValue, (id) => `${prefix}${id}`);
          if (inner.mode === 4) warnings.push(`子图 ${sgTitle} 内 ${friendlyClassName(inner.type)} 被旁路，已按同类型穿通处理`);
          buildBypassInfo(newId, inner.type, inputs);
        } catch (err) {
          warnings.push(`子图 ${sgTitle} 内节点 ${inner.id} 转换失败已跳过：${err.message}`);
        }
        continue;
      }
      if (FRONTEND_VALUE_TYPES.has(inner.type)) {
        const literal = (inner.widgets_values ?? []).find((v) => typeof v !== 'object' || v == null);
        if (literal !== undefined) primitiveValues.set(newId, literal);
        continue;
      }
      const nestedSg = subgraphs.get(inner.type);
      if (nestedSg) {
        subgraphNodeIds.add(newId);
        try {
          flattenSubgraph(inner, nestedSg, depth + 1, prefix, innerLinks, outerInputValue);
        } catch (err) {
          warnings.push(`嵌套子图 ${inner.type} 展平失败已跳过：${err.message}`);
        }
        continue;
      }
      try {
        const { inputs, linkedNames } = resolveNodeInputs(inner, innerLinks, outerInputValue, (id) => `${prefix}${id}`);
        const schema = schemas[inner.type];
        if (schema) {
          applyWidgetValues(inputs, schema, inner.widgets_values, linkedNames, inner.inputs);
        } else {
          warnings.push(`缺少 ${inner.type} 的节点定义（子图 ${sgTitle}），节点 ${newId} 仅保留连线输入`);
        }
        workflow[newId] = { class_type: inner.type, inputs, _meta: { title: `${sgTitle}/${inner.title ?? inner.type}` } };
      } catch (err) {
        warnings.push(`子图 ${sgTitle} 内节点 ${inner.id}（${inner.type}）转换失败已跳过：${err.message}`);
      }
    }
    // 子图输出槽 → 内部实际来源（嵌套时会在第二遍按链改写）
    for (const l of innerLinks.values()) {
      if (l.to === -20) {
        outputRewrites.set(`${idPrefix}${node.id}:${l.toSlot}`, [`${prefix}${l.from}`, l.slot]);
      }
    }
  }

  /** 单个 UI 节点 → API 节点；返回 bypass 信息或 null。 */
  function convertOneNode(node, idPrefix, linkMap, outerInputValue, titlePrefix) {
    const finalId = `${idPrefix}${node.id}`;
    const isBypass = node.mode === 4 || PASS_THROUGH_TYPES.has(node.type);
    const isMute = node.mode === 2;

    if (SKIP_NODE_TYPES.has(node.type)) return; // 备注/文档节点直接丢弃
    if (isMute) {
      mutedIds.add(finalId);
      return;
    }

    const { inputs, linkedNames } = resolveNodeInputs(node, linkMap, outerInputValue);
    const schema = schemas[node.type];
    if (schema) {
      applyWidgetValues(inputs, schema, node.widgets_values, linkedNames, node.inputs);
    } else if (!isBypass && !FRONTEND_VALUE_TYPES.has(node.type)) {
      const where = titlePrefix ? `（${titlePrefix}）` : '';
      warnings.push(`缺少 ${node.type} 的节点定义${where}，节点 ${finalId} 仅保留连线输入`);
    }

    if (isBypass) {
      if (node.mode === 4) warnings.push(`节点 ${finalId}（${friendlyClassName(node.type)}）被旁路，已按同类型穿通处理`);
      buildBypassInfo(finalId, node.type, inputs);
      return;
    }
    if (FRONTEND_VALUE_TYPES.has(node.type)) {
      const literal = (node.widgets_values ?? []).find((v) => typeof v !== 'object' || v == null);
      if (literal !== undefined) primitiveValues.set(finalId, literal);
      return;
    }

    const meta = { title: titlePrefix ? `${titlePrefix}/${node.title ?? node.type}` : (node.title ?? '') };
    // 桌面布局侧信道：原 UI 图的 pos/size 存进 _meta 随 API 态流转，保存时 apiToUi 原位还原
    // （ComfyUI 服务端只读 _meta.title，额外键不影响 /prompt）
    if (Number.isFinite(node.pos?.[0]) && Number.isFinite(node.pos?.[1])) meta._cm_pos = [node.pos[0], node.pos[1]];
    if (Number.isFinite(node.size?.[0]) && Number.isFinite(node.size?.[1])) meta._cm_size = [node.size[0], node.size[1]];
    workflow[finalId] = { class_type: node.type, inputs, _meta: meta };
  }

  for (const node of uiJson.nodes ?? []) {
    try {
      const sg = subgraphs.get(node.type);
      if (node.mode !== 2 && node.mode !== 4 && sg) {
        subgraphNodeIds.add(String(node.id));
        flattenSubgraph(node, sg, 0, '', links, null);
        continue;
      }
      convertOneNode(node, '', links, null, '');
    } catch (err) {
      warnings.push(`节点 ${node.id}（${node.type}）转换失败已跳过：${err.message}`);
    }
  }

  // 旁路节点同类型穿通：把指向旁路节点输出的连线改写到其第一个同类型输入的来源
  const resolveThroughBypass = (id, slot, seen) => {
    const key = `${id}:${slot}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const info = bypassedInfos.get(id);
    if (!info) return [id, slot];
    const outType = info.outputTypes[slot] ?? info.outputTypes[0] ?? '';
    let inputName = null;
    for (const [name, type] of info.inputTypeByName) {
      if (type === outType && info.inputs[name] !== undefined) {
        inputName = name;
        break;
      }
    }
    if (inputName == null) {
      inputName = Object.keys(info.inputs).find((n) => Array.isArray(info.inputs[n]));
    }
    if (inputName == null) return null;
    const value = info.inputs[inputName];
    if (!Array.isArray(value)) return null;
    if (bypassedInfos.has(value[0])) return resolveThroughBypass(value[0], value[1], seen);
    return value;
  };

  // 子图输出改写可能链式指向嵌套子图实例，逐级跟随（带环保护）
  const resolveSubgraphChain = (from, slot) => {
    let key = `${from}:${slot}`;
    for (let hop = 0; hop < 6; hop++) {
      const rewrite = outputRewrites.get(key);
      if (!rewrite) return null;
      if (subgraphNodeIds.has(rewrite[0])) {
        key = `${rewrite[0]}:${rewrite[1]}`;
        continue;
      }
      return rewrite;
    }
    return null;
  };

  // 链式收敛：子图改写 / 旁路穿通 / 前端参数字面量 之间的多级跳转
  const finalizeLink = (from, slot) => {
    for (let guard = 0; guard < 8; guard++) {
      if (primitiveValues.has(from)) return { literal: primitiveValues.get(from) };
      if (subgraphNodeIds.has(from)) {
        const rewrite = resolveSubgraphChain(from, slot);
        if (!rewrite) return null;
        [from, slot] = rewrite;
        continue;
      }
      if (bypassedInfos.has(from)) {
        const resolved = resolveThroughBypass(from, slot, new Set());
        if (!resolved) return null;
        [from, slot] = resolved;
        continue;
      }
      return { link: [from, slot] };
    }
    return null;
  };

  // 第二遍：指向子图/静音/旁路/前端参数节点的连线改写或移除
  for (const node of Object.values(workflow)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value)) continue;
      const [from, slot] = value;
      if (mutedIds.has(from)) {
        delete node.inputs[name];
        warnings.push(`输入 ${name} 指向被静音的节点 #${from}，已移除`);
        continue;
      }
      const finalized = finalizeLink(from, slot);
      if (!finalized) {
        delete node.inputs[name];
        warnings.push(`输入 ${name} 的来源（#${from}:${slot}）无法解析，已移除`);
      } else if (finalized.literal !== undefined) {
        node.inputs[name] = finalized.literal;
      } else {
        node.inputs[name] = finalized.link;
      }
    }
  }
  return { workflow, warnings };
}

/** 新建工作流的起步模板（文生图最小闭环）。 */
export function starterWorkflow() {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: 0, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
        model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
  };
}

/** 提取 schema 输入的连接类型名（combo 列表归为 COMBO，autogrow 取其内层类型）。 */
export function defConnectionType(def) {
  if (!Array.isArray(def)) return typeof def === 'string' ? def : '';
  const dyn = dynamicInputInfo(def);
  if (dyn) return dyn.innerType;
  if (Array.isArray(def[0])) return 'COMBODATA';
  return typeof def[0] === 'string' ? def[0] : 'COMBO';
}

/**
 * 旁路节点：把消费方的连线改接到被旁路节点同类型输入的来源（桌面端 bypass 语义），
 * 节点从工作流移除，返回用于恢复的存档。
 */
export function bypassNodeInWorkflow(workflow, nodeId, schemas) {
  const node = workflow[String(nodeId)];
  if (!node) return null;
  const schema = schemas?.[node.class_type] ?? null;
  const outputTypes = schema?.output ?? [];
  const consumers = [];
  for (const [otherId, other] of Object.entries(workflow)) {
    if (otherId === String(nodeId)) continue;
    for (const [inputName, v] of Object.entries(other.inputs ?? {})) {
      if (!Array.isArray(v) || String(v[0]) !== String(nodeId)) continue;
      consumers.push({ id: otherId, inputName, prev: [...v] });
      const outType = outputTypes[v[1]] ?? outputTypes[0] ?? '';
      let pick = null;
      if (schema) {
        for (const [name, def] of schemaInputs(schema)) {
          if (defConnectionType(def) !== outType) continue;
          const src = node.inputs?.[name];
          if (src === undefined) continue;
          pick = Array.isArray(src) ? { link: [...src] } : { value: src };
          break;
        }
      }
      if (!pick) {
        const firstLink = Object.entries(node.inputs ?? {}).find(([, v2]) => Array.isArray(v2));
        pick = firstLink ? { link: [...firstLink[1]] } : null;
      }
      if (pick?.link) other.inputs[inputName] = pick.link;
      else if (pick?.value !== undefined) other.inputs[inputName] = pick.value;
      else delete other.inputs[inputName];
    }
  }
  const archive = { bypassedId: String(nodeId), node: JSON.parse(JSON.stringify(node)), consumers };
  delete workflow[String(nodeId)];
  return archive;
}

/** 恢复被旁路的节点（连回原消费方）。 */
export function restoreBypassedNode(workflow, archive) {
  if (!archive?.node) return;
  workflow[archive.bypassedId] = archive.node;
  for (const c of archive.consumers ?? []) {
    const n = workflow[c.id];
    if (n) n.inputs[c.inputName] = [...c.prev];
  }
}
