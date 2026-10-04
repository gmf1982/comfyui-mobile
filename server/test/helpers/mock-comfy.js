/**
 * 模拟 ComfyUI 服务器：实现集成测试所需的 §4 端点子集，含假执行流、Range、WS 事件与二进制预览帧。
 * 仅供测试与本地联调使用（scripts/mock-comfy.js 提供 CLI 包装）。
 */
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { mediaTypeOf, mimeOfFilename, contentDisposition, isSafeMediaName } from '../../src/media.js';

const SAMPLER_LIST = ['euler', 'euler_ancestral', 'res_multistep', 'gradient_noise', 'ipndm', 'deis', 'heun', 'lms', 'ddpm', 'lcm', 'uni_pc', 'dpm_fast', 'dpmpp_2m', 'ddim'];
const SCHED_LIST = ['normal', 'karras', 'simple'];

const OBJECT_INFO = {
  KSampler: {
    input: {
      required: {
        model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'],
        seed: ['INT', { default: 0, min: 0, max: 1125899906842624 }],
        steps: ['INT', { default: 20, min: 1, max: 10000 }],
        cfg: ['FLOAT', { default: 8.0, min: 0.0, max: 100.0, step: 0.1, round: 0.01 }],
        sampler_name: [SAMPLER_LIST],
        scheduler: [SCHED_LIST],
        denoise: ['FLOAT', { default: 1.0, min: 0.0, max: 1.0, step: 0.01 }],
      },
    },
    output: ['LATENT'], output_name: ['LATENT'], name: 'KSampler', category: 'sampling',
  },
  KSamplerAdvanced: {
    input: {
      required: {
        model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'],
        add_noise: [['enable', 'disable']],
        noise_seed: ['INT', { default: 0, min: 0, max: 1125899906842624 }],
        steps: ['INT', { default: 20, min: 1, max: 10000 }],
        cfg: ['FLOAT', { default: 8.0, min: 0.0, max: 100.0, step: 0.1 }],
        sampler_name: [SAMPLER_LIST], scheduler: [SCHED_LIST],
        start_at_step: ['INT', { default: 0, min: 0, max: 10000 }],
        end_at_step: ['INT', { default: 10000, min: 0, max: 10000 }],
        return_with_leftover_noise: [['disable', 'enable']],
      },
    },
    output: ['LATENT'], output_name: ['LATENT'], name: 'KSamplerAdvanced', category: 'sampling',
  },
  CLIPTextEncode: {
    input: { required: { text: ['STRING', { multiline: true, default: '' }], clip: ['CLIP'] } },
    output: ['CONDITIONING'], output_name: ['CONDITIONING'], name: 'CLIPTextEncode', category: 'conditioning',
  },
  EmptyLatentImage: {
    input: {
      required: {
        width: ['INT', { default: 512, min: 16, max: 16384, step: 8 }],
        height: ['INT', { default: 512, min: 16, max: 16384, step: 8 }],
        batch_size: ['INT', { default: 1, min: 1, max: 4096 }],
      },
    },
    output: ['LATENT'], output_name: ['LATENT'], name: 'EmptyLatentImage', category: 'latent',
  },
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [['mock_a.safetensors', 'mock_b.safetensors']] } },
    output: ['MODEL', 'CLIP', 'VAE'], output_name: ['MODEL', 'CLIP', 'VAE'],
    name: 'CheckpointLoaderSimple', category: 'loaders',
  },
  LoraLoader: {
    input: {
      required: {
        lora_name: [['mock_lora.safetensors']],
        strength_model: ['FLOAT', { default: 1.0, min: -10.0, max: 10.0, step: 0.01 }],
        strength_clip: ['FLOAT', { default: 1.0, min: -10.0, max: 10.0, step: 0.01 }],
        model: ['MODEL'], clip: ['CLIP'],
      },
    },
    output: ['MODEL', 'CLIP'], output_name: ['MODEL', 'CLIP'], name: 'LoraLoader', category: 'loaders',
  },
  LoadImage: {
    input: { required: { image: [['example.png']], upload: ['IMAGEUPLOAD'] } },
    output: ['IMAGE', 'MASK'], output_name: ['IMAGE', 'MASK'], name: 'LoadImage', category: 'image',
  },
  VAEDecode: {
    input: { required: { samples: ['LATENT'], vae: ['VAE'] } },
    output: ['IMAGE'], output_name: ['IMAGE'], name: 'VAEDecode', category: 'latent',
  },
  SaveImage: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } },
    output: [], output_name: [], name: 'SaveImage', category: 'image',
  },
  ImageCompare: {
    input: {
      required: { compare_view: ['IMAGECOMPARE', { socketless: true }] },
      optional: { image_a: ['IMAGE'], image_b: ['IMAGE'] },
    },
    output: [], output_name: [], name: 'ImageCompare', category: 'image', output_node: true,
  },
  SaveAudioMP3: {
    input: { required: { audio: ['AUDIO'], filename_prefix: ['STRING', { default: 'audio' }], quality: [['128k', '192k', '320k']] } },
    output: [], output_name: [], name: 'SaveAudioMP3', category: 'audio',
  },
  VHS_VideoCombine: {
    input: {
      required: {
        images: ['IMAGE'], frame_rate: ['INT', { default: 24, min: 1, max: 120 }],
        loop_count: ['INT', { default: 0 }], filename_prefix: ['STRING', { default: 'VHS' }],
        format: [['video/h264-mp4']], pingpong: ['BOOLEAN', { default: false }], save_output: ['BOOLEAN', { default: true }],
      },
    },
    output: [], output_name: [], name: 'VHS_VideoCombine', category: 'video',
  },
};

const KNOWN_CLASSES = new Set(Object.keys(OBJECT_INFO));
const MODEL_FOLDERS = {
  checkpoints: ['mock_a.safetensors', 'mock_b.safetensors'],
  loras: [
    'mock_lora.safetensors', 'detail_tweaker_lora.safetensors', 'film_grain_style.safetensors',
    'qwen_image_lightning_4step.safetensors', 'wan_fun_control.safetensors', 'add_detail_xl.safetensors',
    'anime_style_v2.safetensors', 'realistic_skin_v1.safetensors', 'cinematic_light.safetensors',
    'pixel_art_lora.safetensors', 'watercolor_style.safetensors', 'sketch_line.safetensors',
    'neon_glow.safetensors', 'vintage_film.safetensors',
  ],
  vae: ['mock_vae.safetensors'],
  diffusion_models: ['mock_unet.safetensors'],
};

/** 确定性假媒体内容：同名文件字节稳定，测试可断言一致性。 */
function fakeMediaBytes(filename, size = 4096) {
  const bytes = Buffer.alloc(size);
  let h = crypto.createHash('sha256').update(filename).digest()[0];
  for (let i = 0; i < size; i++) {
    h = (h * 31 + i + 1) & 0xff;
    bytes[i] = h;
  }
  return bytes;
}

/**
 * 创建模拟 ComfyUI。
 * @param {{execDelayMs?: number, inputDir?: string}} options
 *   inputDir：提供时 LoadImage 的 image 组合框列出该目录下的媒体文件（与真实 ComfyUI 一致），
 *   供选择器联调；缺省保持 example.png，不影响既有测试。
 */
export function createMockComfy(options = {}) {
  const execDelayMs = options.execDelayMs ?? 150;
  let loadImageFiles = ['example.png'];
  if (options.inputDir) {
    try {
      loadImageFiles = fs.readdirSync(options.inputDir)
        .filter((f) => mediaTypeOf(f) === 'image')
        .sort();
    } catch {
      // 目录不可读时退回默认列表
    }
  }
  // 每实例复制 object_info：LoadImage 组合框按 options.inputDir 反映输入目录（默认 example.png），
  // 避免修改模块级常量导致同进程多个 mock 实例互相串列表
  const objectInfo = {
    ...OBJECT_INFO,
    LoadImage: {
      ...OBJECT_INFO.LoadImage,
      input: { required: { image: [loadImageFiles], upload: ['IMAGEUPLOAD'] } },
    },
  };
  const state = {
    workflows: new Map(),  // 相对路径 → 文本内容
    history: new Map(),    // prompt_id → history 条目
    historyOrder: [],
    pending: [],           // 队列条目 [number, id, prompt, extra, []]
    running: [],
    promptCounter: 1,
    interrupted: 0,
  };
  const sockets = new Set();
  let jobTimers = [];

  const wss = new WebSocketServer({ noServer: true });

  function broadcast(text) {
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  }

  function broadcastBinary(buf) {
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true });
    }
  }

  function statusPayload() {
    return JSON.stringify({
      type: 'status',
      data: { status: { exec_info: { queue_remaining: state.pending.length + state.running.length } }, sid: null },
    });
  }

  function runJob(promptId, prompt) {
    const outputs = {};
    const progressMax = 3;
    broadcast(JSON.stringify({ type: 'execution_start', data: { prompt_id: promptId } }));
    // 模拟节点遍历：sampling 节点发 progress
    const samplerNode = Object.entries(prompt).find(([, n]) => /sampler/i.test(n.class_type));
    for (let v = 1; v <= progressMax; v++) {
      broadcast(JSON.stringify({
        type: 'progress',
        data: { value: v, max: progressMax, prompt_id: promptId, node: samplerNode?.[0] ?? '3' },
      }));
    }
    // 二进制预览帧（事件类型 1 预览图 + 图片类型 1 JPEG）
    const preview = Buffer.concat([
      Buffer.from([1, 0, 0, 0, 1, 0, 0, 0]),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x20, 0x30, 0x40]),
    ]);
    broadcastBinary(preview);

    for (const [nodeId, node] of Object.entries(prompt)) {
      if (node.class_type === 'SaveImage') {
        const prefix = typeof node.inputs.filename_prefix === 'string' ? node.inputs.filename_prefix : 'ComfyUI';
        outputs[nodeId] = { images: [{ filename: `${prefix}_00001_.png`, subfolder: '', type: 'output' }] };
        broadcast(JSON.stringify({ type: 'executed', data: { node: nodeId, output: outputs[nodeId], prompt_id: promptId } }));
      } else if (node.class_type === 'ImageCompare') {
        // 与真实节点一致：对比图落在 a_images/b_images 键，temp 类型
        outputs[nodeId] = {
          a_images: [{ filename: 'comfy.compare.a_00001_.png', subfolder: '', type: 'temp' }],
          b_images: [{ filename: 'comfy.compare.b_00001_.png', subfolder: '', type: 'temp' }],
        };
      } else if (node.class_type === 'SaveAudioMP3') {
        outputs[nodeId] = { audio: [{ filename: `${node.inputs.filename_prefix || 'audio'}_00001_.mp3`, subfolder: '', type: 'output' }] };
      } else if (node.class_type === 'VHS_VideoCombine') {
        outputs[nodeId] = { gifs: [{ filename: `${node.inputs.filename_prefix || 'VHS'}_00001_.mp4`, subfolder: 'VHS', type: 'output' }] };
      }
    }
    state.history.set(promptId, {
      prompt: [state.promptCounter, promptId, prompt, {}, []],
      outputs,
      status: { status_str: 'success', completed: true, messages: [] },
    });
    state.historyOrder.push(promptId);
    broadcast(JSON.stringify({ type: 'execution_success', data: { prompt_id: promptId, messages: [] } }));
    broadcast(statusPayload());
  }

  function submitPrompt(body) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { status: 400, body: { error: 'invalid_json' } };
    }
    const prompt = parsed?.prompt;
    if (!prompt || typeof prompt !== 'object') {
      return { status: 400, body: { error: 'invalid_prompt' } };
    }
    const nodeErrors = {};
    for (const [nodeId, node] of Object.entries(prompt)) {
      if (!node?.class_type || !KNOWN_CLASSES.has(node.class_type)) {
        nodeErrors[nodeId] = {
          class_type: node?.class_type ?? 'unknown',
          errors: [{ type: 'node_missing', message: `Class ${node?.class_type} not found` }],
        };
        continue;
      }
      // socketless 必填输入（如 ImageCompare.compare_view）缺失时模拟真实 ComfyUI 的校验失败
      for (const [name, def] of Object.entries(OBJECT_INFO[node.class_type].input?.required ?? {})) {
        if (def?.[1]?.socketless && !(name in (node.inputs ?? {}))) {
          nodeErrors[nodeId] = {
            class_type: node.class_type,
            errors: [{ type: 'required_input_missing', message: 'Required input is missing' }],
          };
        }
      }
    }
    const promptId = crypto.randomUUID();
    const number = state.promptCounter++;
    if (Object.keys(nodeErrors).length) {
      // 与真实 ComfyUI 一致：校验失败返回 400 + error + node_errors
      return {
        status: 400,
        body: { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: nodeErrors },
      };
    }
    state.running.push([number, promptId, prompt, {}, []]);
    broadcast(statusPayload());
    jobTimers.push(setTimeout(() => {
      state.running = state.running.filter((e) => e[1] !== promptId);
      runJob(promptId, prompt);
    }, execDelayMs));
    return { status: 200, body: { prompt_id: promptId, number, node_errors: {} } };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;
    const sendJson = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    if (path === '/system_stats') {
      return sendJson(200, {
        system: { os: 'mock', ram_total: 8 << 30, ram_free: 4 << 30, comfyui_version: '0.37.0-mock' },
        devices: [{ name: 'MOCK GPU', type: 'cuda', vram_total: 8 << 30, vram_free: 6 << 30 }],
      });
    }
    if (path === '/object_info') {
      return sendJson(200, objectInfo);
    }
    if (path.startsWith('/object_info/')) {
      const cls = decodeURIComponent(path.slice('/object_info/'.length));
      if (cls in objectInfo) return sendJson(200, { [cls]: objectInfo[cls] });
      return sendJson(200, {});
    }
    if (path === '/prompt') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const out = submitPrompt(body.toString('utf8'));
        return sendJson(out.status, out.body);
      }
      return sendJson(200, { exec_info: { queue_remaining: state.pending.length + state.running.length } });
    }
    if (path === '/interrupt' && req.method === 'POST') {
      state.interrupted++;
      return sendJson(200, {});
    }
    if (path === '/queue') {
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const ids = new Set(body.delete ?? []);
        state.pending = state.pending.filter((e) => !ids.has(e[1]));
        return sendJson(200, {});
      }
      return sendJson(200, { queue_running: state.running, queue_pending: state.pending });
    }
    if (path === '/history' || path.startsWith('/history/')) {
      // 删除历史（与真实 ComfyUI 一致：POST {delete:[id]}）；夹具内先于下方 GET 分支
      if (path === '/history' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const ids = new Set(body.delete ?? []);
        for (const id of ids) {
          state.history.delete(id);
          state.historyOrder = state.historyOrder.filter((x) => x !== id);
        }
        return sendJson(200, {});
      }
      // 单条历史（/history/{id}）供队列页按 prompt_id 拉取本次结果，与真实 ComfyUI 一致
      if (path.startsWith('/history/')) {
        const id = decodeURIComponent(path.slice('/history/'.length));
        const entry = state.history.get(id);
        return entry ? sendJson(200, { [id]: entry }) : sendJson(404, { error: 'not_found' });
      }
      const max = Number(url.searchParams.get('max_items') ?? 0);
      let ids = state.historyOrder;
      if (max > 0) ids = ids.slice(-max);
      const out = {};
      for (const id of ids) out[id] = state.history.get(id);
      return sendJson(200, out);
    }
    if (path === '/view') {
      const filename = url.searchParams.get('filename') ?? '';
      if (!isSafeMediaName(filename)) {
        return sendJson(400, { error: 'invalid_filename', message: '文件名不合法' });
      }
      const bytes = fakeMediaBytes(filename);
      const mime = mimeOfFilename(filename) || 'application/octet-stream';
      const headers = {
        'Content-Type': mime,
        'Content-Disposition': contentDisposition(filename, false),
        'Accept-Ranges': 'bytes',
      };
      const range = req.headers.range;
      const match = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
      if (match) {
        let start = match[1] === '' ? null : Number(match[1]);
        let end = match[2] === '' ? null : Number(match[2]);
        if (start == null) {
          start = bytes.length - Number(end);
          end = bytes.length - 1;
        } else if (end == null || end >= bytes.length) {
          end = bytes.length - 1;
        }
        if (start > end || start >= bytes.length) {
          res.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` });
          return res.end();
        }
        headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
        headers['Content-Length'] = end - start + 1;
        res.writeHead(206, headers);
        return res.end(bytes.subarray(start, end + 1));
      }
      headers['Content-Length'] = bytes.length;
      res.writeHead(200, headers);
      return res.end(bytes);
    }
    if (path === '/models' || path.startsWith('/models/')) {
      const folder = decodeURIComponent(path.slice('/models/'.length));
      if (folder in MODEL_FOLDERS) return sendJson(200, MODEL_FOLDERS[folder]);
      return sendJson(200, []);
    }
    if (path === '/upload/image' && req.method === 'POST') {
      const body = await readBody(req);
      // multipart 头部按 latin1 找到 filename 段，再按 UTF-8 还原（支持中文文件名）
      const match = /filename="([^"]*)"/.exec(body.toString('latin1'));
      const name = match ? Buffer.from(match[1], 'latin1').toString('utf8') : 'upload.png';
      return sendJson(200, { name, subfolder: '', type: 'input' });
    }
    if (path === '/userdata') {
      const dir = url.searchParams.get('dir') ?? '';
      const keys = [...state.workflows.keys()]
        .filter((k) => k.startsWith(dir + '/'))
        .map((k) => k.slice(dir.length + 1));
      return sendJson(200, keys);
    }
    if (path.startsWith('/userdata/')) {
      const rel = decodeURIComponent(path.slice('/userdata/'.length));
      const sub = url.searchParams.get('subfolder') ?? '';
      const full = sub ? `${sub}/${rel}` : rel;
      if (req.method === 'GET') {
        if (!state.workflows.has(full)) return sendJson(404, { error: 'not_found' });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(state.workflows.get(full));
      }
      if (req.method === 'POST') {
        if (state.workflows.has(full) && url.searchParams.get('overwrite') !== 'true') {
          return sendJson(409, { error: 'exists' });
        }
        const body = await readBody(req);
        state.workflows.set(full, body.toString('utf8'));
        return sendJson(201, { name: full });
      }
      if (req.method === 'DELETE') {
        if (!state.workflows.delete(full)) return sendJson(404, { error: 'not_found' });
        res.writeHead(204);
        return res.end();
      }
      return sendJson(405, { error: 'method_not_allowed' });
    }
    sendJson(404, { error: 'not_found', path });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.send(statusPayload());
      ws.on('close', () => sockets.delete(ws));
    });
  });

  return {
    server,
    state,
    close: async () => {
      for (const timer of jobTimers) clearTimeout(timer);
      jobTimers = [];
      for (const ws of sockets) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
