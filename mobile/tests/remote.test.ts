// 远程桌面坐标换算测试。运行：npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NO_ZOOM, clampZoom, pinchZoom, toScreen, toView, unzoom } from '../src/remote/geometry';
import { MouseQueue, type MouseArgs } from '../src/remote/mouseQueue';

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

describe('画面缩放', () => {
  const W = 320;
  const H = 200;

  it('两指距离变成两倍：放大两倍，中点下的内容不动', () => {
    const m = { x: 100, y: 80 };
    const z = pinchZoom(NO_ZOOM, m, 50, m, 100, W, H);
    assert.equal(z.s, 2);
    const p = unzoom(z, m.x, m.y);
    assert.ok(Math.abs(p.x - 100) < 1e-9 && Math.abs(p.y - 80) < 1e-9);
  });

  it('放大后平移不能露出画面外的黑边', () => {
    const z = clampZoom({ s: 2, ox: 50, oy: -1000 }, W, H);
    assert.deepEqual(z, { s: 2, ox: 0, oy: H - H * 2 });
  });

  it('缩到 1 倍以下按不缩放处理，最大 5 倍', () => {
    assert.deepEqual(clampZoom({ s: 0.6, ox: -10, oy: -10 }, W, H), NO_ZOOM);
    assert.equal(pinchZoom(NO_ZOOM, { x: 0, y: 0 }, 10, { x: 0, y: 0 }, 1000, W, H).s, 5);
  });

  it('放大后点到的位置换算回未缩放的画面坐标', () => {
    const z = { s: 2, ox: -160, oy: -100 }; // 放大两倍看右下四分之一
    assert.deepEqual(unzoom(z, 0, 0), { x: 80, y: 50 });
    assert.deepEqual(unzoom(z, W, H), { x: 240, y: 150 });
  });
});

describe('鼠标操作队列', () => {
  it('按顺序一个一个发，排队中的连续移动只保留最后一个', async () => {
    const sent: MouseArgs[] = [];
    let release: () => void = () => undefined;
    const q = new MouseQueue(
      (a) =>
        new Promise<void>((r) => {
          sent.push(a);
          release = r;
        }),
    );
    q.push({ action: 'down', x: 1, y: 1 });
    q.push({ action: 'move', x: 2, y: 2 });
    q.push({ action: 'move', x: 3, y: 3 });
    q.push({ action: 'up', x: 3, y: 3 });
    assert.deepEqual(sent, [{ action: 'down', x: 1, y: 1 }]); // 第一个还没返回，后面的都在排队
    assert.equal(q.pending, 2); // 两个移动合并成一个
    for (let i = 0; i < 3; i++) {
      release();
      await new Promise((r) => setTimeout(r, 0));
    }
    assert.deepEqual(
      sent.map((a) => a.action),
      ['down', 'move', 'up'],
    );
    assert.deepEqual(sent[1], { action: 'move', x: 3, y: 3 });
  });

  it('排队中同一位置的连续滚动合成一次', async () => {
    const sent: MouseArgs[] = [];
    let release: () => void = () => undefined;
    const q = new MouseQueue(
      (a) =>
        new Promise<void>((r) => {
          sent.push(a);
          release = r;
        }),
    );
    q.push({ action: 'click', x: 1, y: 1 });
    q.push({ action: 'scroll', dy: 2, x: 5, y: 5 });
    q.push({ action: 'scroll', dy: 3, x: 5, y: 5 });
    q.push({ action: 'scroll', dy: -1, x: 9, y: 9 }); // 换了位置：不合并
    assert.equal(q.pending, 2);
    for (let i = 0; i < 3; i++) {
      release();
      await new Promise((r) => setTimeout(r, 0));
    }
    assert.deepEqual(sent.slice(1), [
      { action: 'scroll', dy: 5, x: 5, y: 5 },
      { action: 'scroll', dy: -1, x: 9, y: 9 },
    ]);
  });

  it('来回滚动正好抵消时不发（电脑端不接受 dy=0）', async () => {
    const sent: MouseArgs[] = [];
    let release: () => void = () => undefined;
    const q = new MouseQueue(
      (a) =>
        new Promise<void>((r) => {
          sent.push(a);
          release = r;
        }),
    );
    q.push({ action: 'click', x: 1, y: 1 });
    q.push({ action: 'scroll', dy: 2, x: 5, y: 5 });
    q.push({ action: 'scroll', dy: -2, x: 5, y: 5 });
    assert.equal(q.pending, 0);
    release();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sent, [{ action: 'click', x: 1, y: 1 }]);
  });

  it('某个操作失败不影响后面的', async () => {
    const sent: string[] = [];
    const q = new MouseQueue(async (a) => {
      sent.push(String(a.action));
      if (a.action === 'down') throw new Error('拒绝');
    });
    q.push({ action: 'down' });
    q.push({ action: 'up' });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(sent, ['down', 'up']);
  });
});
