// 两台电脑之间传文件（手机中转）。
// 运行：npm test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { b64Size, baseName, copyBetweenPcs, type Rpc } from '../src/agent/pcCopy';

/** 假的源电脑：按块返回文件内容 */
function source(content: Buffer, path = 'C:\\Users\\me\\报表.xlsx'): Rpc & { reads: number } {
  const s = {
    reads: 0,
    async request(method: string, params?: unknown) {
      assert.equal(method, 'p2d/file.read');
      s.reads++;
      const { offset, size } = params as { offset: number; size: number };
      const part = content.subarray(offset, offset + Math.min(size, 300_000));
      return { path, data: part.toString('base64'), size: content.length, eof: offset + part.length >= content.length };
    },
  };
  return s;
}

/** 假的目标电脑：收集上传的数据 */
function target(): Rpc & { got: Buffer[]; calls: string[]; name?: string } {
  const t = {
    got: [] as Buffer[],
    calls: [] as string[],
    name: undefined as string | undefined,
    async request(method: string, params?: unknown) {
      t.calls.push(method);
      const p = params as { name?: string; data?: string };
      if (method === 'p2d/upload.begin') {
        t.name = p.name;
        return { id: '1' };
      }
      if (method === 'p2d/upload.chunk') {
        t.got.push(Buffer.from(p.data!, 'base64'));
        return {};
      }
      if (method === 'p2d/upload.end') {
        const all = Buffer.concat(t.got);
        return { path: `/home/u/下载/p2d/${t.name}`, size: all.length };
      }
      return {};
    },
  };
  return t;
}

describe('pcCopy', () => {
  it('b64Size、baseName', () => {
    assert.equal(b64Size(Buffer.from('abcd').toString('base64')), 4);
    assert.equal(b64Size(Buffer.from('abcde').toString('base64')), 5);
    assert.equal(b64Size(''), 0);
    assert.equal(baseName('C:\\a\\b\\报表.xlsx'), '报表.xlsx');
    assert.equal(baseName('/home/u/x.tar.gz'), 'x.tar.gz');
    assert.equal(baseName('/'), '文件');
  });

  it('分块读、原样上传，内容一致', async () => {
    const content = Buffer.alloc(1_000_003);
    for (let i = 0; i < content.length; i++) content[i] = (i * 7) % 256;
    const src = source(content);
    const dst = target();
    const progress: number[] = [];
    const r = await copyBetweenPcs(src, dst, 'C:\\Users\\me\\报表.xlsx', { onProgress: (s) => progress.push(s) });
    assert.equal(dst.name, '报表.xlsx');
    assert.ok(Buffer.concat(dst.got).equals(content));
    assert.equal(r.size, content.length);
    assert.equal(progress[progress.length - 1], content.length);
    assert.ok(src.reads >= 4);
    assert.equal(dst.calls[dst.calls.length - 1], 'p2d/upload.end');
  });

  it('空文件', async () => {
    const dst = target();
    const r = await copyBetweenPcs(source(Buffer.alloc(0)), dst, '/tmp/empty');
    assert.equal(r.size, 0);
    assert.deepEqual(dst.calls, ['p2d/upload.begin', 'p2d/upload.end']);
  });

  it('旧版电脑端不支持读文件：给出明确提示', async () => {
    const old: Rpc = {
      request: () => Promise.reject(Object.assign(new Error('Method not found'), { code: -32601 })),
    };
    await assert.rejects(() => copyBetweenPcs(old, target(), '/x'), /版本太旧/);
  });

  it('中途出错：取消目标电脑上未完成的文件', async () => {
    const content = Buffer.alloc(700_000, 1);
    const src = source(content);
    const dst = target();
    const orig = dst.request.bind(dst);
    let chunks = 0;
    dst.request = async (m: string, p?: unknown) => {
      if (m === 'p2d/upload.chunk' && ++chunks === 2) throw new Error('连接断开');
      return orig(m, p);
    };
    await assert.rejects(() => copyBetweenPcs(src, dst, '/x'), /连接断开/);
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(dst.calls.includes('p2d/upload.cancel'));
  });
});
