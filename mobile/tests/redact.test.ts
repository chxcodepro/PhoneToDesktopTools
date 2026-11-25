// 日志脱敏：令牌、API key 不能出现在导出的日志里。
// 运行：npm test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redact } from '../src/lib/redact';

describe('redact', () => {
  it('隐藏连接链接里的令牌', () => {
    const s = redact('收到链接 p2d://connect?token=abc123XYZ&host=PC&port=39271');
    assert.equal(s, '收到链接 p2d://connect?token=<已隐藏>&host=PC&port=39271');
  });
  it('隐藏 Bearer 头和 sk- 开头的 key', () => {
    assert.equal(redact('Authorization: Bearer eyJhbGci.x-y_z'), 'Authorization: Bearer <已隐藏>');
    assert.equal(redact('key sk-proj-1234567890abcdef 无效'), 'key sk-<已隐藏> 无效');
  });
  it('隐藏 JSON 里的 token / apiKey 字段', () => {
    assert.equal(redact('{"apiKey":"k-1","host":"a","token":"t"}'), '{"apiKey":"<已隐藏>","host":"a","token":"<已隐藏>"}');
  });
  it('普通内容不变', () => {
    assert.equal(redact('连接：connected，通道 usb'), '连接：connected，通道 usb');
  });
});
