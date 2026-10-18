// SEA 启动器：编译进 ComfyUI-Mobile.exe。运行时定位 exe 旁的 app/ 目录，
// 用动态 import() 加载真实磁盘上的网关入口（ESM、顶层 await 均不受影响）。
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const appDir = path.join(path.dirname(process.execPath), 'app');
const entry = path.join(appDir, 'server', 'src', 'index.js');

function fail(msg) {
  console.error(`\n[启动失败 / Startup failed] ${msg}\n`);
  // 双击运行时窗口会随进程退出而关闭，等一次回车再退出，让用户看到错误。
  try {
    const buf = Buffer.alloc(1);
    for (;;) {
      if (fs.readSync(0, buf, 0, 1, null) <= 0) break;
      if (buf[0] === 10 || buf[0] === 13) break;
    }
  } catch {
    /* 无控制台 stdin（如计划任务）时直接退出 */
  }
  process.exit(1);
}

if (!fs.existsSync(entry)) {
  fail(`找不到网关入口 / Gateway entry not found: ${entry}`);
}

process.chdir(appDir);
import(pathToFileURL(entry).href).catch((err) => fail(err && err.stack ? err.stack : String(err)));
