// mcpClient 的 Node 测试：用 ws 起一个假的 MCP 服务端（模拟电脑端 Core）。
// 运行：npm test

import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

import { buildWsUrl, parseConnectUrl, parseDraftUrl } from '../src/protocol/deepLink';
import { McpClient, type WebSocketLike } from '../src/protocol/mcpClient';
import { CLOSE_BY_PC, type ConnectionStatus, type Permissions } from '../src/protocol/types';

const TOKEN = 'testtoken0123456789abcdef01234567';

interface FakeServerOptions {
  /** 是否响应 ping，默认 true */
  answerPing?: boolean;
}

/** 假的电脑端：校验令牌、响应 MCP 方法 */
async function startFakeServer(opts: FakeServerOptions = {}) {
  const received: { method: string; params: unknown }[] = [];
  const sockets: WebSocket[] = [];
  let handshakes = 0;
  let answerPing = opts.answerPing ?? true;

  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    path: '/mcp',
    verifyClient: (
      info: { req: IncomingMessage },
      cb: (ok: boolean, code?: number, msg?: string) => void,
    ) => {
      handshakes++;
      const url = new URL(info.req.url ?? '', 'http://x');
      if (url.searchParams.get('token') === TOKEN) cb(true);
      else cb(false, 401, 'Unauthorized');
    },
  });
  await new Promise<void>((r) => wss.once('listening', () => r()));

  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      received.push({ method: msg.method, params: msg.params });
      if (msg.id === undefined) return; // 通知
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      switch (msg.method) {
        case 'initialize':
          reply({
            protocolVersion: msg.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-core', version: '0.0.1' },
          });
          break;
        case 'ping':
          if (answerPing) reply({});
          break;
        case 'tools/list':
          reply({
            tools: [
              { name: 'sys_info', description: '系统信息', inputSchema: { type: 'object' } },
              { name: 'fs_read', description: '读文件', inputSchema: { type: 'object' } },
            ],
          });
          break;
        case 'tools/call':
          if (msg.params.name === 'slow') break; // 一直不回（模拟长时间运行的命令）
          if (msg.params.name === 'sys_info') {
            reply({ content: [{ type: 'text', text: 'hostname: TEST-PC' }] });
          } else {
            reply({ content: [{ type: 'text', text: '没有权限' }], isError: true });
          }
          break;
        case 'p2d/setPermissions':
          reply({});
          break;
        default:
          ws.send(
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }),
          );
      }
    });
  });

  const port = (wss.address() as AddressInfo).port;
  return {
    port,
    received,
    get handshakes() {
      return handshakes;
    },
    setAnswerPing(v: boolean) {
      answerPing = v;
    },
    /** 以指定的关闭码关闭所有客户端（模拟电脑上点「断开」） */
    closeAll(code: number, reason: string) {
      for (const s of sockets) s.close(code, reason);
      sockets.length = 0;
    },
    /** 强制断开所有客户端（模拟拔线） */
    dropAll() {
      for (const s of sockets) s.terminate();
      sockets.length = 0;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.terminate();
        wss.close(() => r());
      }),
  };
}

const nodeSocket = (url: string) => new WebSocket(url) as unknown as WebSocketLike;

/** 等待客户端进入指定状态 */
function waitStatus(client: McpClient, want: ConnectionStatus, timeoutMs = 5000): Promise<void> {
  if (client.status === want) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`等待状态 ${want} 超时，当前 ${client.status}`));
    }, timeoutMs);
    const off = client.onStatus((s) => {
      if (s === want) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('deepLink', () => {
  it('填入输入框的链接：只认 draft 参数，连接链接不受影响', () => {
    assert.equal(parseDraftUrl('p2d://?draft=%E4%BD%A0%E5%A5%BD+world'), '你好 world');
    assert.equal(parseDraftUrl('p2d://agent?x=1&draft=hi'), 'hi');
    assert.equal(parseDraftUrl('p2d://?draft='), null);
    assert.equal(parseDraftUrl(`p2d://connect?token=${TOKEN}`), null);
    assert.equal(parseDraftUrl('https://x.com/?draft=hi'), null);
    assert.equal(parseDraftUrl(`p2d://?draft=${'a'.repeat(5000)}`)?.length, 4000);
  });

  it('解析 Deep Link 并拼出 WebSocket 地址', () => {
    const p = parseConnectUrl(`p2d://connect?token=${TOKEN}&host=DESKTOP-01&os=windows&port=39271`);
    assert.deepEqual(p, { token: TOKEN, host: 'DESKTOP-01', os: 'windows', port: 39271 });
    assert.equal(buildWsUrl(p!), `ws://127.0.0.1:39271/mcp?token=${TOKEN}`);
  });

  it('中文电脑名、缺省端口', () => {
    const p = parseConnectUrl(`p2d://connect?token=${TOKEN}&host=%E7%8E%8B%E5%B7%A5`);
    assert.equal(p?.host, '王工');
    assert.equal(p?.port, 39271);
  });

  it('无效链接返回 null', () => {
    assert.equal(parseConnectUrl('p2d://connect?host=x'), null);
    assert.equal(parseConnectUrl('https://example.com'), null);
    assert.equal(parseConnectUrl(null), null);
  });
});

describe('McpClient', () => {
  const cleanups: (() => unknown)[] = [];
  after(async () => {
    for (const c of cleanups) await c();
  });

  it('握手、列工具、调用工具、设置权限', async () => {
    const server = await startFakeServer();
    const perms: Permissions = { level: 'full', shell: true, fs: true, screen: false, input: true };
    let connectedCalls = 0;
    const client = new McpClient({
      url: buildWsUrl({ token: TOKEN, port: server.port }),
      createSocket: nodeSocket,
      onConnected: async (c) => {
        connectedCalls++;
        await c.setPermissions(perms);
      },
    });
    cleanups.push(() => client.close(), server.close);

    client.connect();
    await waitStatus(client, 'connected');
    assert.equal(client.serverInfo?.name, 'fake-core');

    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ['sys_info', 'fs_read'],
    );

    const ok = await client.callTool('sys_info');
    assert.equal(ok.isError, undefined);
    assert.deepEqual(ok.content, [{ type: 'text', text: 'hostname: TEST-PC' }]);

    const bad = await client.callTool('fs_read', { path: 'x' });
    assert.equal(bad.isError, true);

    await sleep(50);
    assert.equal(connectedCalls, 1);
    const methods = server.received.map((r) => r.method);
    assert.deepEqual(methods.slice(0, 3), ['initialize', 'notifications/initialized', 'p2d/setPermissions']);
    assert.deepEqual(server.received[2].params, perms);

    await assert.rejects(client.request('no/such'), /Method not found/);
  });

  it('点「停止」：正在执行的工具立即返回 AbortError，并通知电脑端取消', async () => {
    const server = await startFakeServer();
    const client = new McpClient({ url: buildWsUrl({ token: TOKEN, port: server.port }), createSocket: nodeSocket });
    cleanups.push(() => client.close(), server.close);
    client.connect();
    await waitStatus(client, 'connected');

    const ctl = new AbortController();
    const call = client.callTool('slow', {}, { signal: ctl.signal });
    await sleep(50);
    ctl.abort();
    await assert.rejects(call, (e: Error) => e.name === 'AbortError');
    await sleep(50);
    const callReq = server.received.find((r) => r.method === 'tools/call');
    const cancel = server.received.find((r) => r.method === 'notifications/cancelled');
    assert.ok(callReq && cancel, '应发出取消通知');
    assert.equal(typeof (cancel.params as { requestId: unknown }).requestId, 'number');

    // 已经中止的 signal：不发请求，直接返回
    await assert.rejects(client.callTool('sys_info', {}, { signal: ctl.signal }), (e: Error) => e.name === 'AbortError');
    // 取消后连接照常可用
    const ok = await client.callTool('sys_info');
    assert.deepEqual(ok.content, [{ type: 'text', text: 'hostname: TEST-PC' }]);
  });

  it('令牌错误（401）进入 unauthorized，且不再重连', async () => {
    const server = await startFakeServer();
    const client = new McpClient({
      url: buildWsUrl({ token: 'wrongtoken000000', port: server.port }),
      createSocket: nodeSocket,
      reconnectBaseMs: 20,
    });
    cleanups.push(() => client.close(), server.close);

    client.connect();
    await waitStatus(client, 'unauthorized');
    await sleep(200);
    assert.equal(server.handshakes, 1);
    assert.equal(client.status, 'unauthorized');
  });

  it('电脑上点了断开（关闭码 4409）：显示电脑端已断开，不再重连', async () => {
    const server = await startFakeServer();
    const client = new McpClient({
      url: buildWsUrl({ token: TOKEN, port: server.port }),
      createSocket: nodeSocket,
      reconnectBaseMs: 20,
    });
    cleanups.push(() => client.close(), server.close);
    let lastDetail: string | undefined;
    client.onStatus((_s, d) => {
      lastDetail = d;
    });

    client.connect();
    await waitStatus(client, 'connected');
    server.closeAll(CLOSE_BY_PC, '电脑端已断开连接');
    await waitStatus(client, 'idle');
    await sleep(200);
    assert.equal(client.status, 'idle');
    assert.equal(lastDetail, '电脑端已断开连接');
    assert.equal(server.handshakes, 1, '不应自动重连');
  });

  it('连接被断开后自动重连，并重新发送权限', async () => {
    const server = await startFakeServer();
    let connectedCalls = 0;
    const client = new McpClient({
      url: buildWsUrl({ token: TOKEN, port: server.port }),
      createSocket: nodeSocket,
      reconnectBaseMs: 20,
      onConnected: () => {
        connectedCalls++;
      },
    });
    cleanups.push(() => client.close(), server.close);

    client.connect();
    await waitStatus(client, 'connected');

    const statuses: ConnectionStatus[] = [];
    client.onStatus((s) => statuses.push(s));
    server.dropAll();

    await waitStatus(client, 'disconnected');
    await waitStatus(client, 'connected');
    assert.deepEqual(statuses.slice(0, 3), ['disconnected', 'connecting', 'connected']);
    assert.equal(connectedCalls, 2);
    const ok = await client.callTool('sys_info');
    assert.equal(ok.content[0].type, 'text');
  });

  it('心跳连续失败时判定断线并重连', async () => {
    const server = await startFakeServer();
    const client = new McpClient({
      url: buildWsUrl({ token: TOKEN, port: server.port }),
      createSocket: nodeSocket,
      pingIntervalMs: 40,
      maxMissedPings: 3,
      reconnectBaseMs: 20,
    });
    cleanups.push(() => client.close(), server.close);

    client.connect();
    await waitStatus(client, 'connected');
    server.setAnswerPing(false);
    await waitStatus(client, 'disconnected', 2000);
    server.setAnswerPing(true);
    await waitStatus(client, 'connected', 2000);
    assert.ok(server.handshakes >= 2);
  });

  it('close() 之后不再重连，未完成的请求被拒绝', async () => {
    const server = await startFakeServer();
    const client = new McpClient({
      url: buildWsUrl({ token: TOKEN, port: server.port }),
      createSocket: nodeSocket,
      reconnectBaseMs: 20,
    });
    cleanups.push(server.close);

    client.connect();
    await waitStatus(client, 'connected');
    client.close();
    assert.equal(client.status, 'idle');
    await assert.rejects(client.listTools(), /未连接/);
    const before = server.handshakes;
    await sleep(150);
    assert.equal(server.handshakes, before);
  });
});
