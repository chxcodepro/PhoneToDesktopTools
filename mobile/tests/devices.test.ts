// 设备记录去重：同一台电脑 pcId 变了（电脑端 lan.json 丢失或换了位置）时合并成一条。
// 运行：npm test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findSameMachine, mergeInto, type MergeFields } from '../src/state/deviceMerge';

const dev = (pcId: string, extra: Partial<MergeFields> = {}): MergeFields => ({ pcId, name: 'PC-20260913SNBR', os: 'windows', ...extra });

describe('findSameMachine', () => {
  it('升级前留下的记录（没有指纹）：电脑名和系统相同就是同一台', () => {
    const old = dev('aaaa000011112222', { lastConnectedAt: 1 });
    const cur = dev('47b2c8fc24753411', { mid: 'm1' });
    assert.deepEqual(findSameMachine(cur, [old]), [old]);
    // 名字大小写、首尾空格不影响
    assert.equal(findSameMachine(cur, [dev('x', { name: ' pc-20260913snbr ' })]).length, 1);
  });

  it('都有指纹：只看指纹', () => {
    const cur = dev('p2', { mid: 'm1' });
    assert.equal(findSameMachine(cur, [dev('p1', { mid: 'm1' })]).length, 1);
    // 同名但指纹不同：是两台电脑（比如克隆出来的系统改了名又改回来）
    assert.equal(findSameMachine(cur, [dev('p1', { mid: 'm2' })]).length, 0);
    // 指纹相同即使改了电脑名也算同一台
    assert.equal(findSameMachine(cur, [dev('p1', { mid: 'm1', name: '旧名字' })]).length, 1);
  });

  it('不误合并', () => {
    const cur = dev('p2', { mid: 'm1' });
    assert.equal(findSameMachine(cur, [dev('p2')]).length, 0, '自己不算');
    assert.equal(findSameMachine(cur, [dev('p1', { name: 'OTHER-PC' })]).length, 0, '名字不同');
    assert.equal(findSameMachine(cur, [dev('p1', { os: 'linux' })]).length, 0, '系统不同');
    assert.equal(findSameMachine(dev('p2', { mid: 'm1', name: '电脑' }), [dev('p1', { name: '电脑' })]).length, 0, '默认名不能用来判断');
    // 旧版电脑端（没有指纹）：不合并，保持原来的行为
    assert.equal(findSameMachine(dev('p2'), [dev('p1')]).length, 0);
  });

  it('多条重复记录一起找出来', () => {
    const list = [dev('p1'), dev('p0', { mid: 'm1' }), dev('p9', { name: 'OTHER' }), dev('p2', { mid: 'm1' })];
    assert.deepEqual(
      findSameMachine(dev('p2', { mid: 'm1' }), list).map((d) => d.pcId),
      ['p1', 'p0'],
    );
  });
});

describe('mergeInto', () => {
  it('保留用户起的名字：当前没有时取最近连过的那条', () => {
    const cur = dev('p2', { mid: 'm1' });
    const merged = mergeInto(cur, [dev('p0', { alias: '老的', lastConnectedAt: 1 }), dev('p1', { alias: '办公室', lastConnectedAt: 5 })]);
    assert.equal(merged.alias, '办公室');
    assert.equal(merged.pcId, 'p2');
  });

  it('当前已有名字就不动', () => {
    const cur = dev('p2', { alias: '家里' });
    assert.equal(mergeInto(cur, [dev('p1', { alias: '办公室' })]), cur);
    assert.equal(mergeInto(dev('p2'), []).alias, undefined);
  });
});
