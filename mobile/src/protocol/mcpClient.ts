// 手机端 MCP 客户端（JSON-RPC 2.0 over WebSocket），对应 docs/PROTOCOL.md。
//
// - 不依赖 React Native：WebSocket 构造函数可注入，方便在 Node 中用 ws 测试。
// - 功能：握手（initialize / notifications/initialized）、tools/list、tools/call、
//   p2d/setPermissions、10 秒心跳（连续 3 次失败判定断线）、断线指数退避自动重连、
//   请求超时、令牌无效（HTTP 401）识别。

import {
  MCP_PROTOCOL_VERSION,
  type ConnectionStatus,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type Permissions,
  type ServerInfo,
  type ToolInfo,
  type ToolResult,
} from './types';

/** 与浏览器 / React Native / ws 兼容的最小 WebSocket 接口 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: { message?: string; error?: unknown }) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface McpClientOptions {
  /** 完整地址，例如 ws://127.0.0.1:39271/mcp?token=xxx */
  url: string;
  /** WebSocket 工厂，默认使用全局 WebSocket（React Native 自带） */
  createSocket?: WebSocketFactory;
  /** 普通请求超时，默认 30 秒 */
  requestTimeoutMs?: number;
  /** 心跳间隔，默认 10 秒 */
  pingIntervalMs?: number;
  /** 连续多少次心跳失败判定断线，默认 3 */
  maxMissedPings?: number;
  /** 重连初始间隔，默认 1 秒 */
  reconnectBaseMs?: number;
  /** 重连最大间隔，默认 30 秒 */
  reconnectMaxMs?: number;
  /** 客户端信息 */
  clientInfo?: { name: string; version: string };
  /** 每次（重新）连接并握手完成后调用，例如发送权限设置 */
  onConnected?: (client: McpClient) => void | Promise<void>;
  /** 日志输出（调试用） */
  onLog?: (msg: string) => void;
}

export class McpError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

type StatusListener = (status: ConnectionStatus, detail?: string) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const WS_OPEN = 1;

export class McpClient {
  private readonly opts: Required<Omit<McpClientOptions, 'onConnected' | 'onLog' | 'createSocket'>> &
    Pick<McpClientOptions, 'onConnected' | 'onLog'> & { createSocket: WebSocketFactory };

  private ws: WebSocketLike | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<StatusListener>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private missedPings = 0;
  private reconnectAttempt = 0;
  private stopped = true;
  private socketGeneration = 0;

  private _status: ConnectionStatus = 'idle';
  private _serverInfo: ServerInfo | null = null;
  private _instructions: string | null = null;

  constructor(options: McpClientOptions) {
    const createSocket =
      options.createSocket ??
      ((url: string) => {
        const Ctor = (globalThis as { WebSocket?: new (u: string) => WebSocketLike }).WebSocket;
        if (!Ctor) throw new Error('当前环境没有 WebSocket');
        return new Ctor(url);
      });
    this.opts = {
      url: options.url,
      createSocket,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      pingIntervalMs: options.pingIntervalMs ?? 10_000,
      maxMissedPings: options.maxMissedPings ?? 3,
      reconnectBaseMs: options.reconnectBaseMs ?? 1_000,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
      clientInfo: options.clientInfo ?? { name: 'p2d-mobile', version: '0.1.0' },
      onConnected: options.onConnected,
      onLog: options.onLog,
    };
  }

  // ---------- 公共接口 ----------

  get status(): ConnectionStatus {
    return this._status;
  }

  get serverInfo(): ServerInfo | null {
    return this._serverInfo;
  }

  get instructions(): string | null {
    return this._instructions;
  }

  /** 订阅状态变化，返回取消订阅函数 */
  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 开始连接（断线后自动重连，直到调用 close()） */
  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.openSocket();
  }

  /** 主动断开，不再重连 */
  close(): void {
    this.stopped = true;
    this.clearReconnect();
    this.teardownSocket('用户断开');
    this.setStatus('idle');
  }

  /** 获取工具清单 */
  async listTools(): Promise<ToolInfo[]> {
    const res = (await this.request('tools/list', {})) as { tools?: ToolInfo[] };
    return res.tools ?? [];
  }

  /** 调用工具 */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<ToolResult> {
    const res = (await this.request(
      'tools/call',
      { name, arguments: args },
      options.timeoutMs ?? Math.max(this.opts.requestTimeoutMs, 660_000),
    )) as ToolResult;
    return { content: res.content ?? [], isError: res.isError };
  }

  /** 设置电脑端权限（自定义扩展 p2d/setPermissions） */
  async setPermissions(p: Permissions): Promise<void> {
    await this.request('p2d/setPermissions', p);
  }

  /** 发送 JSON-RPC 请求 */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) {
      return Promise.reject(new McpError(-32000, '未连接到电脑'));
    }
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(-32001, `请求超时：${method}`));
      }, timeoutMs ?? this.opts.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** 发送通知（无响应） */
  notify(method: string, params?: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;
    const msg: { jsonrpc: '2.0'; method: string; params?: unknown } = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    ws.send(JSON.stringify(msg));
  }

  // ---------- 内部实现 ----------

  private log(msg: string): void {
    this.opts.onLog?.(msg);
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    if (this._status === status && detail === undefined) return;
    this._status = status;
    for (const l of this.listeners) {
      try {
        l(status, detail);
      } catch {
        // 监听器异常不影响连接
      }
    }
  }

  private openSocket(): void {
    if (this.stopped) return;
    const gen = ++this.socketGeneration;
    this.setStatus('connecting');
    let ws: WebSocketLike;
    try {
      ws = this.opts.createSocket(this.opts.url);
    } catch (e) {
      this.log(`创建连接失败：${String(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let opened = false;
    let unauthorized = false;

    ws.onopen = () => {
      if (gen !== this.socketGeneration) return;
      opened = true;
      void this.handshake(gen);
    };

    ws.onmessage = (ev) => {
      if (gen !== this.socketGeneration) return;
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
      this.handleMessage(text);
    };

    ws.onerror = (ev) => {
      if (gen !== this.socketGeneration) return;
      const message = errorMessage(ev);
      this.log(`连接错误：${message}`);
      // 握手阶段被 401 拒绝：React Native 报 "Expected HTTP 101 response but was '401 ...'"，
      // ws 报 "Unexpected server response: 401"
      if (!opened && /\b401\b/.test(message)) unauthorized = true;
    };

    ws.onclose = (ev) => {
      if (gen !== this.socketGeneration) return;
      this.log(`连接关闭：code=${ev?.code ?? ''} ${ev?.reason ?? ''}`);
      this.teardownSocket('连接已断开');
      if (this.stopped) return;
      if (unauthorized || ev?.code === 4401) {
        this.stopped = true;
        this.setStatus('unauthorized', '令牌无效，请重新插拔数据线');
        return;
      }
      this.setStatus('disconnected');
      this.scheduleReconnect();
    };
  }

  private async handshake(gen: number): Promise<void> {
    try {
      const res = (await this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.opts.clientInfo,
      })) as { serverInfo?: ServerInfo; instructions?: string };
      if (gen !== this.socketGeneration) return;
      this._serverInfo = res.serverInfo ?? null;
      this._instructions = res.instructions ?? null;
      this.notify('notifications/initialized');
      this.reconnectAttempt = 0;
      this.missedPings = 0;
      this.startPing(gen);
      this.setStatus('connected');
      if (this.opts.onConnected) {
        try {
          await this.opts.onConnected(this);
        } catch (e) {
          this.log(`连接后回调失败：${String(e)}`);
        }
      }
    } catch (e) {
      if (gen !== this.socketGeneration) return;
      this.log(`握手失败：${String(e)}`);
      // 关闭当前连接，交给 onclose 走重连
      try {
        this.ws?.close(4000, 'handshake failed');
      } catch {
        // 忽略
      }
    }
  }

  private handleMessage(text: string): void {
    let msg: Partial<JsonRpcResponse & JsonRpcRequest>;
    try {
      msg = JSON.parse(text);
    } catch {
      this.log('收到无法解析的消息');
      return;
    }
    // 服务端发来的请求（如 ping）
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) {
        if (msg.method === 'ping') {
          this.sendRaw({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else {
          this.sendRaw({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `手机端不支持方法：${msg.method}` },
          });
        }
      }
      return;
    }
    // 响应
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      p.reject(new McpError(msg.error.code, msg.error.message, msg.error.data));
    } else {
      p.resolve(msg.result);
    }
  }

  private sendRaw(obj: unknown): void {
    const ws = this.ws;
    if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj));
  }

  private startPing(gen: number): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (gen !== this.socketGeneration) return;
      this.request('ping', undefined, this.opts.pingIntervalMs)
        .then(() => {
          this.missedPings = 0;
        })
        .catch(() => {
          if (gen !== this.socketGeneration) return;
          this.missedPings++;
          this.log(`心跳失败 ${this.missedPings}/${this.opts.maxMissedPings}`);
          if (this.missedPings >= this.opts.maxMissedPings) {
            this.log('心跳连续失败，判定断线');
            this.forceReconnect();
          }
        });
    }, this.opts.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** 心跳失败时：丢弃当前连接（不等对方回应关闭帧），立即进入重连流程 */
  private forceReconnect(): void {
    const ws = this.ws;
    this.socketGeneration++; // 让旧连接的回调全部失效
    this.teardownSocket('心跳超时');
    try {
      ws?.close(4000, 'ping timeout');
    } catch {
      // 忽略
    }
    if (this.stopped) return;
    this.setStatus('disconnected');
    this.scheduleReconnect();
  }

  private teardownSocket(reason: string): void {
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WS_OPEN || ws.readyState === 0) {
        try {
          ws.close(1000, reason);
        } catch {
          // 忽略
        }
      }
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new McpError(-32000, reason));
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearReconnect();
    const delay = Math.min(
      this.opts.reconnectBaseMs * 2 ** this.reconnectAttempt,
      this.opts.reconnectMaxMs,
    );
    this.reconnectAttempt++;
    this.log(`${delay} ms 后重连（第 ${this.reconnectAttempt} 次）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

function errorMessage(ev: { message?: string; error?: unknown } | null | undefined): string {
  if (!ev) return '';
  if (typeof ev.message === 'string' && ev.message) return ev.message;
  const err = ev.error;
  if (err instanceof Error) return err.message;
  return err ? String(err) : '';
}
