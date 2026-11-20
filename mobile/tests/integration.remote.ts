// 联调脚本：远程桌面推流 + 鼠标移动（移到当前位置，不会真的改变鼠标位置）。
// 用法：先启动 `p2d-core -dev-token e2etoken -no-adb`，再运行 npx tsx tests/integration.remote.ts
import { McpClient } from '../src/protocol/mcpClient';

async function main() {
  const client = new McpClient({
    url: 'ws://127.0.0.1:39271/mcp?token=e2etoken',
    onConnected: (c) => c.setPermissions({ level: 'standard', shell: false, fs: false, screen: true, input: true }),
  });
  await new Promise<void>((resolve, reject) => {
    client.onStatus((s) => (s === 'connected' ? resolve() : s === 'unauthorized' ? reject(new Error('令牌无效')) : undefined));
    client.connect();
  });

  let frames = 0;
  let withData = 0;
  let bytes = 0;
  let last: any = null;
  client.onNotification('p2d/screen.frame', (p: any) => {
    frames++;
    if (p.data) {
      withData++;
      bytes += p.data.length * 0.75;
    }
    last = p;
  });
  client.onNotification('p2d/screen.error', (p) => console.log('推流错误：', p));

  const res = await client.request('p2d/screen.start', { maxWidth: 1280, quality: 60, fps: 12 });
  console.log('显示器：', JSON.stringify((res as any).displays));
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`3 秒内收到 ${frames} 帧（含画面 ${withData} 帧，共 ${Math.round(bytes / 1024)} KB）`);
  console.log('最后一帧：', last && { width: last.width, height: last.height, scale: last.scale, cursor: [last.cursorX, last.cursorY] });

  if (last?.cursorX !== undefined) {
    const r = await client.callTool('input_mouse', { action: 'move', x: last.cursorX, y: last.cursorY });
    console.log('鼠标移动到当前位置：', r.isError ? '失败 ✗' : '成功 ✓', r.content[0]);
  }
  await client.request('p2d/screen.stop', {});
  const before = frames;
  await new Promise((r) => setTimeout(r, 1000));
  console.log('停止后是否还有帧：', frames > before ? '有 ✗' : '没有 ✓');
  client.close();
}

main().catch((e) => {
  console.error('联调失败：', e);
  process.exit(1);
});
