// 模型列表筛选：搜索、隐藏不能对话的模型、排序。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { filterModels, isChatModel } from '../src/agent/modelList';

const LIST = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1',
  'gpt-10',
  'gpt-9',
  'text-embedding-3-large',
  'tts-1',
  'whisper-1',
  'dall-e-3',
  'gpt-4o-realtime-preview',
  'omni-moderation-latest',
  'o3-mini',
  'gpt-4o',
];

describe('模型列表', () => {
  it('识别不能对话的模型', () => {
    assert.equal(isChatModel('gpt-4o-mini'), true);
    assert.equal(isChatModel('deepseek-flash'), true);
    for (const m of ['text-embedding-3-large', 'tts-1', 'whisper-1', 'dall-e-3', 'gpt-4o-realtime-preview', 'omni-moderation-latest']) {
      assert.equal(isChatModel(m), false, m);
    }
  });

  it('默认隐藏非对话模型，去重并按名称排序，选中的放最前', () => {
    const r = filterModels(LIST, '', { hideNonChat: true, selected: 'o3-mini' });
    assert.deepEqual(r.items, ['o3-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'gpt-9', 'gpt-10']);
    assert.equal(r.hidden, 6);
  });

  it('多个关键字搜索；显示全部时不隐藏；选中的非对话模型也保留', () => {
    assert.deepEqual(filterModels(LIST, 'GPT  mini', { hideNonChat: true }).items, ['gpt-4o-mini']);
    assert.equal(filterModels(LIST, '', { hideNonChat: false }).items.length, 12);
    assert.deepEqual(filterModels(LIST, 'tts', { hideNonChat: true, selected: 'tts-1' }).items, ['tts-1']);
  });
});
