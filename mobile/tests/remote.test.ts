// 远程桌面坐标换算测试。运行：npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toScreen, toView } from '../src/remote/geometry';

describe('remote geometry', () => {
  // 2560x1600 的显示器缩成 1280x800 的画面，手机上显示宽度 320
  const f = { width: 1280, scale: 0.5, x: 0, y: 0 };

  it('点击画面中心 → 屏幕中心', () => {
    assert.deepEqual(toScreen(f, 320, 160, 100), { x: 1280, y: 800 });
  });

  it('副屏在主屏上方（负坐标）时加上偏移', () => {
    const g = { width: 1280, scale: 1280 / 3072, x: 0, y: -1728 };
    assert.deepEqual(toScreen(g, 320, 0, 0), { x: 0, y: -1728 });
    assert.deepEqual(toScreen(g, 320, 320, 0), { x: 3072, y: -1728 });
  });

  it('屏幕坐标 → 画面坐标与上面互逆', () => {
    const p = toScreen(f, 320, 37, 81);
    const v = toView(f, 320, p.x, p.y);
    assert.ok(Math.abs(v.left - 37) <= 0.5 && Math.abs(v.top - 81) <= 0.5);
  });
});
