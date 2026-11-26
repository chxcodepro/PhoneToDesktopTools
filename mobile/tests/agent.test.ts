// 模型客户端与 Agent 循环的 Node 测试：用 http 起一个假的 OpenAI 协议服务。
// 运行：npm test

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { buildSystemPrompt, pruneImages, runAgent, SCREENSHOT_MARKER, type AgentEvent, type AgentTools } from '../src/agent/agent';
import { createPcTools, type PcTarget } from '../src/agent/multiPc';
import { chat, configProblem, listModels, LlmError, type ChatMessage, type FetchLike } from '../src/agent/llm';
import type { ToolResult } from '../src/protocol/types';

const nodeFetch = fetch as unknown as FetchLike;
const PNG = 'iVBORw0KGgo='; // 假的图片数据

type Reply =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; calls: { id: string; name: string; args: object }[]; text?: string }
  | { kind: 'json'; text: string }
  | { kind: 'error'; status: number; message: string }
  | { kind: 'hang' };

/** 假的模型服务：按顺序返回预设回复，并记录收到的请求 */
async function startFakeLlm(script: Reply[] | ((body: any, n: number) => Reply)) {
  const requests: any[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/v1/models') {
      if (req.headers.authorization !== 'Bearer sk-test') {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const n = requests.length - 1;
    const reply = typeof script === 'function' ? script(body, n) : (script[n] ?? { kind: 'text', text: '结束' });

    if (reply.kind === 'error') {
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: reply.message } }));
      return;
    }
    if (reply.kind === 'hang') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"思考中"}}]}\n\n');
      return; // 不结束，等待客户端中止
    }
    if (reply.kind === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply.text }, finish_reason: 'stop' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (reply.kind === 'text') {
      // 故意拆成很碎的片段，并把一行 SSE 拆到两次写入中
      for (const ch of reply.text) send({ choices: [{ delta: { content: ch } }] });
      const tail = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;
      res.write(tail.slice(0, 10));
      await new Promise((r) => setTimeout(r, 5));
      res.write(tail.slice(10));
      if (body.stream_options?.include_usage) {
        send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: reply.text.length, prompt_cache_hit_tokens: 80 } });
      }
    } else {
      if (reply.text) send({ choices: [{ delta: { content: reply.text } }] });
      reply.calls.forEach((c, index) => {
        const args = JSON.stringify(c.args);
        send({ choices: [{ delta: { tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] } }] });
        // 参数分两段返回
        send({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(0, 5) } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(5) } }] } }] });
      });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function fakeTools(log: string[] = []): AgentTools {
  return {
    list: () => [
      { name: 'screen_capture', description: '截图', inputSchema: { type: 'object', properties: {} } },
      { name: 'shell_exec', description: '执行命令', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } },
    ],
    async call(name, args): Promise<ToolResult> {
      log.push(`${name} ${JSON.stringify(args)}`);
      if (name === 'screen_capture') {
        return {
          content: [
            { type: 'image', data: PNG, mimeType: 'image/jpeg' },
            { type: 'text', text: '显示器 0：1920x1080' },
          ],
        };
      }
      return { content: [{ type: 'text', text: `退出码：0\nhello` }] };
    },
  };
}

const servers: { close(): Promise<void> }[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

describe('llm', () => {
  it('检查配置是否填写（占位符视为未填）', () => {
    assert.equal(configProblem({ baseUrl: '<YOUR_LLM_BASE_URL>', apiKey: 'k', model: 'm' }), '接口地址未填写');
    assert.equal(configProblem({ baseUrl: 'https://x/v1', apiKey: '', model: 'm' }), 'API Key 未填写');
    assert.equal(configProblem({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }), null);
  });

  it('统计用量：上下文、缓存命中、生成速度', async () => {
    const s = await startFakeLlm([{ kind: 'text', text: '你好，世界' }]);
    servers.push(s);
    const r = await chat({ baseUrl: s.baseUrl, apiKey: 'k', model: 'm' }, [{ role: 'user', content: 'hi' }], nodeFetch);
    assert.deepEqual(s.requests[0].stream_options, { include_usage: true });
    assert.equal(r.stats.promptTokens, 100);
    assert.equal(r.stats.cachedTokens, 80);
    assert.equal(r.stats.completionTokens, 5);
    assert.equal(r.stats.estimated, false);
    assert.ok(r.stats.ttftMs >= 0);
  });

  it('厂商专属参数（DeepSeek 深度思考开关）合并进请求体，且不能覆盖 model / messages', async () => {
    const s = await startFakeLlm([{ kind: 'text', text: '好' }]);
    servers.push(s);
    await chat(
      { baseUrl: s.baseUrl, apiKey: 'k', model: 'm', extraBody: { thinking: { type: 'disabled' }, model: 'x' } },
      [{ role: 'user', content: 'hi' }],
      nodeFetch,
    );
    assert.deepEqual(s.requests[0].thinking, { type: 'disabled' });
    assert.equal(s.requests[0].model, 'm');
  });

  it('服务不支持 stream_options 时去掉后重试', async () => {
    const s = await startFakeLlm((body) =>
      body.stream_options ? { kind: 'error', status: 400, message: 'unknown field `stream_options`' } : { kind: 'text', text: '好' },
    );
    servers.push(s);
    const r = await chat({ baseUrl: s.baseUrl, apiKey: 'k', model: 'm' }, [{ role: 'user', content: 'hi' }], nodeFetch);
    assert.equal(r.message.content, '好');
    assert.equal(s.requests.length, 2);
    assert.equal(r.stats.estimated, true);
  });

  it('网络层失败时给出中文提示；用户取消时原样抛出', async () => {
    const noNetwork: FetchLike = async () => {
      throw new Error('java.net.UnknownHostException: Unable to resolve host "api.deepseek.com": No address associated with hostname');
    };
    await assert.rejects(listModels({ baseUrl: 'https://api.deepseek.com', apiKey: 'k' }, noNetwork), (e: LlmError) => {
      assert.equal(e.status, 0);
      assert.match(e.message, /手机没有网络/);
      return true;
    });

    const ac = new AbortController();
    ac.abort();
    const aborted: FetchLike = async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    await assert.rejects(
      chat({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, [{ role: 'user', content: 'hi' }], aborted, {}, { signal: ac.signal }),
      (e: Error) => e.name === 'AbortError',
    );
  });

  it('获取模型列表；Key 错误时给出中文提示', async () => {
    const s = await startFakeLlm([]);
    servers.push(s);
    assert.deepEqual(await listModels({ baseUrl: s.baseUrl, apiKey: 'sk-test' }, nodeFetch), ['model-a', 'model-b']);
    await assert.rejects(listModels({ baseUrl: s.baseUrl, apiKey: 'wrong' }, nodeFetch), (e: LlmError) => {
      assert.equal(e.status, 401);
      assert.match(e.message, /API Key 无效/);
      return true;
    });
  });

  it('流式文字 + 被拆碎的工具调用参数能正确拼接', async () => {
    const s = await startFakeLlm([
      { kind: 'tool', text: '我先看看。', calls: [{ id: 'c1', name: 'shell_exec', args: { command: 'dir D:\\报表' } }] },
    ]);
    servers.push(s);
    let streamed = '';
    const r = await chat({ baseUrl: s.baseUrl, apiKey: 'sk-test', model: 'm' }, [{ role: 'user', content: 'hi' }], nodeFetch, {
      onText: (d) => (streamed += d),
    });
    assert.equal(streamed, '我先看看。');
    assert.equal(r.message.tool_calls?.[0].function.name, 'shell_exec');
    assert.deepEqual(JSON.parse(r.message.tool_calls![0].function.arguments), { command: 'dir D:\\报表' });
    assert.equal(s.requests[0].stream, true);
  });

  it('服务端忽略 stream 直接返回 JSON 时也能解析', async () => {
    const s = await startFakeLlm([{ kind: 'json', text: '你好' }]);
    servers.push(s);
    const r = await chat({ baseUrl: s.baseUrl, apiKey: 'sk-test', model: 'm' }, [{ role: 'user', content: 'hi' }], nodeFetch);
    assert.equal(r.message.content, '你好');
  });

  it('接口要求回传 reasoning_content 时自动带上重试', async () => {
    const s = await startFakeLlm((body) => {
      const a = body.messages.find((m: any) => m.role === 'assistant');
      if (a && a.reasoning_content === undefined) return { kind: 'error', status: 400, message: 'Missing reasoning_content field' };
      return { kind: 'text', text: 'ok' };
    });
    servers.push(s);
    const history: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: '想一想',
        tool_calls: [{ id: 'x', type: 'function', function: { name: 'a', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'x', content: 'done' },
    ];
    const r = await chat({ baseUrl: s.baseUrl, apiKey: 'sk-test', model: 'm' }, history, nodeFetch);
    assert.equal(r.message.content, 'ok');
    assert.equal(s.requests.length, 2);
  });
});

describe('agent', () => {
  it('支持图片的模型：截图作为图片发给模型，最终给出回答', async () => {
    const s = await startFakeLlm([
      { kind: 'tool', calls: [{ id: 'c1', name: 'screen_capture', args: {} }] },
      { kind: 'text', text: '屏幕上是桌面。' },
    ]);
    servers.push(s);
    const events: AgentEvent[] = [];
    const log: string[] = [];
    const { added, error } = await runAgent([{ role: 'user', content: '看看屏幕' }], {
      llm: { baseUrl: s.baseUrl, apiKey: 'sk-test', model: 'm' },
      fetch: nodeFetch,
      supportsVision: true,
      supportsTools: true,
      tools: fakeTools(log),
      computer: { host: 'DESKTOP-01', os: 'windows' },
      onEvent: (e) => events.push(e),
    });
    assert.equal(error, undefined);
    assert.deepEqual(log, ['screen_capture {}']);
    assert.deepEqual(
      added.map((m) => m.role),
      ['assistant', 'tool', 'user', 'assistant'],
    );
    assert.equal(added[3].content, '屏幕上是桌面。');

    // 第二次请求：带了系统提示、工具定义、截图图片
    const second = s.requests[1];
    assert.equal(second.messages[0].role, 'system');
    assert.match(second.messages[0].content, /DESKTOP-01/);
    assert.equal(second.tools.length, 2);
    const imgMsg = second.messages[second.messages.length - 1];
    assert.equal(imgMsg.content[1].image_url.url, `data:image/jpeg;base64,${PNG}`);

    const end = events.find((e) => e.type === 'tool_end');
    assert.ok(end && end.type === 'tool_end' && end.image?.data === PNG);
  });

  it('不支持图片的模型：截图改为文字识别结果，不发送图片', async () => {
    const s = await startFakeLlm([
      { kind: 'tool', calls: [{ id: 'c1', name: 'screen_capture', args: {} }] },
      { kind: 'text', text: '好的' },
    ]);
    servers.push(s);
    const log: string[] = [];
    let context: string | undefined;
    const { added } = await runAgent([{ role: 'user', content: '看看屏幕' }], {
      llm: { baseUrl: s.baseUrl, apiKey: 'sk-test', model: 'm' },
      fetch: nodeFetch,
      supportsVision: false,
      supportsTools: true,
      tools: fakeTools(log),
      describeImage: async (_d, _m, ctx) => {
        context = ctx;
        return '「确定」 (100, 200)';
      },
    });
    assert.deepEqual(
      added.map((m) => m.role),
      ['assistant', 'tool', 'assistant'],
    );
    assert.match(String(added[1].content), /确定/);
    // 截图只给手机识别：用更高分辨率；识别时拿到工具的说明文字（含坐标换算公式）
    assert.match(log[0], /"max_width":2560/);
    assert.match(context ?? '', /1920x1080/);
    assert.ok(!JSON.stringify(s.requests[1]).includes('image_url'));
    assert.match(s.requests[0].messages[0].content, /看不到图片/);
  });

  it('中途停止：返回的历史仍然合法（每个工具调用都有结果）', async () => {
    const s = await startFakeLlm([
      {
        kind: 'tool',
        calls: [
          { id: 'c1', name: 'shell_exec', args: { command: 'a' } },
          { id: 'c2', name: 'shell_exec', args: { command: 'b' } },
        ],
      },
    ]);
    servers.push(s);
    const ctrl = new AbortController();
    const tools = fakeTools();
    const slow: AgentTools = {
      list: tools.list,
      async call(name, args) {
        ctrl.abort(); // 执行第一个工具时用户点了停止
        return tools.call(name, args);
      },
    };
    const { added, error } = await runAgent([{ role: 'user', content: '做事' }], {
      llm: { baseUrl: s.baseUrl, apiKey: 'sk-test', model: 'm' },
      fetch: nodeFetch,
      supportsVision: true,
      supportsTools: true,
      tools: slow,
      signal: ctrl.signal,
    });
    assert.equal(error?.name, 'AbortError');
    const ids = added
      .filter((m) => m.role === 'tool')
      .map((m) => m.tool_call_id)
      .sort();
    assert.deepEqual(ids, ['c1', 'c2']);
  });

  it('等待模型时停止：立即返回', async () => {
    const s = await startFakeLlm([{ kind: 'hang' }]);
    servers.push(s);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const started = Date.now();
    const { error } = await runAgent([{ role: 'user', content: 'hi' }], {
      llm: { baseUrl: s.baseUrl, apiKey: 'sk-test', model: 'm' },
      fetch: nodeFetch,
      supportsVision: true,
      supportsTools: true,
      tools: fakeTools(),
      signal: ctrl.signal,
    });
    assert.equal(error?.name, 'AbortError');
    assert.ok(Date.now() - started < 2000);
  });

  it('电脑未连接时不发送工具定义', async () => {
    const s = await startFakeLlm([{ kind: 'text', text: '请先连接电脑' }]);
    servers.push(s);
    await runAgent([{ role: 'user', content: '打开记事本' }], {
      llm: { baseUrl: s.baseUrl, apiKey: 'sk-test', model: 'm' },
      fetch: nodeFetch,
      supportsVision: true,
      supportsTools: true,
      tools: null,
    });
    assert.equal(s.requests[0].tools, undefined);
    assert.match(s.requests[0].messages[0].content, /未连接/);
  });

  it('模型不支持图片时去掉图片重试，并提示用户', async () => {
    const s = await startFakeLlm((body) =>
      JSON.stringify(body.messages).includes('image_url')
        ? { kind: 'error', status: 400, message: 'Failed to deserialize: unknown variant `image_url`, expected `text`' }
        : { kind: 'text', text: '看不到图片' },
    );
    servers.push(s);
    const events: AgentEvent[] = [];
    const history: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是什么' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${PNG}` } },
        ],
      },
    ];
    const r = await runAgent(history, {
      llm: { baseUrl: s.baseUrl, apiKey: 'k', model: 'm' },
      fetch: nodeFetch,
      supportsVision: true,
      supportsTools: true,
      tools: null,
      onEvent: (e) => events.push(e),
    });
    assert.equal(r.error, undefined);
    assert.equal(s.requests.length, 2);
    assert.ok(!JSON.stringify(s.requests[1].messages).includes('image_url'));
    assert.ok(events.some((e) => e.type === 'notice' && /不支持图片/.test(e.text)));
    assert.ok(events.some((e) => e.type === 'usage'));
  });

  it('声称支持图片但接口拒收后：之后的截图改用文字识别', async () => {
    let calls = 0;
    const s = await startFakeLlm((body) => {
      if (JSON.stringify(body.messages).includes('image_url'))
        return { kind: 'error', status: 400, message: 'unknown variant `image_url`, expected `text`' };
      calls++;
      return calls <= 2 ? { kind: 'tool', calls: [{ id: `c${calls}`, name: 'screen_capture', args: {} }] } : { kind: 'text', text: '好' };
    });
    servers.push(s);
    const log: string[] = [];
    const r = await runAgent([{ role: 'user', content: '看屏幕' }], {
      llm: { baseUrl: s.baseUrl, apiKey: 'k', model: 'm' },
      fetch: nodeFetch,
      supportsVision: true,
      supportsTools: true,
      tools: fakeTools(log),
      describeImage: async () => '(10, 20) 开始',
    });
    assert.equal(r.error, undefined);
    // 第一张截图被拒后，第二次截图用高分辨率并换成识别结果
    assert.match(log[1], /"max_width":2560/);
    const toolTexts = r.added.filter((m) => m.role === 'tool').map((m) => String(m.content));
    assert.match(toolTexts[1], /开始/);
    const last = s.requests[s.requests.length - 1];
    assert.match(last.messages[0].content, /看不到图片/);
  });

  it('用户上传的图片单独计数，不会被截图挤掉', () => {
    const shot = (n: number): ChatMessage => ({
      role: 'user',
      content: [
        { type: 'text', text: SCREENSHOT_MARKER },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,s${n}` } },
      ],
    });
    const upload: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: '看看这张图' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,u1' } },
      ],
    };
    const out = JSON.stringify(pruneImages([upload, shot(1), shot(2)]));
    assert.ok(out.includes('base64,u1'));
    assert.ok(!out.includes('base64,s1'));
    assert.ok(out.includes('base64,s2'));
  });

  it('只保留最近一张截图', () => {
    const img = (n: number): ChatMessage => ({
      role: 'user',
      content: [
        { type: 'text', text: SCREENSHOT_MARKER },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${n}` } },
      ],
    });
    const out = pruneImages([img(1), { role: 'assistant', content: 'x' }, img(2)]);
    assert.ok(JSON.stringify(out[0]).includes('较早的截图已省略'));
    assert.ok(JSON.stringify(out[2]).includes('base64,2'));
  });
});

describe('agent 多台电脑', () => {
  it('不同电脑的调用同时执行，同一台按顺序；结果按调用顺序写回；提示词说明多台电脑', async () => {
    const s = await startFakeLlm([
      {
        kind: 'tool',
        calls: [
          { id: 'c1', name: 'shell_exec', args: { pc: 'A', command: 'a1' } },
          { id: 'c2', name: 'shell_exec', args: { pc: 'B', command: 'b1' } },
          { id: 'c3', name: 'shell_exec', args: { pc: 'A', command: 'a2' } },
          { id: 'c4', name: 'screen_capture', args: { pc: 'B' } },
        ],
      },
      { kind: 'text', text: '两台都好了。' },
    ]);
    servers.push(s);
    const timeline: string[] = [];
    const target = (id: string): PcTarget => ({
      id,
      name: id.toUpperCase(),
      os: id === 'a' ? 'windows' : 'linux',
      tools: fakeTools().list(),
      async call(name, args) {
        timeline.push(`start ${id}:${String(args.command ?? name)}`);
        await new Promise((r) => setTimeout(r, 60));
        timeline.push(`end ${id}:${String(args.command ?? name)}`);
        if (name === 'screen_capture') return { content: [{ type: 'image', data: PNG, mimeType: 'image/jpeg' }] };
        return { content: [{ type: 'text', text: `ran ${String(args.command)}` }] };
      },
    });
    const set = createPcTools(() => [target('a'), target('b')]);
    const { added, error } = await runAgent([{ role: 'user', content: '两台都看看' }], {
      llm: { baseUrl: s.baseUrl, apiKey: 'sk-test', model: 'm' },
      fetch: nodeFetch,
      supportsVision: true,
      supportsTools: true,
      tools: set,
      computers: [
        { host: 'A', os: 'windows' },
        { host: 'B', os: 'linux' },
      ],
    });
    assert.equal(error, undefined);
    // B 的第一个调用不用等 A 的调用结束；A 的两个调用按顺序
    assert.ok(timeline.indexOf('start b:b1') < timeline.indexOf('end a:a1'), timeline.join(' | '));
    assert.ok(timeline.indexOf('end a:a1') < timeline.indexOf('start a:a2'), timeline.join(' | '));
    assert.ok(timeline.indexOf('end b:b1') < timeline.indexOf('start b:screen_capture'), timeline.join(' | '));

    const tools = added.filter((m) => m.role === 'tool');
    assert.deepEqual(
      tools.map((m) => m.tool_call_id),
      ['c1', 'c2', 'c3', 'c4'],
    );
    assert.equal(tools[0].content, '【A】ran a1');
    assert.equal(tools[1].content, '【B】ran b1');
    assert.match(String(tools[3].content), /【B】[\s\S]*截图见下一条消息的第 1 张图/);

    const second = s.requests[1];
    const sys = second.messages[0].content as string;
    assert.match(sys, /同时连接着用户的 2 台电脑：「A」（Windows）、「B」（Linux/);
    assert.match(sys, /pc 参数/);
    assert.match(sys, /Windows 电脑使用 cmd 语法/);
    assert.match(sys, /Linux 电脑使用 bash 语法/);
    const shell = second.tools.find((t: any) => t.function.name === 'shell_exec');
    assert.deepEqual(shell.function.parameters.required, ['pc']);
    assert.deepEqual(shell.function.parameters.properties.pc.enum, ['A', 'B']);
  });

  it('只连一台时提示词和工具都不变', () => {
    const p = buildSystemPrompt({ tools: fakeTools(), supportsTools: true, supportsVision: true, computer: { host: 'PC1', os: 'linux' } });
    assert.doesNotMatch(p, /pc 参数/);
    assert.match(p, /命令：使用 bash 语法/);
    assert.doesNotMatch(p, /cmd 语法/);
  });

  it('Mac：用 zsh、open -a、Command 快捷键，排查办法用 macOS 的命令', () => {
    const p = buildSystemPrompt({ tools: fakeTools(), supportsTools: true, supportsVision: true, computer: { host: 'MBP', os: 'darwin' } });
    assert.match(p, /（MBP，macOS）/);
    assert.match(p, /命令：使用 zsh 语法.*open -a/);
    assert.match(p, /networksetup/);
    assert.doesNotMatch(p, /cmd 语法|pnputil/);
  });
});
