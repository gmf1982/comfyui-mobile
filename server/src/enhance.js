/**
 * LLM 提示词增强：调用 OpenAI 兼容的 chat/completions 端点为提示词做智能扩写。
 * 同一套客户端同时覆盖：在线（智谱开放平台 open.bigmodel.cn/api/paas/v4）与
 * 本地（Ollama http://127.0.0.1:11434/v1、llama.cpp 含多模型路由模式、LM Studio 等）。
 * API Key 只保存在网关配置里，永不下发手机端；未配置时网关回 501，手机端回退内置规则增强。
 */

/**
 * 单次增强的默认硬超时，可被 promptLlm.models 条目的可选 timeoutMs（毫秒）按模型覆盖。
 * 本地 llama.cpp 路由（--models-max 1）按需换装模型，冷加载 27B 级 GGUF 可能
 * 需要一两分钟；思考型模型还要先耗完思考预算再出正文，因此大模型条目应放宽 timeoutMs。
 */
const TIMEOUT_MS = 90000;

/**
 * 检测小模型常见的"复读机"退化输出：同一短片段（≤6 字，如"海浪"）出现 ≥4 次即判退化。
 * 长片段重复可能是排比修辞，不判。退化时调用方按失败处理（手机端自动回退规则增强），
 * 绝不能把这种结果替换进输入框。
 */
export function isDegenerate(text) {
  const parts = String(text).split(/[，。,.;；、\s]+/).filter(Boolean);
  const counts = new Map();
  for (const p of parts) counts.set(p, (counts.get(p) ?? 0) + 1);
  for (const [seg, n] of counts) {
    if (n >= 4 && seg.length <= 6) return true;
  }
  return false;
}

/**
 * 构造系统提示词。原则借鉴 Z-image-prompt-builder 的 PE 约束：
 * 核心不可变（用户已写明的要素不得改写替换），只补缺失的外围信息，直接输出提示词本身。
 * @param {string} profileKey 模型档案 key（qwen/zimage/krea/h3/generic）
 * @param {string} mode t2i | edit | video
 * @returns {string}
 */
export function buildSystemPrompt(profileKey, mode) {
  const isEdit = mode === 'edit';
  const base = '你是图像/视频生成提示词增强助手。用户给出一句原始提示词，你输出增强后的完整提示词。规则：'
    + '1) 用户已写明的主体、场景、动作、风格、衣物等细节一律保留原意原词，不得替换成别的场景或风格；'
    + (isEdit
      // 编辑指令是操作说明：编辑模型看得到原图，替它虚构画面细节只会得到跑题结果。
      ? '2) 这是给图像编辑模型的操作指令，不是画面描述：只把编辑操作本身写清楚（改什么/加什么/删什么/往哪个方向扩展），'
        + '严禁编造画面里没有的具体环境、人物、物体或光线；要写明其余内容保持原样、改动边缘与原图过渡自然；'
      : '2) 只补充缺失的细节（外观/材质/环境层次/光线/构图/氛围），补充内容必须与已有内容一致、不得冲突；')
    + '3) 不写解释、不写标题、不加引号，只输出提示词本身；'
    + '4) 控制在 120 字以内；'
    + '5) 严禁复读：同一个词全句最多出现一次，不要罗列堆砌，写成一至三句通顺的自然语言。';
  const byMode = mode === 'video'
    ? ' 这是视频提示词：按「主体+动作+镜头运动+氛围」组织，动作连贯可实现，约 6-10 秒的镜头。'
    : isEdit
      ? ' "扩展图片/扩图/外扩"类指令只输出扩图指令本身：将画面向外扩展，新增区域延续原图内容、风格与光线，衔接自然，不添加任何新场景细节。'
      : '';
  const byModel = {
    qwen: isEdit ? ' 目标模型 Qwen-Image 编辑版：用中文自然句写指令。' : ' 目标模型 Qwen-Image 2.1：用中文自然长句，细节丰富，不必中英混排。',
    zimage: ' 目标模型 Z-Image：用中文自然语言，简洁直接，不堆砌形容词。',
    krea: isEdit ? ' 目标模型 FLUX.2 Krea 编辑：输出英文编辑指令，写明改动，结尾强调 keep everything else unchanged。' : ' 目标模型 FLUX.2 Krea：输出英文自然段落（摄影描述风格），不要 tag 堆砌，不要 masterpiece 类空洞词。',
    h3: ' 目标模型 MiniMax H3 视频生成：中文，导演视角描述。',
    generic: ' 目标模型未知：沿用用户的主要语言。',
  }[profileKey] ?? ' 目标模型未知：沿用用户的主要语言。';
  return base + byMode + byModel;
}

/**
 * 调用 OpenAI 兼容 chat/completions 生成增强提示词。
 * @param {{baseUrl: string, apiKey?: string, model: string, timeoutMs?: number}} llm 网关 promptLlm 配置
 * @param {{text: string, profileKey: string, mode: string}} input
 * @returns {Promise<{text: string}>}
 */
export async function enhanceWithLlm(llm, { text, profileKey, mode }) {
  const url = `${String(llm.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: llm.model,
      temperature: 0.6,
      // 抗重复：小模型（270M 级）不加惩罚会输出"海浪，海浪，海浪…"式复读
      frequency_penalty: 0.4,
      presence_penalty: 0.3,
      // 思考型模型（如 reasoning 预算 2048 的本地路由预设）会先耗思考 token 再出正文，
      // 上限太小会让正文为空；思考段由下方剥除逻辑处理，不会进入结果。
      max_tokens: 3000,
      messages: [
        { role: 'system', content: buildSystemPrompt(profileKey, mode) },
        { role: 'user', content: text },
      ],
    }),
    signal: AbortSignal.timeout(Number(llm.timeoutMs) || TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`LLM 端点返回 ${res.status}${detail ? `：${detail}` : ''}`);
  }
  const data = await res.json();
  let out = data?.choices?.[0]?.message?.content;
  if (typeof out !== 'string' || !out.trim()) throw new Error('LLM 返回内容为空');
  // qwen3 等思考型模型会先输出 <think>…</think> 推理段，剥掉只留正文。
  // llama.cpp 路由开推理解析时可能吞掉开标签、只在正文残留闭合标签，
  // 此时闭标签之前整段都是思考残段，一并剥掉。
  out = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  out = out.replace(/^[\s\S]*?<\/think>/, '').trim();
  // 剥掉模型可能套上的 Markdown 围栏与首尾引号。
  // 注意：这里刻意不用含反引号的正则字面量——web 前端守卫测试的字符串/正则两段式
  // 剥离器会被正则里的反引号打乱（服务端模块同样保持一致，降低认知负担）。
  const fence = '```';
  out = out.trim();
  if (out.startsWith(fence)) {
    const nl = out.indexOf('\n');
    out = nl === -1 ? '' : out.slice(nl + 1);
  }
  if (out.endsWith(fence)) out = out.slice(0, -fence.length);
  out = out.replace(/^["“”']+|["“”']+$/g, '').trim();
  if (isDegenerate(out)) throw new Error('模型输出重复退化');
  return { text: out };
}
