/**
 * 服务端文案语言：优先读手机端 api() 发来的 X-App-Lang，其次 Accept-Language。
 * 未带任何语言信息时保持中文，兼容既有测试与旧客户端。
 */
export function reqLang(req) {
  const direct = String(req?.headers?.['x-app-lang'] ?? '').toLowerCase();
  if (direct === 'en' || direct === 'zh') return direct;
  const accept = String(req?.headers?.['accept-language'] ?? '').toLowerCase();
  return accept.startsWith('en') ? 'en' : 'zh';
}

/** 从 zh/en 两条文案中按语言选取。 */
export function pick(lang, zh, en) {
  return lang === 'en' ? en : zh;
}
