/**
 * 应用图标已改为设计稿导出的静态资源（2026-10）：
 *   web/icons/icon-192.png / icon-512.png —— 应用图标（manifest、favicon、apple-touch-icon）
 *   web/icons/tab-*.png —— 底部导航 5 个图标
 * 旧的纯 Node 生成逻辑已移除，避免重跑时用旧图案覆盖新资源；旧实现见 git 历史。
 */
console.warn('[gen-icons] 图标现为静态资源，跳过生成。旧生成脚本请查 git 历史。');
