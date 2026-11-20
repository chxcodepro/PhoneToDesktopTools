// 联调脚本：Agent 循环 + 真实电脑端 Core + 按脚本调用工具的假模型（不需要真实 API Key）。
// 用法：先启动 `p2d-core -dev-token e2etoken -no-adb`，再运行
//   npx tsx tests/integration.agent.ts
// 假模型会依次让 Agent：查看系统信息 → 在临时目录写文件 → 修改文件 → 读取文件 → 截图，最后给出总结。
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgent, type AgentTools } from '../src/agent/agent';
import type { FetchLike } from '../src/agent/llm';
import { McpClient } from '../src/protocol/mcpClient';
import type { ToolInfo } from '../src/protocol/types';

const file = join(tmpdir(), `p2d-agent-${Date.now()}.txt`);
const script: { name: string; args: object }[] = [
  { name: 'sys_info', args: {} },
  { name: 'fs_write', args: { path: file, content: '第一行\n待替换\n' } },
  { name: 'fs_edit', args: { path: file, old_string: '待替换', new_string: '已替换' } },
  { name: 'fs_read', args: { path: file } },
  { name: 'screen_capture', args: { max_width: 800 } },
  { name: 'fs_delete', args: { path: file } },
];

async function main() {
  // 假模型：第 n 次请求调用第 n 个工具，最后返回总结；同时检查上一步的工具结果
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const n = body.messages.filter((m: any) => m.role === 'assistant').length;
    const lastTool = [...body.messages].reverse().find((m: any) => m.role === 'tool');
    if (lastTool) seen.push(String(lastTool.content).split('\n')[0]);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (n < script.length) {
      const s = script[n];
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${n}`, type: 'function', function: { name: s.name, arguments: JSON.stringify(s.args) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ choices: [{ delta: { content: '全部完成。' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  const client = new McpClient({
    url: 'ws://127.0.0.1:39271/mcp?token=e2etoken',
    onConnected: (c) => c.setPermissions({ level: 'full', shell: true, fs: true, screen: true, input: true }),
  });
  await new Promise<void>((resolve, reject) => {
    client.onStatus((s) => (s === 'connected' ? resolve() : s === 'unauthorized' ? reject(new Error('令牌无效')) : undefined));
    client.connect();
  });
  let toolList: ToolInfo[] = await client.listTools();
  const tools: AgentTools = { list: () => toolList, call: (name, args) => client.callTool(name, args) };

  const { added, error } = await runAgent([{ role: 'user', content: '测试一下各个工具' }], {
    llm: { baseUrl, apiKey: 'sk-fake', model: 'fake' },
    fetch: fetch as unknown as FetchLike,
    supportsVision: true,
    supportsTools: true,
    tools,
    computer: { host: 'test', os: process.platform === 'win32' ? 'windows' : 'linux' },
    onEvent: (e) => {
      if (e.type === 'tool_start') console.log(`→ ${e.name}  ${e.summary}`);
      if (e.type === 'tool_end') console.log(`  ${e.isError ? '✗' : '✓'} ${e.summary}${e.image ? '（含截图）' : ''}`);
      if (e.type === 'text') process.stdout.write(e.delta);
    },
  });
  console.log('\n消息数：', added.length, '错误：', error?.message ?? '无');
  const hasImage = added.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  console.log('截图已作为图片发给模型：', hasImage ? '是 ✓' : '否 ✗');
  console.log('模型收到的工具结果首行：');
  for (const s of seen) console.log('  ', s);
  client.close();
  server.close();
  toolList = [];
}

main().catch((e) => {
  console.error('联调失败：', e);
  process.exit(1);
});
