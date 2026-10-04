/** 第六轮：压缩、上传重试、进度窗口、批量删除的单元测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const apiSrc = fs.readFileSync('web/js/lib/api.js', 'utf8');
const mediaSrc = fs.readFileSync('web/js/lib/media.js', 'utf8');
const stateSrc = fs.readFileSync('web/js/lib/state.js', 'utf8');
const uiSrc = fs.readFileSync('web/js/lib/ui.js', 'utf8');
const gallerySrc = fs.readFileSync('web/js/views/gallery.js', 'utf8');
const appSrc = fs.readFileSync('web/js/app.js', 'utf8');

test('媒体模块提供压缩与体积格式化（含目标体积迭代）', () => {
  assert.match(mediaSrc, /export async function compressImage/);
  assert.match(mediaSrc, /targetMB/);
  assert.match(mediaSrc, /const attempts = \[/);
  assert.match(mediaSrc, /export function humanSize/);
  assert.match(mediaSrc, /export function inputMediaUrl/);
  assert.match(mediaSrc, /createImageBitmap/);
});

test('上传走 XHR 以获得进度，并识别 HTML 错误页', () => {
  assert.match(apiSrc, /XMLHttpRequest/);
  assert.match(apiSrc, /xhr\.upload\.onprogress/);
  assert.match(apiSrc, /startsWith\('<'\)/, '应识别隧道返回的 HTML 错误页');
  assert.match(apiSrc, /网络中断（服务器返回错误页/, '应给出可读的错误提示');
});

test('上传失败后加强压缩自动重试一次', () => {
  assert.match(apiSrc, /catch \(err\)/);
  assert.match(apiSrc, /retryOpts/, '应有重试参数');
  assert.match(apiSrc, /return attemptUpload\(retryOpts\)/);
  assert.match(apiSrc, /err\.status === 401 \|\| err\.status === 413/, '鉴权/体积错误不重试');
});

test('上传后使 schema 缓存失效（新文件立即出现在下拉中）', () => {
  assert.match(apiSrc, /export function invalidateSchemaCache/);
  assert.match(apiSrc, /export async function fetchFreshSchema/);
  assert.match(apiSrc, /invalidateSchemaCache\(\);/, '上传成功后应调用');
  assert.match(uiSrc, /fetchFreshSchema/, '选择器刷新按钮应拉取最新列表');
});

test('进度采样使用滚动窗口并给出剩余时间', () => {
  assert.match(stateSrc, /export function noteProgress/);
  assert.match(stateSrc, /winStart/);
  assert.match(stateSrc, /dms >= 1000 && dv > 0/, '窗口至少 1 秒才更新速率');
  assert.match(stateSrc, /s\.eta = /);
});

test('生成完成跳图库改为不依赖 WebSocket 的轮询', () => {
  assert.match(stateSrc, /export function markPendingRun/);
  assert.match(stateSrc, /export function isPendingRun/);
  assert.match(appSrc, /watchPendingRun/);
  assert.match(appSrc, /2500/, '轮询间隔');
  assert.match(appSrc, /clearPendingRun\(\)/);
});

test('图库删除为批量模式：就地标记、不自动刷新', () => {
  const g = fs.readFileSync('web/js/views/gallery.js', 'utf8');
  assert.match(g, /const deletedIds = new Set\(\)/);
  assert.match(g, /function markDeleted/);
  assert.match(g, /tile-deleted-tag/);
  assert.match(g, /renderPendingBar/);
  assert.doesNotMatch(g, /deletedIds\.add\(entry\.promptId\);\s*\n\s*await load\(\);/, '删除后不应立即重载');
});

test('队列页就地预览结果（不跳图库）且无自动跳转', () => {
  const q = fs.readFileSync('web/js/views/queue.js', 'utf8');
  assert.match(q, /async function loadResult\(promptId\)/, '应拉取本次结果');
  assert.match(q, /function renderResult\(\)/, '应就地渲染结果');
  assert.match(q, /thumbUrl\(item, 80, 1024\)/, '结果图片用 1024px 缩略图（点开大图才拉原图）');
  assert.match(q, /viewUrl\(item\), controls/, '视频/音频仍加载原文件');
  assert.match(q, /pendingBox,\s*\n\s*resultCard,/, '结果卡片位于页面下方（待执行之后）');
  assert.match(q, /history\/\$\{encodeURIComponent\(promptId\)\}/, '按 prompt_id 取单条历史（不拉全部）');
  const app = fs.readFileSync('web/js/app.js', 'utf8');
  assert.doesNotMatch(app, /location\.hash = '\/gallery';[\s\S]{0,80}生成完成|生成完成[\s\S]{0,80}location\.hash = '\/gallery'/, '不应再自动跳转图库');
});

test('工作流收藏：星标切换、置顶、只看收藏筛选', () => {
  const stateSrc = fs.readFileSync('web/js/lib/state.js', 'utf8');
  assert.match(stateSrc, /export function favorites\(\)/);
  assert.match(stateSrc, /export function toggleFavorite\(path\)/);
  assert.match(stateSrc, /export function isFavorite\(path\)/);
  const wfSrc = fs.readFileSync('web/js/views/workflows.js', 'utf8');
  assert.match(wfSrc, /只看收藏/, '应有筛选芯片');
  assert.match(wfSrc, /const fa = favs\.includes\(a\) \? 0 : 1/, '收藏应置顶');
  assert.match(wfSrc, /toggleFavorite\(path\)/, '列表项可切换收藏');
  const runSrc = fs.readFileSync('web/js/views/run.js', 'utf8');
  assert.match(runSrc, /toggleFavorite\(wfState\.path\)/, '运行页也可收藏当前工作流');
});

test('媒体选择器提供缩略图与长按预览', () => {
  assert.match(uiSrc, /media-grid/);
  assert.match(uiSrc, /inputMediaUrl\(name, '', \d+/, '缩略图指向 input 目录（带 WebP 质量/尺寸参数）');
  assert.match(uiSrc, /showQuickPreview/);
  assert.match(uiSrc, /hideQuickPreview/);
  assert.match(uiSrc, /pressTimer = setTimeout/, '长按触发');
  assert.match(uiSrc, /380/, '长按阈值');
});

test('压缩参数来自设置（可关闭/可调）', () => {
  assert.match(uiSrc, /state\.settings\.compressUpload !== false/);
  assert.match(uiSrc, /uploadMaxDim/);
  const settingsSrc = fs.readFileSync('web/js/views/settings.js', 'utf8');
  assert.match(settingsSrc, /上传前压缩图片/);
  assert.match(settingsSrc, /压缩最长边/);
  assert.match(settingsSrc, /目标体积/);
});

test('长按预览最大边约 500px', () => {
  const css = fs.readFileSync('web/css/app.css', 'utf8');
  assert.match(css, /\.quick-preview/);
  assert.match(css, /max-height: 500px/);
  assert.match(css, /max-width: min\(92vw, 500px\)/);
});

test('前端模块不得用局部变量遮蔽导入名（上传静默失败的教训）', () => {
  const libDir = 'web/js/lib';
  const files = fs.readdirSync(libDir).filter((f) => f.endsWith('.js')).map((f) => `${libDir}/${f}`);
  const viewsDir = 'web/js/views';
  files.push(...fs.readdirSync(viewsDir).map((f) => `${viewsDir}/${f}`));
  const problems = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const imports = [...src.matchAll(/import \{([^}]+)\} from/g)]
      .flatMap((m) => m[1].split(',').map((x) => x.trim().split(' as ').pop().trim()))
      .filter(Boolean);
    for (const name of imports) {
      if (new RegExp(`(?:const|let|var)\s+${name}\s*=`).test(src)) problems.push(`${f} 遮蔽了导入的 ${name}`);
      // i18n 的 t/tf 是单字母名，极易被箭头/function 参数遮蔽
      // （2026-09-28 实际发生：outTypes.forEach((t, slot)) 里调了 i18n 的 t() →「t is not a function」）。
      // 只查声明位：箭头参数后面同行出现 =>，或 function 形参表里出现该名字。
      if (name === 't' || name === 'tf') {
        const arrow = new RegExp(`\\(\\s*${name}\\s*[,)][^\\n]{0,60}=>`);
        const fnDecl = new RegExp(`function\\s+\\w+\\s*\\([^)]*\\b${name}\\b[^)]*\\)`);
        if (arrow.test(src) || fnDecl.test(src)) problems.push(`${f} 有函数参数遮蔽了导入的 ${name}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('; '));
});

test('上传进度回调不引用自身待初始化的结果变量', () => {
  const src = fs.readFileSync('web/js/lib/ui.js', 'utf8');
  const seg = src.slice(src.indexOf('async function doUpload'), src.indexOf('/** 缩略图网格选择器'));
  assert.match(seg, /lastProgress/, '应通过中间变量拼接进度文本');
  assert.doesNotMatch(seg, /onProgress:[\s\S]{0,200}res\?\.compressed/, 'onProgress 内不得引用 res');
});

test('媒体字段把上传/拍照按钮常显在字段下方（第 6 轮曾误藏进选择器）', () => {
  const src = fs.readFileSync('web/js/lib/ui.js', 'utf8');
  const seg = src.slice(src.indexOf("if (field.kind === 'media')"), src.indexOf("if (field.kind === 'image-upload')"));
  assert.match(seg, /const btnRow = el\('div'/, '应有常显按钮行');
  assert.match(seg, /btnRow\.append\(fileTrigger\('btn small', t\('⬆ 上传'\) \+ mediaLabel, albumInput\)\)/, '上传按钮应使用 fileTrigger（label + 显式 click，文案经 i18n）');
  assert.match(seg, /wrap\.append\(el\('label', \{ text: field\.label \}\), valueBtn, btnRow, albumInput, camInput \?\? null, info\)/, '按钮行与隐藏 input 都应挂在字段上');
});

test('生成结果始终显示用时（含缓存命中与客户端回退）', () => {
  const q = fs.readFileSync('web/js/views/queue.js', 'utf8');
  assert.match(q, /function formatDuration\(ms\)/, '应有耗时格式化');
  assert.match(q, /ms < 1000\) return '用时 ' \+ ms \+ ' 毫秒（缓存命中，未重新计算）'/, '极短耗时标注缓存命中');
  assert.match(q, /st && su \? su - st : \(runStats\.startedAt \? Date\.now\(\) - runStats\.startedAt : null\)/, '时间戳缺失时回退客户端计时');
  assert.doesNotMatch(q, /durationMs = st && su && su - st > 900 \? su - st : null/, '不应再过滤短耗时');
  assert.match(q, /item\.filename \+ \(lastResult\.durationMs != null \? ' · ' \+ formatDuration/, '每张结果也带用时');
});
