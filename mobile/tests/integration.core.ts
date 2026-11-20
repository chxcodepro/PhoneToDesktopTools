// 联调脚本：用手机端真实的 McpClient 连接正在运行的电脑端 p2d-core。
// 用法：先启动 `p2d-core -dev-token e2etoken -no-adb`，再运行
//   npx tsx tests/integration.core.ts [令牌]
// 不属于 npm test（需要真实的电脑端进程）。
import { McpClient } from '../src/protocol/mcpClient';

const token = process.argv[2] ?? 'e2etoken';
const client = new McpClient({
  url: `ws://127.0.0.1:39271/mcp?token=${token}`,
  onConnected: async (c) => {
    await c.setPermissions({ level: 'standard', shell: true, fs: true, screen: true, input: true });
  },
});

async function main() {
  const connected = new Promise<void>((resolve, reject) => {
    client.onStatus((s, d) => {
      console.log('状态：', s, d ?? '');
      if (s === 'connected') resolve();
      if (s === 'unauthorized') reject(new Error('令牌无效'));
    });
  });
  client.connect();
  await connected;
  console.log('电脑端：', client.serverInfo);

  const tools = await client.listTools();
  console.log('工具数：', tools.length, tools.map((t) => t.name).join(', '));

  const info = await client.callTool('sys_info', {});
  console.log('sys_info 成功：', !info.isError);

  const shot = await client.callTool('screen_capture', { max_width: 640 });
  const img = shot.content.find((c) => c.type === 'image');
  console.log('screen_capture：', img ? '收到图片 ✓' : '没有图片 ✗');

  const sh = await client.callTool('shell_exec', { command: 'echo hi' });
  console.log('标准权限下执行命令：', sh.isError ? '被拒绝 ✓' : '竟然执行了 ✗');

  client.close();
  console.log('联调完成');
}

main().catch((e) => {
  console.error('联调失败：', e);
  process.exit(1);
});
