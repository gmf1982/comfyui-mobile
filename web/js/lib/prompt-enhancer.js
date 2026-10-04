/**
 * 规则式提示词增强引擎：不用任何 LLM，只靠词库 + 句式模板 + 模型档案。
 * 设计前提：Qwen-Image 2.1 / Z-Image / MiniMax H3 原生理解中文，增强即在中文里
 * 结构化扩写，无需翻译；只有 FLUX 系（Krea）需要英文自然段落，走内置小词典尽力
 * 翻译，未命中的词原样保留并提示手动润色。
 * 随机词池让同一句提示词可以"换一版"，输出始终可再手改。
 */

// ---------------- 模型识别 ----------------

/** 模型档案：lang 决定增强输出语言；label 用于界面展示。 */
export const MODEL_PROFILES = {
  qwen: { label: 'Qwen-Image 2.1', lang: 'zh' },
  zimage: { label: 'Z-Image', lang: 'zh' },
  krea: { label: 'FLUX.2 Krea', lang: 'en' },
  h3: { label: 'MiniMax H3 视频', lang: 'zh' },
  generic: { label: '通用', lang: 'zh' },
};

/** 识别顺序即优先级：视频工作流也可能引用图片文件，h3 先判。 */
const DETECT_RULES = [
  ['h3', /minimax|mmh3|[_-]h3|h3[_-]/i],
  ['krea', /krea/i],
  ['qwen', /qwen/i],
  ['zimage', /z[-_ ]?image/i],
];

/** 扫描工作流 JSON（模型文件名/节点类名）判断使用中的模型。 */
export function detectModelProfile(wfJson) {
  const s = JSON.stringify(wfJson ?? '').toLowerCase();
  for (const [key, re] of DETECT_RULES) {
    if (re.test(s)) return key;
  }
  return 'generic';
}

/** 工作流里有图片输入节点 → 图生图/编辑；视频模型 → 视频；其余文生图。 */
export function detectMode(wfJson, profileKey) {
  if (profileKey === 'h3') return 'video';
  const s = JSON.stringify(wfJson ?? '');
  // 不写 "return /re/i.test(s)"：return 后的正则会绕过前端守卫测试的剥离启发式
  const hasImageInput = /loadimage/i.test(s);
  return hasImageInput ? 'edit' : 't2i';
}

// ---------------- 中文扩写词池 ----------------

const pick = (arr, used) => {
  const fresh = used ? arr.filter((x) => !used.has(x)) : arr;
  const pool = fresh.length ? fresh : arr;
  const word = pool[Math.floor(Math.random() * pool.length)];
  used?.add(word);
  return word;
};

const QUALITY_ZH = ['画质细腻锐利', '细节丰富', '专业摄影级画质', '8K 高清分辨率', '整体质感精致'];
const LIGHTING_ZH = ['柔和的自然光', '金色黄昏光线', '电影感侧逆光', '干净的影棚布光', '清晨薄雾中的柔光', '明暗对比柔和的窗光'];
const COMPOSITION_ZH = ['特写镜头', '中景构图', '低角度仰拍', '浅景深背景虚化', '三分法构图', '居中对称构图', '略带俯视的视角', '85mm 人像镜头的空气感虚化', '35mm 纪实视角'];
const TONE_ZH = ['暖色调', '清冷的蓝调', '复古胶片色', '清新明快的配色', '高级的莫兰迪配色'];
const MOOD_ZH = ['宁静的氛围', '充满故事感', '梦幻唯美', '真实自然的纪实感', '治愈系的松弛感'];

/** 主体类别：关键词命中后用专属细节/动作/环境池，未命中走通用池。 */
const SUBJECT_CLASSES_ZH = [
  {
    re: /猫|狗|犬|兔子|鸟|鹦鹉|老虎|狮子|狐狸|鹿|马|熊猫|仓鼠|鱼|龙|狼|蝴蝶|猫头鹰|宠物/,
    detail: ['毛发光泽分明、根根清晰', '眼神灵动有神', '姿态放松自然', '皮毛纹理清晰可见'],
    action: ['慵懒地趴在窗台上', '好奇地望向镜头', '在草地上轻快奔跑', '安静地蜷缩着身体'],
    env: ['洒满阳光的窗台', '开满野花的草地', '温馨的室内角落', '秋日落叶的小径'],
  },
  {
    re: /女孩|男孩|女生|男生|少女|女人|男人|姑娘|女士|老人|小孩|孩子|婴儿|模特|公主|王子|武士|侠客|学生|医生|厨师|舞者|cos/i,
    detail: ['五官清晰、皮肤质感真实', '发型层次分明', '服装材质纹理细腻', '神态自然生动'],
    action: ['微微侧头看向镜头', '露出自信的微笑', '静静伫立在风中', '伸手轻触身边的物件'],
    env: ['城市街角的咖啡馆', '洒满阳光的房间', '樱花盛开的树下', '黄昏时分的海边栈道'],
  },
  {
    re: /蛋糕|咖啡|奶茶|拉面|寿司|水果|汉堡|甜点|面包|茶|酒|菜|美食|冰淇淋|巧克力/,
    detail: ['食物质感细腻诱人', '表面光泽与热气清晰可见', '摆盘精致有层次'],
    action: ['静置于桌面中央', '冒着微微热气', '刚摆盘完成的状态'],
    env: ['木质餐桌', '极简风格的餐台', '窗边明亮的位置'],
  },
  {
    re: /城市|森林|海滩|海边|雪山|街道|房间|寺庙|城堡|花园|湖泊|山|日落|日出|星空|瀑布|沙漠|田野|古镇|夜景/,
    detail: ['空间层次分明，远景近景过渡自然', '光线方向明确，明暗过渡柔和', '细节密度高且不杂乱'],
    action: ['画面静谧仿佛时间放缓', '云影缓缓流动'],
    env: ['空气中有轻微的雾气层次', '前景有自然的引导线条'],
  },
  {
    re: /手机|球鞋|手表|香水|椅子|灯具|包装|瓶子|耳机|键盘|相机|包|产品/,
    detail: ['产品棱线清晰、材质质感真实', '表面反光干净利落', 'logo 与细节清晰对焦'],
    action: ['静置展示', '悬浮于纯色背景前'],
    env: ['纯净的影棚背景', '与产品气质相符的极简台面'],
  },
  {
    re: /汽车|摩托|自行车|火车|飞机|船|飞船|机器人/,
    detail: ['车身高光与反射真实', '机械细节精密', '漆面质感出色'],
    action: ['静止姿态', '行驶中带轻微动态模糊'],
    env: ['城市夜景街道', '开阔的公路', '雨后反光的路面'],
  },
  {
    re: /.*/,
    detail: ['主体细节丰富清晰', '材质与纹理刻画细腻', '主体突出、背景简洁不抢戏'],
    action: ['自然舒展的状态', '安静的瞬间'],
    env: ['与主体气质相符的环境', '有空间纵深感的背景'],
  },
];

// ---------------- Krea（英文自然段）小词典与词池 ----------------

/** 中→英精编词典：整句优先、贪心最长匹配；覆盖高频主体/颜色/服饰/风格词。 */
const ZH_EN_DICT = {
  '一只猫': 'a cat', '一只狗': 'a dog', '一个女孩': 'a girl', '一个男孩': 'a boy',
  '一个女人': 'a woman', '一个男人': 'a man', '一位老人': 'an elderly person', '一个小孩': 'a child',
  '一只': 'a', '一头': 'a', '一个': 'a', '一条': 'a', '一朵': 'a', '一座': 'a', '一辆': 'a',
  '猫': 'cat', '狗': 'dog', '兔子': 'rabbit', '鸟': 'bird', '老虎': 'tiger', '狮子': 'lion',
  '狐狸': 'fox', '鹿': 'deer', '马': 'horse', '熊猫': 'panda', '狼': 'wolf', '蝴蝶': 'butterfly',
  '女孩': 'girl', '男孩': 'boy', '女人': 'woman', '男人': 'man', '少女': 'young girl',
  '老人': 'elderly person', '小孩': 'child', '孩子': 'child', '模特': 'model', '舞者': 'dancer',
  '红色': 'red', '蓝色': 'blue', '白色': 'white', '黑色': 'black', '黄色': 'yellow',
  '绿色': 'green', '粉色': 'pink', '紫色': 'purple', '金色': 'golden', '银色': 'silver', '灰色': 'gray',
  '衣服': 'clothes', '连衣裙': 'dress', '裙子': 'skirt', '外套': 'jacket', '衬衫': 'shirt',
  '帽子': 'hat', '眼镜': 'glasses', '围巾': 'scarf', '鞋': 'shoes', '靴子': 'boots',
  '穿': 'wearing', '戴着': 'wearing', '拿着': 'holding', '坐着': 'sitting', '站着': 'standing',
  '走着': 'walking', '跑步': 'running', '微笑': 'smiling', '大笑': 'laughing', '哭': 'crying',
  '在': 'in', '上面': 'on', '里面': 'inside', '旁边': 'beside', '前面': 'in front of', '后面': 'behind',
  '窗台': 'windowsill', '桌子': 'table', '椅子': 'chair', '床': 'bed', '沙发': 'sofa',
  '房间': 'room', '厨房': 'kitchen', '花园': 'garden', '街道': 'street', '城市': 'city',
  '森林': 'forest', '海滩': 'beach', '海边': 'seaside', '雪山': 'snow mountain', '湖泊': 'lake',
  '草地': 'meadow', '天空': 'sky', '云': 'clouds', '雨': 'rain', '雪': 'snow', '雾': 'mist',
  '日落': 'sunset', '日出': 'sunrise', '夜晚': 'night', '白天': 'daytime', '黄昏': 'dusk', '清晨': 'early morning',
  '春天': 'spring', '夏天': 'summer', '秋天': 'autumn', '冬天': 'winter',
  '照片': 'photo', '肖像': 'portrait', '特写': 'close-up', '风景': 'landscape',
  '电影感': 'cinematic', '写实': 'photorealistic', '卡通': 'cartoon style', '动漫': 'anime style',
  '水彩': 'watercolor', '油画': 'oil painting', '赛博朋克': 'cyberpunk', '蒸汽朋克': 'steampunk',
  '复古': 'vintage', '极简': 'minimalist', '梦幻': 'dreamy', '温馨': 'cozy',
  '蛋糕': 'cake', '咖啡': 'coffee', '奶茶': 'milk tea', '水果': 'fruit', '面包': 'bread',
  '花': 'flower', '玫瑰': 'rose', '树': 'tree', '叶子': 'leaf', '书': 'book', '手机': 'smartphone',
  '汽车': 'car', '自行车': 'bicycle', '飞机': 'airplane', '船': 'boat', '火车': 'train',
  '和': 'and', '与': 'and', '的': '', '了': '', '正在': '', '非常': '', '很': '',
  '把': '', '将': '', '给': '', '她': 'the woman', '他': 'the man', '它': 'it',
  '换成': 'into', '换为': 'into', '改成': 'into', '变成': 'into', '变成': 'into',
  '上': 'on', '里': 'in', '外面': 'outside', '下面': 'under',
};

/** Krea 英文词池（主体类别归并为动物/人物/通用三档，够用且可控）。 */
const EN_POOLS = {
  lighting: ['soft natural light', 'golden hour backlight', 'cinematic rim lighting', 'clean studio lighting', 'moody low-key lighting', 'gentle window light'],
  composition: ['close-up shot', 'medium shot', 'low angle view', 'shallow depth of field with creamy bokeh', 'wide angle view', 'centered symmetrical framing', '85mm portrait lens with soft separation', '35mm documentary perspective'],
  tone: ['warm tones', 'cool blue tones', 'vintage film colors', 'muted morandi palette'],
  quality: ['highly detailed', 'photorealistic', 'sharp focus', 'professional photography', 'rich textures'],
  classes: [
    {
      re: /cat|dog|rabbit|bird|tiger|lion|fox|deer|horse|panda|wolf|butterfly/,
      detail: ['glossy well-defined fur', 'expressive lively eyes', 'relaxed natural posture'],
      action: ['lounging lazily', 'looking curiously at the camera', 'resting quietly curled up'],
      env: ['on a sunlit windowsill', 'in a flower meadow', 'in a cozy indoor corner'],
    },
    {
      re: /girl|boy|woman|man|person|child|model|dancer|elderly/,
      detail: ['clear facial features with realistic skin texture', 'naturally styled hair', 'expressive natural gaze'],
      action: ['looking slightly toward the camera', 'smiling with confidence', 'standing quietly in the breeze'],
      env: ['in a city cafe corner', 'in a sunlit room', 'under blooming cherry trees'],
    },
    {
      re: /.*/,
      detail: ['rich fine detail on the subject', 'clean uncluttered background', 'strong subject presence'],
      action: ['in a natural relaxed state', 'captured in a quiet moment'],
      env: ['in a fitting environment', 'against a background with gentle depth'],
    },
  ],
};

// ---------------- 视频词池（MiniMax H3） ----------------

const VIDEO_MOTION_ZH = {
  animal: ['它轻轻摇动尾巴，缓慢踱步', '它懒洋洋地伸了个懒腰', '它转头望向远方，耳朵微微抖动'],
  person: ['她/他缓缓转身面向镜头', '轻轻拨动头发，嘴角上扬', '缓步向前走，衣角随风轻摆'],
  scene: ['云层缓缓流动，光影在地面推移', '水面泛起细碎波纹', '树叶随风轻晃，光斑闪烁'],
  generic: ['主体动作缓慢连贯，细节有轻微动态', '主体自然地小幅度活动，姿态流畅'],
};
const VIDEO_CAMERA_ZH = ['镜头缓慢推近', '镜头缓慢拉远', '镜头围绕主体缓慢环绕', '固定机位，画面稳定', '镜头随主体轻微跟随移动'];

// ---------------- 工具 ----------------

const firstSegment = (text) => {
  const m = /^(.+?)[，。,.；;！!？?\n]/.exec(text.trim());
  return (m ? m[1] : text.trim()).trim();
};

const HAS_CN_RE = /[\u4e00-\u9fa5]/;

const hasChinese = (s) => HAS_CN_RE.test(s);

/** 贪心最长匹配翻译：整段命中优先；返回译文与是否仍有中文残留。 */
function translateToEn(text) {
  let out = text;
  const keys = Object.keys(ZH_EN_DICT).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (out.includes(key)) out = out.split(key).join(` ${ZH_EN_DICT[key]} `);
  }
  out = out.replace(/\s+/g, ' ').replace(/\s([,.!?])/g, '$1').trim();
  out = out.replace(/\s+(?:on|in|at|of|with)$/i, '').trim();
  return { text: out, restChinese: hasChinese(out) };
}

/** Krea 的编辑指令兜底：整句尽力翻译 + "只改此处"英文保留条款。 */
const EDIT_KEEP_EN = 'Keep everything else unchanged: the subject identity, face, pose, background, lighting direction and overall composition stay exactly the same; blend the edit seamlessly and match the original image style and quality.';

function enhanceEditEn(raw, rand) {
  const { text: en } = translateToEn(raw.trim().replace(/[。.]$/, ''));
  return `${en}. ${EDIT_KEEP_EN}`;
}

function classify(raw, classes) {
  for (const cls of classes) {
    if (cls.re.test(raw)) return cls;
  }
  return classes[classes.length - 1];
}

/** 去掉与原文重复的词。 */
const dedupe = (raw, parts) => parts.filter((p) => p && !raw.includes(p));

// ---------------- 三种增强模板 ----------------

/** 原文已写明环境/场景（海、沙滩、街道…）时不再补环境句、并剔除室内布光类词，避免与场景冲突。 */
const SCENE_RE = /海|沙滩|海边|椰林|森林|街道|房间|室内|花园|雪山|湖|山上|山间|日落|日出|城市|公园|沙漠|田野|古镇|夜景|天空|云端|寺庙|城堡|咖啡馆|草原|峡谷|瀑布|星空/;

/** 文生图：主体句原样保留 + 按主体类别补细节/动作/环境 + 光线/构图/色调/氛围/画质（中文）。 */
function enhanceT2I(raw, rand) {
  const subject = firstSegment(raw);
  const cls = classify(raw, SUBJECT_CLASSES_ZH);
  const sceneDescribed = SCENE_RE.test(raw);
  const lightingPool = sceneDescribed ? LIGHTING_ZH.filter((x) => !/影棚|室内|窗光/.test(x)) : LIGHTING_ZH;
  const parts = dedupe(raw, [
    pick(cls.detail, rand),
    pick(cls.action, rand),
    ...(sceneDescribed ? [] : [pick(cls.env, rand)]),
    pick(lightingPool, rand),
    pick(COMPOSITION_ZH, rand),
    pick(TONE_ZH, rand),
    pick(MOOD_ZH, rand),
    pick(QUALITY_ZH, rand),
  ]);
  return `${subject}，${parts.join('，')}。`;
}

/** 图生图/编辑：识别"替换/换成/改成"与"去掉/删除"两类句式 → 改动 + 其余保持不变的模板。 */
function enhanceEdit(raw) {
  const t = raw.trim();
  // 扩图/外扩（outpaint）：扩展区域没有可写的具体内容，输出纯扩图指令，不虚构新增区域画面。
  const expand = /扩图|外扩|出画|扩大画面|扩大图片|扩展/.exec(t);
  if (expand) {
    return '将画面向外扩展（outpaint），扩展方向延续原图场景：新增区域与原图的内容、风格、光线、透视自然衔接，过渡无痕迹，其余内容保持不变，整体仍是一张完整协调的图。';
  }
  const removal = /(?:把|将|给)?\s*(?:图[片像]?\d{0,2}中?)?\s*([^，。,]+?)\s*(?:去掉|删除|移除|除去)/.exec(t);
  if (removal) {
    return `把${removal[1].trim()}从图中移除，其余内容保持不变，被移除的区域由周围内容自然延续填补，光影与透视和原图一致，不留修补痕迹。`;
  }
  const change = /(?:替换|换成|换为|改成|改为|涂|染)(?:成|为|上|作)?\s*([^，。,.;；]+)/.exec(t);
  if (change) {
    const target = change[1].trim();
    // 动词紧跟在宾语后：先试"X的Y"（人物的衣服），再退回无"的"短语（图片1中天空）。
    // Y 用懒匹配并让动词紧跟其后（锚定 lookahead），防止把动词首字（"替换"的"替"）吃进对象名。
    const withDe = /(?:把|将|给)?(?:图[片像]?\d{0,2}中?)?([\u4e00-\u9fa5A-Za-z0-9]{1,8})的([\u4e00-\u9fa5]{1,6}?)(?=(?:都|全部)?(?:替换|换成|换为|改成|改为|涂|染))/.exec(t);
    const bare = /(?:把|将|给)?\s*(?:图[片像]?\d{0,2}中?)?\s*([^，。,]{1,16}?)(?=(?:都|全部)?(?:替换|换成|换为|改成|改为|涂|染))/.exec(t);
    const focus = withDe ? `图中${withDe[1]}的${withDe[2]}`
      : bare?.[1]?.trim() ? `图中${bare[1].trim()}` : '指定区域';
    return `把${focus}改为${target}。其余内容保持不变：人物的长相、身份、表情、姿势、背景、光线方向与整体构图完全保留，仅修改上述内容，改动边缘过渡自然、光影与原图一致，保持相同的图像风格与画质。`;
  }
  const tail = /[。.！!？?]$/.test(t) ? '' : '。';
  return `${t}${tail}其余内容保持不变：仅按上述描述调整，人物的长相、身份、姿势、背景与构图尽量保留，改动边缘过渡自然、光影与原图一致。`;
}

/** 视频（H3）：主体 + 动作 + 镜头运动 + 氛围的中文分段描述。 */
function enhanceVideo(raw, rand) {
  const subject = firstSegment(raw);
  const clsKey = /猫|狗|兔子|鸟|老虎|动物|宠物|狮子|狐狸|鹿|马|熊猫|狼/.test(raw) ? 'animal'
    : /女孩|男孩|女人|男人|人|少女|老人|小孩|模特|舞者/.test(raw) ? 'person'
      : /城市|森林|海滩|雪山|街道|天空|湖|山|夜景|日出|日落/.test(raw) ? 'scene' : 'generic';
  const motionPool = VIDEO_MOTION_ZH[clsKey] ?? VIDEO_MOTION_ZH.generic;
  const parts = dedupe(raw, [
    pick(motionPool, rand),
    pick(VIDEO_CAMERA_ZH, rand),
    pick(LIGHTING_ZH, rand),
    pick(MOOD_ZH, rand),
  ]);
  return `${subject}，${parts[0]}。${parts.slice(1).join('，')}。整体节奏舒缓，动作自然连贯。`;
}

/** Krea：英文自然段。先尽力翻译原文，再套英文词池；翻不出中文时原样保留并提示。 */
function enhanceKrea(raw, rand) {
  const subject = firstSegment(raw);
  const { text: enSubject, restChinese } = translateToEn(subject);
  const cls = classify(enSubject.toLowerCase(), EN_POOLS.classes);
  const sentence = [
    `A photo of ${enSubject}`,
    pick(cls.detail, rand),
    pick(cls.action, rand),
    pick(cls.env, rand),
    pick(EN_POOLS.lighting, rand),
    pick(EN_POOLS.composition, rand),
    pick(EN_POOLS.tone, rand),
    pick(EN_POOLS.quality, rand),
  ].join(', ');
  const notes = restChinese ? ['部分词不在内置英词库中，已原样保留，请手动润色'] : [];
  return { text: `${sentence}.`, notes };
}

/**
 * 增强主入口。
 * @param {{text: string, profileKey?: string, mode?: string}} options
 * @returns {{text: string, notes: string[], profileKey: string, mode: string}}
 */
export function enhancePrompt({ text, profileKey = 'generic', mode }) {
  const raw = String(text ?? '').trim();
  if (!raw) return { text: '', notes: [], profileKey, mode };
  const rand = new Set();
  const lang = MODEL_PROFILES[profileKey]?.lang ?? 'zh';
  let result;
  const notes = [];
  if (mode === 'video') {
    result = enhanceVideo(raw, rand);
    notes.push('已按视频模板增强（主体/动作/镜头/氛围）');
  } else if (mode === 'edit') {
    result = profileKey === 'krea' ? enhanceEditEn(raw, rand) : enhanceEdit(raw);
    notes.push('已套用"只改此处、其余保持不变"编辑模板');
    if (profileKey === 'krea' && hasChinese(result)) notes.push('部分词不在内置英词库中，已原样保留，请手动润色');
  } else if (lang === 'en') {
    const r = enhanceKrea(raw, rand);
    result = r.text;
    notes.push(...r.notes);
  } else {
    result = enhanceT2I(raw, rand);
    notes.push('已按当前模型补充细节/环境/光线/构图/画质');
  }
  return { text: result, notes, profileKey, mode };
}
