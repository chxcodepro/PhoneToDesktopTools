// 文字识别结果整理：阅读顺序、屏幕坐标换算、长度限制。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatOcr, parseScreenTransform, sortLines, type OcrLine } from '../src/agent/ocr';

const line = (text: string, x: number, y: number, w = 60, h = 20): OcrLine => ({ text, x, y, w, h });

describe('文字识别结果', () => {
  it('从截图说明里读出换算公式', () => {
    const t = parseScreenTransform(
      '显示器 0：1920x1080。截图尺寸 1280x720，scale=0.6667。\n屏幕坐标 = (截图x ÷ 0.6667 + 0, 截图y ÷ 0.6667 + 0)。',
    );
    assert.deepEqual(t, { scale: 0.6667, offsetX: 0, offsetY: 0 });
    assert.deepEqual(parseScreenTransform('屏幕坐标 = (截图x ÷ 1.0000 + -1920, 截图y ÷ 1.0000 + 120)'), {
      scale: 1,
      offsetX: -1920,
      offsetY: 120,
    });
    assert.equal(parseScreenTransform('没有公式'), null);
  });

  it('按阅读顺序排序：同一行从左到右，略有高低差也算同一行', () => {
    const sorted = sortLines([
      line('确定', 300, 102),
      line('文件', 10, 10),
      line('取消', 100, 100),
      line('编辑', 80, 12),
      line('  ', 0, 0),
    ]);
    assert.deepEqual(
      sorted.map((l) => l.text),
      ['文件', '编辑', '取消', '确定'],
    );
  });

  it('坐标为文字中心，有公式时换算成屏幕坐标', () => {
    const r = { width: 1280, height: 720, lines: [line('确定', 100, 200, 40, 20)] };
    assert.match(formatOcr(r, { scale: 0.5, offsetX: 1920, offsetY: 0 }), /\(2160, 420\) 确定/);
    assert.match(formatOcr(r, null), /\(120, 210\) 确定/);
    assert.match(formatOcr(r, null), /截图中的像素/);
    assert.match(formatOcr({ width: 1, height: 1, lines: [] }, null), /没有识别到文字/);
  });

  it('文字太多时截断并说明', () => {
    const lines = Array.from({ length: 500 }, (_, i) => line(`第${i}行内容`, 0, i * 30));
    const out = formatOcr({ width: 1000, height: 20000, lines }, null);
    assert.match(out, /共识别到 500 行/);
    assert.match(out, /其余 200 行已省略/);
  });
});
