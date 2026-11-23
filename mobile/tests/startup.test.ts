// 打开 App 时选哪台电脑。
// 运行：npm test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickStartup } from '../src/state/startup';

const a = { pcId: 'a', paired: true, lastConnectedAt: 300 };
const b = { pcId: 'b', paired: true, lastConnectedAt: 100 };
const c = { pcId: 'c', paired: false, lastConnectedAt: 500 };

describe('pickStartup', () => {
  it('上次用的电脑优先（即使不是最近连上的）', () => {
    assert.deepEqual(pickStartup([a, b], 'b', null), { useUsb: false, pcId: 'b' });
  });
  it('USB 令牌属于上次用的电脑：用 USB', () => {
    assert.deepEqual(pickStartup([a, b], 'a', { pcId: 'a' }), { useUsb: true, pcId: 'a' });
  });
  it('插线连过 a，之后切到 b：打开 App 连 b，不再连回 a', () => {
    assert.deepEqual(pickStartup([a, b], 'b', { pcId: 'a' }), { useUsb: false, pcId: 'b' });
  });
  it('没有记录上次用哪台：最近连过且配对过的', () => {
    assert.deepEqual(pickStartup([b, a, c], null, null), { useUsb: false, pcId: 'a' });
    assert.deepEqual(pickStartup([c], null, null), { useUsb: false, pcId: 'c' });
    assert.deepEqual(pickStartup([], null, null), { useUsb: false, pcId: null });
  });
  it('上次用的电脑已删除', () => {
    assert.deepEqual(pickStartup([a, b], 'x', null), { useUsb: false, pcId: 'a' });
    assert.deepEqual(pickStartup([a, b], 'x', { pcId: 'b' }), { useUsb: true, pcId: 'b' });
  });
});
