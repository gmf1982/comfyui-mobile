/**
 * 隐私自检：扫描受版本控制的文件，发现本机标识或密钥就报错。
 *
 * 用途：防止把个人环境信息（机器名、tailnet、本机路径、用户名、令牌）提交进仓库。
 * 检测模式来自两个来源：
 *   1) 不入库的 `.privacy-patterns`（每行一条，可用 # 注释）——放你自己的环境标识
 *   2) 内置规则：当前 config.json 里的令牌、常见密钥形状、Windows 用户目录
 *
 * 用法：
 *   node scripts/check-privacy.mjs        # 只扫描受控文件
 *   npm test                              # 该检查已并入测试套件
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 读取受版本控制的文件清单（相对仓库根的路径）。 */
function trackedFiles() {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  const out = execFileSync('git', ['ls-files', '-z', '--', projectRoot], { cwd: repoRoot, encoding: 'utf8' });
  return { repoRoot, files: out.split('\0').filter(Boolean) };
}

/** 自定义敏感词（本机标识），来自不入库的 .privacy-patterns。 */
function customPatterns() {
  const file = path.join(projectRoot, '.privacy-patterns');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/** 内置规则：当前令牌 + 常见密钥形状（避免把真实值写进本文件）。 */
function builtinPatterns() {
  const patterns = [];
  const cfgPath = path.join(projectRoot, 'server', 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const token = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).token;
      if (token && token.length >= 16) patterns.push(token);
    } catch { /* 配置损坏时跳过 */ }
  }
  // Windows 用户目录路径：用户名部分只匹配 ASCII 实值，避免文档里的 <用户名> 占位符误报
  patterns.push('C:\\\\Users\\\\[A-Za-z0-9._-]+');
  patterns.push('/home/[a-zA-Z0-9._-]+/');          // Linux 家目录（同上，仅 ASCII 实值）
  patterns.push('sk-[A-Za-z0-9]{20,}');             // 常见 API key 形状
  return patterns;
}

function main() {
  const { repoRoot, files } = trackedFiles();
  const patterns = [...customPatterns(), ...builtinPatterns()];
  if (!patterns.length) {
    console.log('[privacy] 没有配置检查模式，跳过');
    return 0;
  }
  const re = new RegExp(patterns.join('|'));
  const hits = [];
  for (const rel of files) {
    const abs = path.resolve(repoRoot, rel);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // 二进制或不可读文件跳过
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  if (hits.length) {
    console.error('[privacy] 受控文件中发现本机标识或密钥，请先移除：');
    for (const h of hits.slice(0, 30)) console.error('  ' + h);
    if (hits.length > 30) console.error(`  …还有 ${hits.length - 30} 处`);
    console.error('提示：把这类值写进不入库的「本地备注.md」或 .privacy-patterns。');
    return 1;
  }
  console.log('[privacy] 受控文件未发现本机标识或密钥 ✓');
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exit(main());
}

export { main as checkPrivacy };
