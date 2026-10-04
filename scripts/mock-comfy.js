/**
 * 模拟 ComfyUI CLI：本地联调用，实现网关所需的全部端点与假执行流。
 * 用法：node scripts/mock-comfy.js [--port=8189] [--input-dir=<目录>]
 *   input-dir：LoadImage 组合框列出该目录的图片（与真实 ComfyUI 行为一致），供选择器联调。
 */
import { createMockComfy } from '../server/test/helpers/mock-comfy.js';
import path from 'node:path';

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.split('=')[1]) : 8189;
const inputDirArg = args.find((a) => a.startsWith('--input-dir='));
const inputDir = inputDirArg ? path.resolve(inputDirArg.split('=').slice(1).join('=')) : undefined;

const mock = createMockComfy({ execDelayMs: 400, inputDir });
mock.server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-comfy] 模拟 ComfyUI 已启动：http://127.0.0.1:${port}`);
  console.log('[mock-comfy] 将网关 upstream 指向该地址即可联调（无需显卡）。');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await mock.close();
    process.exit(0);
  });
}
