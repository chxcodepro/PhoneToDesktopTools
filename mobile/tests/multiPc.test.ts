// 多台电脑的工具合并、按 pc 参数分派、并发分组。
// 运行：npm test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPcTools, resolvePc, uniqueNames, type PcTarget } from '../src/agent/multiPc';
import type { ToolInfo } from '../src/protocol/types';

const tool = (name: string, required: string[] = ['path']): ToolInfo => ({
  name,
  description: `${name} 说明`,
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required },
});

function target(id: string, name: string, toolNames: string[], calls: string[]): PcTarget {
  return {
    id,
    name,
    os: 'windows',
    tools: toolNames.map((n) => tool(n)),
    async call(n, args) {
      calls.push(`${id}:${n}:${JSON.stringify(args)}`);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
}

describe('uniqueNames', () => {
  it('同名电脑加序号，空名用「电脑」', () => {
    assert.deepEqual(uniqueNames(['A', 'B', 'A', ' ', '']), ['A', 'B', 'A (2)', '电脑', '电脑 (2)']);
  });
});

describe('resolvePc', () => {
  const ts = [
    { id: 'id-1', name: '办公室电脑' },
    { id: 'id-2', name: 'kylin-arm' },
  ];
  it('按名字、标识、大小写、唯一的部分匹配', () => {
    assert.equal(resolvePc(ts, '办公室电脑')?.id, 'id-1');
    assert.equal(resolvePc(ts, 'id-2')?.id, 'id-2');
    assert.equal(resolvePc(ts, 'KYLIN-ARM')?.id, 'id-2');
    assert.equal(resolvePc(ts, '办公室')?.id, 'id-1');
    assert.equal(resolvePc(ts, '「kylin-arm」')?.id, 'id-2');
  });
  it('找不到或不唯一', () => {
    assert.equal(resolvePc(ts, '家里'), undefined);
    assert.equal(resolvePc(ts, undefined), undefined);
    assert.equal(resolvePc([...ts, { id: 'id-3', name: '办公室笔记本' }], '办公室'), undefined);
  });
});

describe('createPcTools', () => {
  it('只连一台：工具原样，不加 pc 参数；多余的 pc 参数会去掉', async () => {
    const calls: string[] = [];
    const set = createPcTools(() => [target('a', 'A', ['fs_read'], calls)]);
    assert.deepEqual(set.list(), [tool('fs_read')]);
    await set.call('fs_read', { path: 'x', pc: 'A' });
    assert.deepEqual(calls, ['a:fs_read:{"path":"x"}']);
    assert.equal(set.group('fs_read', {}), 'pc');
  });

  it('多台：合并工具、加必填的 pc 参数，注明哪台才有', () => {
    const set = createPcTools(() => [target('a', 'A', ['fs_read', 'ui_tree'], []), target('b', 'B', ['fs_read'], [])]);
    const list = set.list();
    assert.deepEqual(
      list.map((t) => t.name),
      ['fs_read', 'ui_tree'],
    );
    const fs = list[0].inputSchema as { properties: Record<string, { enum?: string[] }>; required: string[] };
    assert.deepEqual(fs.required, ['pc', 'path']);
    assert.deepEqual(fs.properties.pc.enum, ['A', 'B']);
    assert.ok(fs.properties.path);
    const ui = list[1];
    assert.deepEqual((ui.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.pc.enum, ['A']);
    assert.match(ui.description ?? '', /只有 A 有这个工具/);
    assert.doesNotMatch(list[0].description ?? '', /只有/);
  });

  it('多台：按 pc 分派，结果标上电脑名；缺 pc、找不到、没有这个工具时报错', async () => {
    const calls: string[] = [];
    const set = createPcTools(() => [target('a', 'A', ['fs_read', 'ui_tree'], calls), target('b', 'B', ['fs_read'], calls)]);
    const r = await set.call('fs_read', { pc: 'B', path: 'x' });
    assert.deepEqual(calls, ['b:fs_read:{"path":"x"}']);
    assert.deepEqual(r.content, [{ type: 'text', text: '【B】ok' }]);

    const missing = await set.call('fs_read', { path: 'x' });
    assert.equal(missing.isError, true);
    assert.match((missing.content[0] as { text: string }).text, /没有指定.*A、B/);
    const unknown = await set.call('fs_read', { pc: 'C', path: 'x' });
    assert.match((unknown.content[0] as { text: string }).text, /找不到电脑「C」/);
    const noTool = await set.call('ui_tree', { pc: 'B' });
    assert.match((noTool.content[0] as { text: string }).text, /【B】这台电脑没有 ui_tree/);
    assert.equal(calls.length, 1);
  });

  it('并发分组：不同电脑不同组，同一台同组', () => {
    const set = createPcTools(() => [target('a', 'A', ['fs_read'], []), target('b', 'B', ['fs_read'], [])]);
    assert.equal(set.group('fs_read', { pc: 'A' }), 'pc:a');
    assert.equal(set.group('fs_read', { pc: 'a' }), 'pc:a');
    assert.equal(set.group('fs_read', { pc: 'B' }), 'pc:b');
    assert.equal(set.group('fs_read', {}), 'pc:?');
  });

  it('没有连接电脑', async () => {
    const set = createPcTools(() => []);
    assert.deepEqual(set.list(), []);
    await assert.rejects(() => set.call('fs_read', {}), /电脑未连接/);
  });
});
