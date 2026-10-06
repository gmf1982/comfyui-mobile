/** 单元测试：parseLaunch 拆解 comfyuiLaunch（引号路径、.bat 识别、空值安全）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunch } from '../src/comfy-process.js';

test('带引号可执行路径 + 普通参数', () => {
  const r = parseLaunch('"C:/Program Files/Python312/python.exe" main.py --cpu');
  assert.equal(r.exe, 'C:/Program Files/Python312/python.exe');
  assert.deepEqual(r.args, ['main.py', '--cpu']);
  assert.equal(r.isScript, false);
});

test('无引号简单命令', () => {
  const r = parseLaunch('python3 main.py');
  assert.equal(r.exe, 'python3');
  assert.deepEqual(r.args, ['main.py']);
  assert.equal(r.isScript, false);
});

test('.bat/.cmd 包装脚本标记为 isScript', () => {
  assert.equal(parseLaunch('"D:/AI/ComfyUI/run_nvidia_gpu.bat"').isScript, true);
  assert.equal(parseLaunch('start.cmd --fast').isScript, true);
  assert.equal(parseLaunch('D:/x/python.EXE main.py').isScript, false);
});

test('空串与 null 安全', () => {
  assert.deepEqual(parseLaunch('   '), { exe: '', args: [], isScript: false });
  assert.deepEqual(parseLaunch(null), { exe: '', args: [], isScript: false });
});
