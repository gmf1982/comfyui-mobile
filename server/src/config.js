/**
 * 网关配置：默认值 + config.json + CLI/env 覆盖，配置错误立即抛出（失败即响）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULTS = {
  port: 8899,
  host: '0.0.0.0',
  upstream: 'http://127.0.0.1:8188',
  token: '',
  tls: null,
  maxUploadMB: 512,
  rateLimitPerMin: 120,
  authFailsPerMin: 30,
  banMinutes: 5,
  rangeFallbackMB: 0,
  webDir: 'web',
  outputDir: '',
  inputDir: '',
  tunnel: false,
  cloudflared: '',
  tailscale: '',
  tailscaleHttpsPort: 8443,
  // LLM 提示词增强（/gw/enhance-prompt）：OpenAI 兼容端点，支持多模型供手机端切换。
  // 推荐写法（models 列表，手机端可下拉选择）：
  // "promptLlm": { "enabled": true, "default": "gemma3:270m（本地）", "models": [
  //   { "name": "gemma3:270m（本地）", "baseUrl": "http://127.0.0.1:11434/v1", "apiKey": "", "model": "gemma3:270m" },
  //   { "name": "GLM-4.7-Flash", "baseUrl": "https://open.bigmodel.cn/api/paas/v4", "apiKey": "你的key", "model": "glm-4.7-flash" }
  // ] }
  // 旧的单模型写法 {baseUrl, apiKey, model} 仍兼容（自动归一为单元素列表）。
  promptLlm: { enabled: false, models: [] },
  // ComfyUI 远程启动（/gw/comfyui/start）：本机启动命令，只在手机端点「启动 ComfyUI」时执行。
  // 安全模型：命令只来自本机 config.json，网络请求无法指定启动什么。示例：
  // "comfyuiLaunch": "C:\\ComfyUI\\run_nvidia_gpu.bat"
  // 工作目录默认取命令首记号所在目录（.bat 场景即 ComfyUI 根目录）；不符时显式配 "comfyuiCwd"。
  // 日志：logs/comfyui.log。留空 = 功能关闭（接口报 400，手机端隐藏按钮）。
  comfyuiLaunch: '',
  comfyuiCwd: '',
};

/** 比较调用方可覆盖的配置键（token 允许覆盖，tls 用专用 CLI 键）。 */
const OVERRIDABLE = new Set([
  'port', 'host', 'upstream', 'token', 'maxUploadMB', 'rateLimitPerMin',
  'authFailsPerMin', 'banMinutes', 'rangeFallbackMB', 'webDir', 'tls',
  'tunnel', 'cloudflared', 'outputDir', 'inputDir', 'tailscale', 'tailscaleHttpsPort',
  'thumbCacheDir', 'promptLlm', 'comfyuiLaunch', 'comfyuiCwd',
]);

/**
 * 加载并校验配置。`configFile` 不存在时以默认值启动；首次生成的 token 会写回文件。
 * @param {{ configFile?: string, overrides?: Record<string, unknown> }} options
 * @returns {object} 校验后的完整配置
 */
export function loadConfig({ configFile = '', overrides = {} } = {}) {
  let fileCfg = {};
  if (configFile && fs.existsSync(configFile)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (err) {
      throw new Error(`配置文件 ${configFile} 不是合法 JSON：${err.message}`);
    }
  }
  const cfg = { ...DEFAULTS, ...fileCfg };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && OVERRIDABLE.has(key)) cfg[key] = value;
  }
  // CLI 覆盖项一律为字符串：数值型键做类型转换
  for (const key of ['port', 'maxUploadMB', 'rateLimitPerMin', 'authFailsPerMin', 'banMinutes', 'rangeFallbackMB']) {
    if (typeof cfg[key] === 'string' && cfg[key] !== '' && Number.isFinite(Number(cfg[key]))) {
      cfg[key] = Number(cfg[key]);
    }
  }
  // 隧道模式：true 等价 quick；支持 quick|serve|funnel|named|off
  if (typeof cfg.tunnel === 'string') {
    const v = cfg.tunnel.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) cfg.tunnel = 'quick';
    else if (['0', 'false', 'no', 'off'].includes(v)) cfg.tunnel = false;
    else if (v.split(',').every((m) => ['quick', 'serve', 'funnel', 'named'].includes(m.trim()))) {
      const modes = v.split(',').map((m) => m.trim()).filter(Boolean);
      cfg.tunnel = modes.length > 1 ? modes : modes[0];
    } else {
      throw new Error(`tunnel 取值非法：${cfg.tunnel}（可选 quick|serve|funnel|named|false，多个用逗号分隔）`);
    }
  }
  if (typeof cfg.tailscaleHttpsPort === 'string' && cfg.tailscaleHttpsPort !== '') {
    cfg.tailscaleHttpsPort = Number(cfg.tailscaleHttpsPort);
  }
  // inputDir 未配置时按 ComfyUI 的标准布局从 outputDir 推导（…/output 的同级 …/input）
  if (!cfg.inputDir && cfg.outputDir) {
    cfg.inputDir = path.resolve(cfg.outputDir, '..', 'input');
  }
  // 缩略图磁盘缓存目录：默认放在 config.json 旁边，便于查找与整体清理
  if (!cfg.thumbCacheDir) {
    cfg.thumbCacheDir = path.join(configFile ? path.dirname(configFile) : process.cwd(), '.thumb-cache');
  }
  // LLM 增强：归一化 models 列表（兼容旧单模型写法），启用时校验每项端点完整（失败即响）
  if (cfg.promptLlm?.enabled) {
    const p = cfg.promptLlm;
    if (!Array.isArray(p.models) || !p.models.length) {
      if (!p.baseUrl || !p.model) {
        throw new Error('promptLlm.enabled=true 时需要 models 列表，或旧写法的 baseUrl+model（如智谱 open.bigmodel.cn/api/paas/v4 + glm-4.7-flash，或本地 Ollama http://127.0.0.1:11434/v1 + gemma3:270m）');
      }
      p.models = [{ name: p.model, baseUrl: p.baseUrl, apiKey: p.apiKey ?? '', model: p.model }];
    }
    p.models = p.models.map((m) => {
      if (!m?.baseUrl || !m?.model) {
        throw new Error('promptLlm.models 每一项都必须包含 baseUrl 与 model（apiKey 可留空，本地端点无需鉴权）');
      }
      const item = { name: String(m.name ?? m.model), baseUrl: String(m.baseUrl), apiKey: String(m.apiKey ?? ''), model: String(m.model) };
      // timeoutMs 可选：思考型/需冷加载的大模型按项放宽超时（毫秒），不填用 enhance.js 默认值
      if (m.timeoutMs != null) item.timeoutMs = Number(m.timeoutMs);
      return item;
    });
    p.default = p.models.some((m) => m.name === p.default) ? p.default : p.models[0].name;
  }
  validate(cfg);

  if (!cfg.token) {
    cfg.token = crypto.randomBytes(32).toString('hex');
    if (configFile) {
      fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + '\n');
    }
  }
  return cfg;
}

function validate(cfg) {
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    throw new Error(`port 必须是 1-65535 的整数，当前：${cfg.port}`);
  }
  const upstream = new URL(cfg.upstream);
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error(`upstream 必须是 http(s) 地址，当前：${cfg.upstream}`);
  }
  if (typeof cfg.token !== 'string' || /[\s]/.test(cfg.token)) {
    throw new Error('token 必须是不含空白字符的字符串');
  }
  if (cfg.tls) {
    if (!cfg.tls.cert || !cfg.tls.key) {
      throw new Error('tls.cert 与 tls.key 必须同时提供');
    }
    for (const p of [cfg.tls.cert, cfg.tls.key]) {
      if (!fs.existsSync(p)) throw new Error(`TLS 文件不存在：${p}`);
    }
  }
  for (const key of ['maxUploadMB', 'rateLimitPerMin', 'authFailsPerMin', 'banMinutes', 'rangeFallbackMB', 'tailscaleHttpsPort']) {
    if (!Number.isFinite(cfg[key]) || cfg[key] < 0) {
      throw new Error(`${key} 必须是 >= 0 的数值，当前：${cfg[key]}`);
    }
  }
  if (typeof cfg.comfyuiLaunch !== 'string' || typeof cfg.comfyuiCwd !== 'string') {
    throw new Error('comfyuiLaunch 与 comfyuiCwd 必须是字符串（启动命令与工作目录）');
  }
}

/**
 * 常量时间比较两个 token（先做 SHA-256 摘要避免长度差导致的短路）。
 * @param {string} expected 配置中的正确 token
 * @param {string} provided 请求方提交的 token
 */
export function tokenMatches(expected, provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(provided).digest();
  return crypto.timingSafeEqual(a, b);
}

/** 从 CLI 参数表提取 `--key=value` 覆盖项。 */
export function parseArgOverrides(argv) {
  const overrides = {};
  for (const arg of argv) {
    const match = /^--([a-zA-Z-]+)=(.*)$/.exec(arg);
    if (!match) continue;
    const [, key, raw] = match;
    if (key === 'tls-cert' || key === 'tls-key') {
      overrides.tls = { ...(overrides.tls || {}), [key === 'tls-cert' ? 'cert' : 'key']: raw };
    } else {
      overrides[key] = raw;
    }
  }
  return overrides;
}
