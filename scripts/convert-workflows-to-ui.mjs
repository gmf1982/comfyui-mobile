#!/usr/bin/env node
/**
 * userdata 工作流迁移工具（一次性）。
 *
 * 背景：手机端以前按 API/prompt 格式保存工作流，桌面 ComfyUI 把它当 UI 图解析、
 * 缺 nodes/links 被兜底成空画布。现在手机端保存改用桌面 UI 图格式
 * （web/js/lib/graph.js 的 apiToUi），本脚本处理存量文件：
 *
 * - convert      API → UI 逐文件转换。每个文件先做「API→UI→API」round-trip 校验，
 *                原值全部保留才改写；原文件备份到 <目录>_api_backup/（保持相对路径）。
 * - patch-qwen21 给 TextEncodeQwenImage21 直连 LoadImage 的工作流插入
 *                ImageScaleToTotalPixels（lanczos / 2MP）预缩放。该编码节点在
 *                「输入尺寸 == 内部目标尺寸」时会跳过重采样（comfy_extras/nodes_qwen.py
 *                的不动点短路），回灌自己的 1MP 输出时逐像素重编码，高频噪声逐轮
 *                累积（斑点/过锐/高对比）；预缩放到 2MP 保证每轮必经 lanczos 重采样。
 *
 * 用法：node scripts/convert-workflows-to-ui.mjs <convert|patch-qwen21> [workflowsDir]
 *       默认目录 <工作流目录>；object_info 取自 127.0.0.1:8188。
 */
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { apiToUi } from '../web/js/lib/graph.js';
import { convertUiToApi, detectFormat, listApiNodes } from '../web/js/lib/workflow-form.js';

const DEFAULT_DIR = '<工作流目录>';
const OBJINFO_URL = process.env.COMFYUI_OBJINFO_URL ?? 'http://127.0.0.1:8188/object_info';

const norm = (x) => {
  if (Array.isArray(x)) return x.map(norm);
  if (x && typeof x === 'object') {
    const out = {};
    for (const k of Object.keys(x).sort()) out[k] = norm(x[k]);
    return out;
  }
  return x;
};

const deepEqual = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

/**
 * 逐节点校验 round-trip。apiToUi 会把节点 id 重编号为 1..N，所以先按确定性映射
 * （listApiNodes 序 → i+1）把 orig 的连线端点换算成新 id 再比对：
 * - 非连线输入：必须同值；
 * - 连线输入：必须等于 [新id, 槽位]；来源不在工作流里的悬空连线允许被丢弃；
 * - 转换后多出的键（schema 默认值）放行，仅提示；
 * - _meta.title 必须一致（缺省按 ''）。
 */
function roundTripDiff(orig, back) {
  const problems = [];
  const infos = [];
  const idMap = new Map(listApiNodes(orig).map((n, i) => [n.id, String(i + 1)]));
  const expectedInputs = (node) => {
    const inputs = {};
    for (const [name, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2) {
        const mapped = idMap.get(String(value[0]));
        inputs[name] = mapped === undefined ? null : [mapped, value[1]];
      } else {
        inputs[name] = value;
      }
    }
    return inputs;
  };
  const backNodes = listApiNodes(back);
  const unused = new Set(backNodes.map((n) => n.id));
  for (const node of listApiNodes(orig)) {
    const expected = expectedInputs(node);
    const candidates = backNodes.filter((n) => n.class_type === node.class_type && unused.has(n.id));
    let best = null;
    let bestScore = -1;
    for (const cand of candidates) {
      let score = 0;
      let ok = true;
      for (const [name, value] of Object.entries(expected)) {
        if (value === null) { // 悬空连线：必须被丢弃
          if (cand.inputs[name] !== undefined) { ok = false; break; }
          continue;
        }
        if (cand.inputs[name] === undefined || !deepEqual(cand.inputs[name], value)) { ok = false; break; }
        score++;
      }
      if (ok && score > bestScore) { best = cand; bestScore = score; }
    }
    if (!best) {
      const miss = candidates.length
        ? Object.entries(expected).find(([name, value]) => {
          return !candidates.some((c) => {
            if (value === null) return c.inputs[name] === undefined;
            return c.inputs[name] !== undefined && deepEqual(c.inputs[name], value);
          });
        })
        : null;
      problems.push(`#${node.id} ${node.class_type}: 无对应转换结果${miss ? `（输入 ${miss[0]} 不匹配）` : '（该类节点数量不一致）'}`);
      continue;
    }
    unused.delete(best.id);
    const backTitle = backNodes.find((n) => n.id === best.id)?.title ?? '';
    if ((node.title ?? '') !== backTitle) problems.push(`#${node.id} ${node.class_type}: 标题不一致（${node.title ?? ''} → ${backTitle}）`);
    for (const name of Object.keys(best.inputs)) {
      if (!(name in node.inputs)) infos.push(`#${node.id} ${node.class_type}: 转换后多出输入 ${name}（schema 默认值）`);
    }
  }
  for (const id of unused) problems.push(`多出节点 #${id} ${backNodes.find((n) => n.id === id)?.class_type}`);
  return { problems, infos };
}

async function listWorkflows(dir) {
  const entries = await readdir(dir, { recursive: true });
  return entries.filter((f) => f.toLowerCase().endsWith('.json')).sort();
}

async function backup(dir, rel) {
  const backupDir = `${dir}_api_backup`;
  const dest = join(backupDir, rel);
  await mkdir(dirnameOf(dest), { recursive: true });
  await copyFile(join(dir, rel), dest);
}

function dirnameOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i === -1 ? '.' : p.slice(0, i);
}

async function loadObjectInfo() {
  const res = await fetch(OBJINFO_URL);
  if (!res.ok) throw new Error(`object_info 拉取失败 HTTP ${res.status}（需要本机 ComfyUI 在运行）`);
  return res.json();
}

async function cmdConvert(dir, objInfo) {
  const files = await listWorkflows(dir);
  let converted = 0;
  let skipped = 0;
  let failed = 0;
  for (const rel of files) {
    let json;
    try {
      json = JSON.parse(await readFile(join(dir, rel), 'utf8'));
    } catch {
      console.log(`  × ${rel}: 不是合法 JSON，跳过`);
      skipped++;
      continue;
    }
    const format = detectFormat(json);
    if (format !== 'api') {
      console.log(`  − ${rel}: ${format === 'ui' ? '已是 UI 格式' : '无法识别'}，跳过`);
      skipped++;
      continue;
    }
    const classes = [...new Set(listApiNodes(json).map((n) => n.class_type))];
    const schemas = Object.fromEntries(classes.map((c) => [c, objInfo[c] ?? null]));
    const ui = apiToUi(json, schemas);
    const { workflow, warnings } = convertUiToApi(JSON.parse(JSON.stringify(ui)), schemas);
    const { problems, infos } = roundTripDiff(json, workflow);
    for (const w of warnings) infos.push(`转换警告: ${w}`);
    if (problems.length) {
      failed++;
      console.log(`  ! ${rel}: round-trip 校验未通过，未改写`);
      for (const p of problems.slice(0, 6)) console.log(`      ${p}`);
      continue;
    }
    await backup(dir, rel);
    await writeFile(join(dir, rel), `${JSON.stringify(ui, null, 2)}\n`, 'utf8');
    converted++;
    console.log(`  ✓ ${rel}: ${ui.nodes.length} 节点 / ${ui.links.length} 连线${infos.length ? `（${infos.length} 条默认值补齐）` : ''}`);
    for (const info of infos.slice(0, 4)) console.log(`      · ${info}`);
  }
  console.log(`\n完成：转换 ${converted}，跳过 ${skipped}，失败 ${failed}（备份在 ${dir}_api_backup/）`);
}

async function cmdPatchQwen21(dir) {
  const files = await listWorkflows(dir);
  let patched = 0;
  for (const rel of files) {
    let json;
    try {
      json = JSON.parse(await readFile(join(dir, rel), 'utf8'));
    } catch {
      continue;
    }
    if (detectFormat(json) !== 'api') continue;
    const changes = [];
    for (const [id, node] of Object.entries(json)) {
      if (node?.class_type !== 'TextEncodeQwenImage21') continue;
      for (const [name, v] of Object.entries(node.inputs ?? {})) {
        if (!name.startsWith('images.') || !Array.isArray(v) || v.length !== 2) continue;
        const src = json[String(v[0])];
        if (!src || src.class_type !== 'LoadImage') continue; // 已有缩放/非直连，不动
        const numeric = Object.keys(json).map(Number).filter(Number.isFinite);
        const nextId = String((numeric.length ? Math.max(...numeric) : 0) + 1);
        json[nextId] = {
          class_type: 'ImageScaleToTotalPixels',
          inputs: { image: [String(v[0]), v[1]], upscale_method: 'lanczos', megapixels: 2 },
          _meta: { title: '输入预缩放（防回灌累积劣化）' },
        };
        node.inputs[name] = [nextId, 0];
        changes.push(`#${id}.${name} 改经 #${nextId} ImageScaleToTotalPixels(lanczos/2MP)`);
      }
    }
    if (!changes.length) continue;
    await backup(dir, rel);
    await writeFile(join(dir, rel), `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    patched++;
    console.log(`  ✓ ${rel}:`);
    for (const c of changes) console.log(`      ${c}`);
  }
  console.log(`\n完成：补丁 ${patched} 个工作流`);
}

const [cmd, dirArg] = process.argv.slice(2);
const dir = dirArg ?? DEFAULT_DIR;

if (cmd === 'patch-qwen21') {
  await cmdPatchQwen21(dir);
} else if (cmd === 'convert') {
  console.log('拉取 object_info …');
  const objInfo = await loadObjectInfo();
  await cmdConvert(dir, objInfo);
} else {
  console.error('用法：node scripts/convert-workflows-to-ui.mjs <convert|patch-qwen21> [workflowsDir]');
  process.exit(1);
}
