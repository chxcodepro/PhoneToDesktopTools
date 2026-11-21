// 生成式界面：p2d-ui 代码块解析；ask_user 选择卡片的参数整理和结果格式。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSystemPrompt } from '../src/agent/agent';
import { parseGenui } from '../src/agent/genui';
import type { FetchLike } from '../src/agent/llm';
import { createPhoneTools, formatAnswer, parseAskArgs, type AskQuestion } from '../src/agent/phoneTools';

const noFetch: FetchLike = async () => ({ ok: false, status: 500, text: async () => '', body: null });

describe('p2d-ui', () => {
  it('解析多个组件，丢弃未知组件和非法字段', () => {
    const spec = parseGenui(
      JSON.stringify([
        { type: 'callout', tone: 'warning', title: '注意', text: '网卡驱动缺失' },
        {
          type: 'stats',
          items: [
            { label: 'C 盘可用', value: '172 GB', tone: 'success' },
            { label: '空', value: '' },
          ],
        },
        { type: 'progress', label: '磁盘已用', value: 140 },
        {
          type: 'steps',
          items: [
            { title: '下载', status: 'done' },
            { title: '安装', status: 'weird' },
          ],
        },
        { type: 'script', code: 'alert(1)' },
        { type: 'buttons', items: [{ label: '安装驱动', send: '帮我安装刚下载的驱动' }, { label: '稍后' }] },
      ]),
    );
    assert.ok(spec);
    assert.deepEqual(
      spec.nodes.map((n) => n.type),
      ['callout', 'stats', 'progress', 'steps', 'buttons'],
    );
    const [, stats, progress, steps, buttons] = spec.nodes;
    assert.equal(stats.type === 'stats' && stats.items.length, 1);
    assert.equal(progress.type === 'progress' && progress.value, 100);
    assert.equal(steps.type === 'steps' && steps.items[1].status, 'todo');
    assert.deepEqual(buttons.type === 'buttons' && buttons.items[1], { label: '稍后', send: '稍后', primary: undefined });
  });

  it('支持 { title, items } 和单个组件；JSON 不合法或没有组件时返回 null', () => {
    assert.equal(parseGenui('{"title":"概览","items":[{"type":"kv","items":[{"label":"系统","value":"Win10"}]}]}')?.title, '概览');
    assert.equal(parseGenui('{"type":"callout","text":"hi"}')?.nodes.length, 1);
    assert.equal(parseGenui('{"type":"callout","text":'), null);
    assert.equal(parseGenui('[{"type":"unknown"}]'), null);
  });
});

describe('ask_user', () => {
  it('整理选项：去重、去空、限制数量，至少 2 个', () => {
    const q = parseAskArgs({
      question: ' 用哪种方式下载？ ',
      options: [{ label: '手机下载', description: '电脑没网时用' }, '电脑下载', '手机下载', { label: '' }],
    });
    assert.deepEqual(q, {
      question: '用哪种方式下载？',
      options: [{ label: '手机下载', description: '电脑没网时用' }, { label: '电脑下载' }],
      multiple: false,
      allowCustom: true,
    });
    assert.equal(typeof parseAskArgs({ question: 'x', options: ['只有一个'] }), 'string');
    assert.equal(typeof parseAskArgs({ options: ['a', 'b'] }), 'string');
  });

  it('等用户选完再返回结果', async () => {
    let asked: AskQuestion | null = null;
    const t = createPhoneTools({
      fetch: noFetch,
      downloadToPc: null,
      askUser: async (q) => {
        asked = q;
        return { selected: ['手机下载'], custom: '下到 D 盘' };
      },
    });
    const r = await t.call('ask_user', { question: '怎么下载？', options: ['手机下载', '电脑下载'], multiple: true, allow_custom: false });
    assert.equal(asked!.multiple, true);
    assert.equal(asked!.allowCustom, false);
    assert.equal(r.content[0].type === 'text' && r.content[0].text, '用户选择了：手机下载\n用户输入：下到 D 盘');
    assert.equal(formatAnswer({ selected: [] }), '用户没有选择');
  });

  it('系统提示说明 ask_user 和 p2d-ui', () => {
    const p = buildSystemPrompt({
      computer: { host: 'PC', os: 'windows' },
      supportsVision: true,
      supportsTools: true,
      tools: { list: () => [], call: async () => ({ content: [] }) },
    });
    assert.match(p, /ask_user/);
    assert.match(p, /p2d-ui/);
  });
});

describe('自定义系统提示词', () => {
  const base = {
    computer: { host: 'PC', os: 'windows' },
    supportsVision: true,
    supportsTools: true,
    tools: { list: () => [], call: async () => ({ content: [] }) },
  };
  it('加在内置提示词之后；为空时不加', () => {
    const p = buildSystemPrompt({ ...base, customPrompt: '  称呼我为张工  ' });
    assert.ok(p.endsWith('称呼我为张工'));
    assert.ok(p.indexOf('称呼我为张工') > p.indexOf('download_to_pc'));
    assert.ok(!buildSystemPrompt({ ...base, customPrompt: '   ' }).includes('用户设置的要求'));
  });
});

describe('系统提示词预设', () => {
  it('预设不超过长度上限，且提到分级确认和记录', async () => {
    const { MAX_PROMPT, PROMPT_PRESETS } = await import('../src/agent/promptPresets');
    assert.ok(PROMPT_PRESETS.length >= 1);
    for (const p of PROMPT_PRESETS) {
      assert.ok(p.text.length <= MAX_PROMPT, `${p.name} 太长：${p.text.length}`);
      assert.ok(p.name && p.summary);
    }
    const admin = PROMPT_PRESETS.find((p) => p.id === 'pc-admin')!;
    assert.match(admin.text, /ask_user/);
    assert.match(admin.text, /维护记录/);
  });
});
