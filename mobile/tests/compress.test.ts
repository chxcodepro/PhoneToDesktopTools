// 上下文压缩与上下文长度默认值测试。运行：npm test
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { SCREENSHOT_MARKER } from '../src/agent/agent';
import { canCompress, compressHistory, isContextOverflow, SUMMARY_PREFIX, transcript } from '../src/agent/compress';
import { defaultContextWindow, formatWindow, resolveContextWindow } from '../src/agent/contextWindow';
import type { ChatMessage, FetchLike } from '../src/agent/llm';
import { effectiveReasoning, reasoningBody, reasoningOptions } from '../src/agent/reasoning';

const nodeFetch = fetch as unknown as FetchLike;

/** 假的模型服务：记录请求，返回固定摘要 */
async function fakeSummaryServer() {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '用户想整理桌面；已列出桌面文件。' } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const servers: { close(): Promise<void> }[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

/** 三轮对话，第二轮有工具调用和截图 */
function sampleHistory(): ChatMessage[] {
  return [
    { role: 'user', content: '看看桌面有什么' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs_list', arguments: '{"path":"C:\\\\Users\\\\A\\\\Desktop"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'a.txt\nb.docx' },
    { role: 'assistant', content: '桌面有 a.txt 和 b.docx' },
    { role: 'user', content: '截个图' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'screen_capture', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: '显示器 0' },
    { role: 'user', content: [{ type: 'text', text: SCREENSHOT_MARKER }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,xx' } }] },
    { role: 'assistant', content: '屏幕上是桌面' },
    { role: 'user', content: '把 a.txt 删掉' },
    { role: 'assistant', content: '好的' },
  ];
}

describe('compress', () => {
  it('较早的对话换成摘要，最近两轮原样保留，工具调用不被拆开', async () => {
    const s = await fakeSummaryServer();
    servers.push(s);
    const history = sampleHistory();
    const r = await compressHistory(history, { llm: { baseUrl: s.baseUrl, apiKey: 'k', model: 'm' }, fetch: nodeFetch });
    assert.ok(r);
    assert.equal(r.compressed, 4); // 第一轮的 4 条消息
    assert.ok(String(r.history[0].content).startsWith(SUMMARY_PREFIX));
    assert.ok(String(r.history[0].content).includes('整理桌面'));
    assert.equal(r.history[1].role, 'assistant');
    // 保留部分从「截个图」开始，截图消息不算一轮
    assert.equal(r.history[2].content, '截个图');
    assert.deepEqual(r.history.slice(2), history.slice(4));
    // 发给压缩模型的记录里没有图片数据
    const sent = JSON.stringify(s.requests[0].messages);
    assert.ok(sent.includes('fs_list') && !sent.includes('base64'));
  });

  it('对话太短时不压缩', async () => {
    const short: ChatMessage[] = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好！' }];
    assert.equal(canCompress(short), false);
    assert.equal(canCompress(sampleHistory()), true);
    // 已经压缩过的摘要不算一轮用户对话
    const compressed: ChatMessage[] = [
      { role: 'user', content: `${SUMMARY_PREFIX}\n摘要` },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '继续' },
    ];
    assert.equal(canCompress(compressed), false);
  });

  it('文字记录截断过长的工具结果', () => {
    const t = transcript([{ role: 'tool', tool_call_id: 'x', content: 'x'.repeat(5000) }]);
    assert.ok(t.length < 1000 && t.includes('省略'));
  });

  it('识别上下文超长错误', () => {
    assert.ok(isContextOverflow(new Error("请求失败（HTTP 400）：This model's maximum context length is 131072 tokens")));
    assert.ok(isContextOverflow(new Error('输入超出上下文长度限制')));
    assert.ok(!isContextOverflow(new Error('API Key 无效')));
  });
});

describe('context window', () => {
  it('按模型名给出官方上下文长度', () => {
    // DeepSeek 官方接口 V4 起都是 1M（/models 声明 1,048,576）；本机部署的老模型仍按 128K
    assert.equal(defaultContextWindow('deepseek-chat'), 1_048_576);
    assert.equal(defaultContextWindow('deepseek-v4-flash'), 1_048_576);
    assert.equal(defaultContextWindow('deepseek-r1:14b'), 128_000);
    assert.equal(defaultContextWindow('gpt-5.5'), 1_050_000);
    assert.equal(defaultContextWindow('claude-sonnet-4-6'), 1_000_000);
    assert.equal(defaultContextWindow('gpt-4o-mini'), 128_000);
    assert.equal(defaultContextWindow('gpt-4.1'), 1_047_576);
    assert.equal(defaultContextWindow('gpt-5-mini'), 400_000);
    assert.equal(defaultContextWindow('o4-mini'), 200_000);
    assert.equal(defaultContextWindow('moonshot-v1-32k'), 32_000);
    assert.equal(defaultContextWindow('qwen-max'), 32_000);
    assert.equal(defaultContextWindow('some-unknown-model'), 128_000);
    assert.equal(formatWindow(128_000), '128K');
    assert.equal(formatWindow(1_000_000), '1M');
    assert.equal(formatWindow(1_048_576), '1M');
    assert.equal(formatWindow(1_050_000), '1M');
  });

  it('用户填的 > 接口声明的 > 按模型名推断的', () => {
    assert.equal(resolveContextWindow('my-model', { listed: { 'my-model': 262_144 } }), 262_144);
    assert.equal(resolveContextWindow('my-model', { custom: 64_000, listed: { 'my-model': 262_144 } }), 64_000);
    assert.equal(resolveContextWindow('gpt-4o', {}), 128_000);
  });
});

describe('reasoning', () => {
  it('DeepSeek 四档，默认高；旧版关掉深度思考的按关闭', () => {
    assert.deepEqual(reasoningOptions('deepseek', 'deepseek-v4-flash').map((o) => o.id), ['off', 'low', 'high', 'max']);
    assert.equal(effectiveReasoning('deepseek', 'deepseek-v4-flash', undefined), 'high');
    assert.equal(effectiveReasoning('deepseek', 'deepseek-v4-flash', undefined, false), 'off');
    assert.deepEqual(reasoningBody('deepseek', 'max'), { thinking: { type: 'enabled' }, reasoning_effort: 'max' });
    assert.deepEqual(reasoningBody('deepseek', 'off'), { thinking: { type: 'disabled' } });
  });
  it('OpenAI 只有推理模型能调；默认不传参数', () => {
    assert.equal(reasoningOptions('openai', 'gpt-4o').length, 0);
    assert.equal(effectiveReasoning('openai', 'gpt-4o', 'high'), null);
    assert.equal(effectiveReasoning('openai', 'gpt-5.5', 'max'), 'default');
    assert.equal(reasoningBody('openai', 'default'), undefined);
    assert.deepEqual(reasoningBody('custom', 'medium'), { reasoning_effort: 'medium' });
  });
});
