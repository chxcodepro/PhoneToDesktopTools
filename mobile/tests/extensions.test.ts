// 扩展（M7）：远程 MCP 客户端、mcpServers 配置解析、工具改名、SKILL.md 解析、GitHub 导入地址、扩展工具的确认流程。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSystemPrompt } from '../src/agent/agent';
import {
  createExtensionTools,
  isExtensionTool,
  type ExtensionApi,
  type ServerStatus,
  type SkillPackage,
} from '../src/agent/extensionTools';
import {
  assignPrefixes,
  buildSkillMd,
  findSkillRoots,
  gitZipSource,
  mcpToolName,
  parseMcpConfig,
  parseSkillMd,
  safeRelPath,
  scriptCommand,
  type McpDraft,
  type McpServer,
  type Skill,
} from '../src/agent/extensions';
import type { AskAnswer } from '../src/agent/phoneTools';
import { normalizeResult, parseSse, RemoteMcp, resolveUrl, SseParser, type McpFetch, type McpFetchResponse } from '../src/protocol/httpMcp';

function resp(status: number, body: string, headers: Record<string, string> = {}, stream?: ReadableStream<Uint8Array>): McpFetchResponse {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => h[n.toLowerCase()] ?? null },
    text: async () => body,
    body: stream ?? null,
  };
}

describe('SSE 解析', () => {
  it('完整文本和任意切分的数据得到相同的事件', () => {
    const text = 'event: endpoint\ndata: /messages?sid=1\n\n: 注释\ndata: {"a":1}\ndata: {"b":2}\n\n';
    const all = parseSse(text);
    assert.deepEqual(
      all.map((e) => [e.event, e.data]),
      [
        ['endpoint', '/messages?sid=1'],
        ['message', '{"a":1}\n{"b":2}'],
      ],
    );
    const p = new SseParser();
    const got = [...text].flatMap((ch) => p.push(ch));
    assert.deepEqual(got, all);
  });

  it('相对地址解析', () => {
    assert.equal(resolveUrl('https://a.com/mcp/sse', '/messages?x=1'), 'https://a.com/messages?x=1');
    assert.equal(resolveUrl('https://a.com/mcp/sse', 'messages'), 'https://a.com/mcp/messages');
    assert.equal(resolveUrl('https://a.com/sse', 'https://b.com/m'), 'https://b.com/m');
  });

  it('工具结果统一成文字和图片', () => {
    const r = normalizeResult({
      content: [
        { type: 'text', text: 'hi' },
        { type: 'audio', data: 'x' },
        { type: 'resource', resource: { uri: 'file:///a', text: '内容' } },
      ],
      isError: true,
    });
    assert.equal(r.isError, true);
    assert.deepEqual(
      r.content.map((c) => (c.type === 'text' ? c.text : c.type)),
      ['hi', '[audio 内容，手机端无法显示]', '内容'],
    );
    assert.match((normalizeResult({ structuredContent: { a: 1 } }).content[0] as { text: string }).text, /"a":1/);
  });
});

describe('远程 MCP：Streamable HTTP', () => {
  it('握手、带会话 ID、SSE 响应、分页、会话过期后重连', async () => {
    const calls: { method: string; sid: string | null; auth?: string }[] = [];
    let sessions = 0;
    let expired = false;
    const fetch: McpFetch = async (_url, init) => {
      if (init.method === 'DELETE') return resp(200, '');
      const msg = JSON.parse(init.body ?? '{}');
      calls.push({ method: msg.method, sid: init.headers['Mcp-Session-Id'] ?? null, auth: init.headers.Authorization });
      if (msg.method === 'initialize') {
        sessions++;
        expired = false;
        return resp(
          200,
          JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'demo' } } }),
          {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': `s${sessions}`,
          },
        );
      }
      if (msg.method === 'notifications/initialized') return resp(202, '');
      if (msg.method === 'tools/list') {
        const page = msg.params?.cursor ? { tools: [{ name: 'b' }] } : { tools: [{ name: 'a' }], nextCursor: 'c2' };
        return resp(200, `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: page })}\n\n`, {
          'Content-Type': 'text/event-stream',
        });
      }
      if (msg.method === 'tools/call') {
        if (expired) return resp(404, 'session not found');
        return resp(
          200,
          // 先来一条进度通知，再来结果
          `data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo ${msg.params.arguments.q}` }] } })}\n\n`,
          { 'Content-Type': 'text/event-stream' },
        );
      }
      return resp(500, '');
    };
    const c = new RemoteMcp({ url: 'https://x.com/mcp', headers: { Authorization: 'Bearer t' }, fetch });
    assert.equal(c.transport, 'http');
    const tools = await c.connect();
    assert.deepEqual(
      tools.map((t) => t.name),
      ['a', 'b'],
    );
    assert.equal(c.serverName, 'demo');
    assert.equal(calls.find((x) => x.method === 'tools/list')?.sid, 's1');
    assert.equal(calls[0].auth, 'Bearer t');
    const r = await c.callTool('a', { q: '你好' });
    assert.equal((r.content[0] as { text: string }).text, 'echo 你好');
    expired = true;
    const r2 = await c.callTool('a', { q: '再来' });
    assert.equal((r2.content[0] as { text: string }).text, 'echo 再来');
    assert.equal(sessions, 2, '会话过期后应重新握手');
  });

  it('鉴权失败给出明确提示', async () => {
    const c = new RemoteMcp({ url: 'https://x.com/mcp', fetch: async () => resp(401, 'no') });
    await assert.rejects(c.connect(), /鉴权失败/);
  });
});

describe('远程 MCP：旧版 SSE', () => {
  it('从事件流拿 endpoint，请求 POST 过去、结果从事件流返回', async () => {
    const enc = new TextEncoder();
    let push: (s: string) => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        push = (s) => ctl.enqueue(enc.encode(s));
      },
    });
    const posts: string[] = [];
    const fetch: McpFetch = async (url, init) => {
      if (init.method === 'GET') {
        setTimeout(() => push('event: endpoint\ndata: /messages?sessionId=9\n\n'), 5);
        return resp(200, '', { 'Content-Type': 'text/event-stream' }, stream);
      }
      posts.push(url);
      const msg = JSON.parse(init.body ?? '{}');
      if (msg.id !== undefined) {
        const result =
          msg.method === 'initialize'
            ? { protocolVersion: '2024-11-05', serverInfo: { name: 'old' } }
            : msg.method === 'tools/list'
              ? { tools: [{ name: 'weather' }] }
              : { content: [{ type: 'text', text: '晴' }] };
        setTimeout(() => push(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`), 5);
      }
      return resp(202, 'Accepted');
    };
    const c = new RemoteMcp({ url: 'https://amap.example.com/sse?key=k', fetch });
    assert.equal(c.transport, 'sse');
    const tools = await c.connect();
    assert.deepEqual(
      tools.map((t) => t.name),
      ['weather'],
    );
    assert.ok(posts.every((u) => u === 'https://amap.example.com/messages?sessionId=9'));
    const r = await c.callTool('weather', { city: '北京' });
    assert.equal((r.content[0] as { text: string }).text, '晴');
    c.close();
  });
});

describe('远程 MCP：自动换传输方式', () => {
  it('Streamable HTTP 不支持（405）时改用旧版 SSE', async () => {
    const enc = new TextEncoder();
    let push: (s: string) => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        push = (x) => ctl.enqueue(enc.encode(x));
      },
    });
    const fetch: McpFetch = async (url, init) => {
      if (init.method === 'GET') {
        setTimeout(() => push('event: endpoint\ndata: /msg\n\n'), 5);
        return resp(200, '', {}, stream);
      }
      if (url === 'https://old.com/mcp') return resp(405, 'Method Not Allowed');
      const msg = JSON.parse(init.body ?? '{}');
      if (msg.id !== undefined) {
        const result =
          msg.method === 'tools/list' ? { tools: [{ name: 't' }] } : { protocolVersion: '2024-11-05', serverInfo: { name: 'old' } };
        setTimeout(() => push(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`), 5);
      }
      return resp(202, '');
    };
    const c = new RemoteMcp({ url: 'https://old.com/mcp', fetch });
    assert.equal(c.transport, 'http');
    const tools = await c.connect();
    assert.equal(c.transport, 'sse');
    assert.equal(tools[0].name, 't');
    c.close();
  });
});

describe('mcpServers 配置和工具名', () => {
  it('解析地址、Claude Desktop 格式、单个对象', () => {
    const a = parseMcpConfig('https://mcp.amap.com/sse?key=abc') as McpDraft[];
    assert.equal(a[0].kind, 'remote');
    assert.equal(a[0].name, 'amap');
    const b = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          fetch: { command: 'uvx', args: ['mcp-server-fetch'] },
          search: { type: 'sse', url: 'https://s.com/sse', headers: { Authorization: 'Bearer x' } },
          gh: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 't' } },
        },
      }),
    ) as McpDraft[];
    assert.deepEqual(
      b.map((d) => [d.name, d.kind]),
      [
        ['fetch', 'pc'],
        ['search', 'remote'],
        ['gh', 'pc'],
      ],
    );
    assert.equal(b[1].transport, 'sse');
    assert.equal(b[2].env.GITHUB_TOKEN, 't');
    assert.equal(typeof parseMcpConfig('{"mcpServers":{"x":{}}}'), 'string');
    assert.equal(typeof parseMcpConfig('ftp://x'), 'string');
    assert.equal(typeof parseMcpConfig('{"url":"file:///x"}'), 'string');
  });

  it('工具名：前缀不重复、符合 64 字符限制', () => {
    const p = assignPrefixes([
      { id: '1', name: 'GitHub' },
      { id: '2', name: 'github' },
      { id: '3', name: '高德地图' },
    ]);
    assert.equal(p.get('1'), 'github');
    assert.equal(p.get('2'), 'github_2');
    assert.match(p.get('3')!, /^m[0-9a-f]{6}$/);
    const long = mcpToolName('github', 'x'.repeat(100));
    assert.ok(long.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(long));
    assert.equal(mcpToolName('fs', 'read.file'), 'fs__read_file');
    assert.ok(isExtensionTool('fs__read_file') && isExtensionTool('skill_run') && !isExtensionTool('shell_exec'));
  });
});

describe('Skill', () => {
  it('解析 SKILL.md 的 frontmatter（含多行写法），生成的文本能再解析回来', () => {
    const s = parseSkillMd('---\nname: excel-report\ndescription: >\n  汇总多个 Excel\n  生成报表\nlicense: MIT\n---\n# 步骤\n1. 打开');
    assert.ok(typeof s !== 'string');
    assert.equal(s.name, 'excel-report');
    assert.equal(s.description, '汇总多个 Excel 生成报表');
    assert.match(s.body, /^# 步骤/);
    assert.equal(typeof parseSkillMd('# 没有 frontmatter'), 'string');
    assert.equal(typeof parseSkillMd('---\nname: x\n---\n'), 'string');
    const md = buildSkillMd('log-check', '排查日志: 错误和警告', '1. 读日志');
    const back = parseSkillMd(md);
    assert.ok(typeof back !== 'string' && back.description === '排查日志: 错误和警告');
  });

  it('zip 里找 Skill 根目录，子目录过滤，嵌套只取外层', () => {
    const paths = [
      'repo-main/README.md',
      'repo-main/skills/a/SKILL.md',
      'repo-main/skills/a/x.ps1',
      'repo-main/skills/b/skill.md',
      'repo-main/skills/b/ex/SKILL.md',
    ];
    assert.deepEqual(findSkillRoots(paths), ['repo-main/skills/a/', 'repo-main/skills/b/']);
    assert.deepEqual(findSkillRoots(paths, 'skills/a'), ['repo-main/skills/a/']);
    assert.deepEqual(findSkillRoots(['SKILL.md', 'scripts/run.sh']), ['']);
  });

  it('GitHub 地址转 zip 下载地址', () => {
    assert.deepEqual(gitZipSource('https://github.com/anthropics/skills'), {
      zipUrl: 'https://codeload.github.com/anthropics/skills/zip/HEAD',
      subdir: '',
      label: 'anthropics/skills',
    });
    const t = gitZipSource('https://github.com/o/r/tree/main/document-skills/xlsx')!;
    assert.equal(t.zipUrl, 'https://codeload.github.com/o/r/zip/refs/heads/main');
    assert.equal(t.subdir, 'document-skills/xlsx');
    assert.equal(gitZipSource('https://github.com/o/r/blob/dev/pdf/SKILL.md')!.subdir, 'pdf');
    assert.equal(gitZipSource('https://gitee.com/o/r'), null);
  });

  it('路径安全和脚本执行命令', () => {
    assert.equal(safeRelPath('scripts\\a.ps1'), 'scripts/a.ps1');
    assert.equal(safeRelPath('../x'), null);
    assert.equal(safeRelPath('C:/x'), null);
    assert.equal(
      scriptCommand('windows', 'C:\\s\\a.ps1', '-Path "D:\\x"'),
      'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\s\\a.ps1" -Path "D:\\x"',
    );
    assert.equal(scriptCommand('windows', 'C:\\s\\a.bat', ''), 'call "C:\\s\\a.bat"');
    assert.equal(scriptCommand('linux', '/s/a.sh', 'x'), 'bash "/s/a.sh" x');
    assert.equal(scriptCommand('linux', '/s/a.py', ''), 'python3 "/s/a.py"');
  });
});

describe('扩展工具', () => {
  function fakeApi() {
    const servers: McpServer[] = [
      {
        id: 'm1',
        name: 'Weather',
        kind: 'remote',
        url: 'https://w.com/mcp',
        enabled: true,
        disabledTools: ['secret'],
        createdBy: 'user',
        addedAt: 0,
      },
    ];
    const skills: Skill[] = [
      {
        id: 's1',
        name: 'log-check',
        description: '排查日志',
        enabled: true,
        files: [
          { path: 'SKILL.md', size: 10 },
          { path: 'run.ps1', size: 5 },
        ],
        hash: 'abcd1234',
        createdBy: 'user',
        installedAt: 0,
      },
    ];
    const status: Record<string, ServerStatus> = {
      m1: { state: 'ready', tools: [{ name: 'forecast', description: '天气预报' }, { name: 'secret' }] },
    };
    const log: string[] = [];
    const api: ExtensionApi = {
      servers: () => servers,
      skills: () => skills,
      status: (id) => status[id],
      prefixes: () => assignPrefixes(servers),
      callMcp: async (sid, tool, args) => {
        log.push(`call ${sid} ${tool} ${JSON.stringify(args)}`);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      readSkill: async (_id, path) => `内容 ${path ?? 'SKILL.md'}`,
      runSkill: async (_id, script, args) => {
        log.push(`run ${script} ${args}`);
        return { content: [{ type: 'text', text: 'done' }] };
      },
      addServers: async (drafts) => {
        const added = drafts.map((d, i) => ({
          id: `n${i}`,
          name: d.name,
          kind: d.kind,
          url: d.url,
          secrets: Object.keys(d.headers),
          enabled: true,
          disabledTools: [],
          createdBy: 'agent' as const,
          addedAt: 0,
        }));
        servers.push(...added);
        return added;
      },
      prepareSkillFromUrl: async (url): Promise<SkillPackage> => ({
        source: url,
        skills: [{ name: 'pdf', description: '处理 PDF', files: ['SKILL.md', 'scripts/fill.py'] }],
        commit: async () => {
          log.push('commit pdf');
          return [];
        },
      }),
      prepareSkill: (input) => ({
        source: '对话',
        skills: [{ name: input.name, description: input.description, files: ['SKILL.md'] }],
        commit: async () => [],
      }),
      setEnabled: (kind, id, v) => log.push(`toggle ${kind} ${id} ${v}`),
      remove: async (kind, id) => {
        log.push(`remove ${kind} ${id}`);
      },
    };
    return { api, log };
  }

  it('MCP 工具改名合并、停用的工具不出现，调用转发到原始工具名', async () => {
    const { api, log } = fakeApi();
    const t = createExtensionTools({ api });
    const names = t.list().map((x) => x.name);
    assert.ok(names.includes('weather__forecast'));
    assert.ok(!names.includes('weather__secret'));
    assert.ok(names.includes('skill_read') && names.includes('ext_list'));
    assert.ok(!names.includes('ext_add_mcp'), '没有确认卡片时不提供安装类工具');
    await t.call('weather__forecast', { city: '上海' });
    assert.equal(log[0], 'call m1 forecast {"city":"上海"}');
    assert.match(t.list().find((x) => x.name === 'weather__forecast')!.description ?? '', /^\[MCP · Weather\]/);
  });

  it('skill_read 附带文件列表，skill_run 检查脚本存在', async () => {
    const { api, log } = fakeApi();
    const t = createExtensionTools({ api });
    const r = await t.call('skill_read', { name: 'LOG-CHECK' });
    assert.match((r.content[0] as { text: string }).text, /附带文件：run\.ps1/);
    assert.equal((await t.call('skill_run', { name: 'log-check', script: 'nope.ps1' })).isError, true);
    await t.call('skill_run', { name: 'log-check', script: 'run.ps1', args: '-Days 3' });
    assert.equal(log.at(-1), 'run run.ps1 -Days 3');
  });

  it('安装类操作先弹确认卡片，取消就不安装', async () => {
    const { api, log } = fakeApi();
    let answer = '取消';
    const questions: string[] = [];
    const askUser = async (q: { question: string }): Promise<AskAnswer> => {
      questions.push(q.question);
      return { selected: [answer] };
    };
    const t = createExtensionTools({ api, askUser });
    const r1 = await t.call('ext_add_mcp', { url: 'https://mcp.example.com/mcp', name: '搜索', headers: { Authorization: '' } });
    assert.match((r1.content[0] as { text: string }).text, /取消/);
    assert.equal(api.servers().length, 1);
    answer = '安装';
    const r2 = await t.call('ext_add_mcp', { url: 'https://mcp.example.com/mcp', name: '搜索', headers: { Authorization: '' } });
    assert.equal(api.servers().length, 2);
    assert.match((r2.content[0] as { text: string }).text, /需要填写 Authorization/);
    assert.match(questions[0], /远程 MCP/);

    await t.call('ext_install_skill', { url: 'https://github.com/o/r' });
    assert.match(questions.at(-1)!, /包含脚本：scripts\/fill\.py/);
    assert.equal(log.at(-1), 'commit pdf');

    answer = '卸载';
    await t.call('ext_remove', { name: 'weather' });
    assert.equal(log.at(-1), 'remove mcp m1');
    await t.call('ext_toggle', { name: 'log-check', enabled: false });
    assert.equal(log.at(-1), 'toggle skill s1 false');
  });

  it('电脑未连接时系统提示词说明只能用手机端工具，扩展说明放在后面', () => {
    const tools = { list: () => [], call: async () => ({ content: [] }) };
    const p = buildSystemPrompt({
      tools,
      supportsTools: true,
      supportsVision: true,
      pcConnected: false,
      extensionPrompt: ['- 扩展说明 X'],
    });
    assert.match(p, /电脑当前未连接，电脑上的工具/);
    assert.match(p, /扩展说明 X/);
    assert.doesNotMatch(p, /screen_capture/);
    const p2 = buildSystemPrompt({ tools, supportsTools: true, supportsVision: true });
    assert.match(p2, /sys_info/);
  });
});
