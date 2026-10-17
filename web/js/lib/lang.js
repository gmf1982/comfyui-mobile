/**
 * 应用语言：优先读本机已保存的设置，其次按浏览器语言选择。
 * 独立成模块，供 api/i18n/workflow-form 等底层模块引用，避免 api → i18n → state → api 循环依赖。
 */
const SETTINGS_KEY = 'cm_settings';

function storedLang() {
  try {
    const settings = JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) ?? '{}');
    if (settings.lang === 'en' || settings.lang === 'zh') return settings.lang;
  } catch {
    // 存储不可用/内容损坏：回退浏览器语言
  }
  return null;
}

function browserLang() {
  // Node（单元测试）没有 window：保持中文默认，避免测试环境差异
  if (typeof window === 'undefined') return 'zh';
  const language = String(globalThis.navigator?.language ?? '').toLowerCase();
  if (!language) return 'zh';
  return language.startsWith('zh') ? 'zh' : 'en';
}

let current = storedLang() ?? browserLang();

export function getLang() {
  return current;
}

/** 切换语言；持久化由设置页的 saveSettings 负责。 */
export function setLang(lang) {
  current = lang === 'en' ? 'en' : 'zh';
}
