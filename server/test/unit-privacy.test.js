/**
 * 隐私自检：受版本控制的文件里不得出现本机标识或密钥。
 * 检查模式来自不入库的 .privacy-patterns + config.json 的令牌 + 常见密钥形状。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPrivacy } from '../../scripts/check-privacy.mjs';

test('受控文件中不含本机标识与密钥', () => {
  const code = checkPrivacy();
  assert.equal(code, 0, '发现本机标识或密钥，见上方输出（应把这类值放入不入库的「本地备注.md」）');
});
