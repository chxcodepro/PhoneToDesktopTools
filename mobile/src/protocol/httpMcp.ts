// 远程 MCP 客户端：手机直接连接第三方 MCP 服务（走手机自己的网络，不经过电脑）。
// 支持两种传输：
// - Streamable HTTP（MCP 2025-03-26 起的标准）：每个请求 POST 一次，响应是 JSON 或一段 SSE；
// - 旧版 SSE：先 GET 建立事件流，拿到 endpoint 后把请求 POST 过去，响应从事件流返回。
// 不依赖 React Native，可在 Node 中测试；fetch 由调用方注入（RN 里用 expo/fetch，支持流式读取）。

import { MCP_PROTOCOL_VERSION, type ToolContent, type ToolInfo, type ToolResult } from './types';

export interface McpFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  body: ReadableStream<Uint8Array> | null;
}

export type McpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<McpFetchResponse>;

export type McpTransport = 'http' | 'sse';

export interface RemoteMcpOptions {
  url: string;
  headers?: Record<string, string>;
  /** 不指定时：地址以 /sse 结尾按旧版 SSE，否则按 Streamable HTTP */
  transport?: McpTransport;
  fetch: McpFetch;
  /** 普通请求超时，默认 30 秒 */
  timeoutMs?: number;
  /** 工具调用超时，默认 180 秒 */
  callTimeoutMs?: number;
}

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** 解析一段完整的 SSE 文本 */
export function parseSse(text: string): SseEvent[] {
  const parser = new SseParser();
  const out = parser.push(text);
  out.push(...parser.push('\n\n'));
  return out;
}

/** 增量 SSE 解析器：喂入任意切分的文本，返回已完整的事件 */
export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    let i: number;
    while ((i = this.buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buf.slice(0, i);
      const nl = this.buf.startsWith('\r\n', i) ? 2 : 1;
      this.buf = this.buf.slice(i + nl);
      if (line === '') {
        if (this.data.length) out.push({ event: this.event || 'message', data: this.data.join('\n'), id: this.id });
        this.event = '';
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const c = line.indexOf(':');
      const field = c < 0 ? line : line.slice(0, c);
      let value = c < 0 ? '' : line.slice(c + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.event = value;
      else if (field === 'data') this.data.push(value);
      else if (field === 'id') this.id = value;
    }
    return out;
  }
}

/** 解析相对地址（RN 的 URL 不一定支持相对解析） */
export function resolveUrl(base: string, ref: string): string {
  if (/^https?:\/\//i.test(ref)) return ref;
  const m = /^(https?:\/\/[^/]+)(\/[^?#]*)?/i.exec(base);
  if (!m) return ref;
  if (ref.startsWith('/')) return m[1] + ref;
  const dir = (m[2] ?? '/').replace(/[^/]*$/, '');
  return m[1] + dir + ref;
}

/** 远程工具结果统一成 ToolResult（音频、资源等转成文字） */
export function normalizeResult(raw: unknown): ToolResult {
  const r = (raw ?? {}) as { content?: unknown[]; isError?: boolean; structuredContent?: unknown };
  const content: ToolContent[] = [];
  for (const c of Array.isArray(r.content) ? r.content : []) {
    const item = c as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') content.push({ type: 'text', text: item.text });
    else if (item.type === 'image' && typeof item.data === 'string')
      content.push({ type: 'image', data: item.data, mimeType: String(item.mimeType ?? 'image/png') });
    else if (item.type === 'resource' && item.resource && typeof item.resource === 'object') {
      const res = item.resource as { uri?: string; text?: string; mimeType?: string };
      content.push({ type: 'text', text: res.text ?? `[资源] ${res.uri ?? ''}（${res.mimeType ?? '二进制'}）` });
    } else if (item.type === 'resource_link')
      content.push({ type: 'text', text: `[资源链接] ${String(item.uri ?? '')} ${String(item.name ?? '')}` });
    else content.push({ type: 'text', text: `[${String(item.type)} 内容，手机端无法显示]` });
  }
  if (!content.length && r.structuredContent !== undefined) content.push({ type: 'text', text: JSON.stringify(r.structuredContent) });
  if (!content.length) content.push({ type: 'text', text: '（工具没有返回内容）' });
  return { content, isError: r.isError === true };
}

export class McpHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function describeHttp(status: number, body: string): string {
  if (status === 401 || status === 403) return `鉴权失败（HTTP ${status}），请检查令牌 / 请求头是否正确`;
  if (status === 404) return '地址不存在（HTTP 404），请检查 MCP 地址';
  const s = body.replace(/\s+/g, ' ').trim().slice(0, 200);
  return `HTTP ${status}${s ? `：${s}` : ''}`;
}

function rpcError(e: unknown): Error {
  const err = e as { code?: number; message?: string };
  return new Error(`MCP 错误${err?.code !== undefined ? ` ${err.code}` : ''}：${err?.message ?? '未知错误'}`);
}

/** 把超时和外部的取消合并到一个 AbortSignal */
function withTimeout(ms: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('请求超时')), ms);
  const onAbort = () => ctl.abort(outer?.reason);
  if (outer?.aborted) ctl.abort(outer.reason);
  else outer?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

export class RemoteMcp {
  /** 实际使用的传输方式（未指定时连接失败会自动换另一种） */
  transport: McpTransport;
  serverName = '';
  instructions = '';
  private sessionId: string | null = null;
  private protocol = MCP_PROTOCOL_VERSION;
  private nextId = 1;
  private initialized = false;
  // 旧版 SSE
  private endpoint: string | null = null;
  private stream: AbortController | null = null;
  private pending = new Map<number, Pending>();

  constructor(private readonly opts: RemoteMcpOptions) {
    this.transport = opts.transport ?? (/\/sse\/?(\?|$)/i.test(opts.url) ? 'sse' : 'http');
  }

  private baseHeaders(): Record<string, string> {
    const h: Record<string, string> = { ...this.opts.headers };
    if (this.initialized) h['MCP-Protocol-Version'] = this.protocol;
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  /** 握手并返回工具列表 */
  async connect(signal?: AbortSignal): Promise<ToolInfo[]> {
    try {
      return await this.connectOnce(signal);
    } catch (e) {
      // 没指定传输方式时按 MCP 规范的兼容建议换另一种再试（如旧版 SSE 地址已停用、或服务只支持旧版 SSE）
      if (this.opts.transport || !(e instanceof McpHttpError) || ![400, 404, 405, 410].includes(e.status)) throw e;
      this.transport = this.transport === 'sse' ? 'http' : 'sse';
      try {
        return await this.connectOnce(signal);
      } catch {
        this.transport = this.transport === 'sse' ? 'http' : 'sse';
        throw e;
      }
    }
  }

  private async connectOnce(signal?: AbortSignal): Promise<ToolInfo[]> {
    this.close();
    if (this.transport === 'sse') await this.openStream(signal);
    const init = (await this.request(
      'initialize',
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'p2d-mobile', version: '0.1.0' } },
      signal,
    )) as { protocolVersion?: string; serverInfo?: { name?: string }; instructions?: string };
    if (init?.protocolVersion) this.protocol = init.protocolVersion;
    this.serverName = init?.serverInfo?.name ?? '';
    this.instructions = typeof init?.instructions === 'string' ? init.instructions : '';
    this.initialized = true;
    await this.notify('notifications/initialized', signal);
    return this.listTools(signal);
  }

  async listTools(signal?: AbortSignal): Promise<ToolInfo[]> {
    const tools: ToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = (await this.request('tools/list', cursor ? { cursor } : {}, signal)) as { tools?: ToolInfo[]; nextCursor?: string };
      tools.push(...(r?.tools ?? []).filter((t) => t && typeof t.name === 'string'));
      if (!r?.nextCursor) break;
      cursor = r.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const call = () => this.request('tools/call', { name, arguments: args }, signal, this.opts.callTimeoutMs ?? 180_000);
    try {
      return normalizeResult(await call());
    } catch (e) {
      // 会话过期（服务端重启等）：重新握手后重试一次
      if ((e instanceof McpHttpError && e.status === 404 && this.sessionId) || (this.transport === 'sse' && !this.stream)) {
        await this.connect(signal);
        return normalizeResult(await call());
      }
      throw e;
    }
  }

  close(): void {
    this.stream?.abort();
    this.stream = null;
    this.endpoint = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('连接已关闭'));
    }
    this.pending.clear();
    if (this.sessionId && this.transport === 'http') {
      // 通知服务端结束会话（失败无所谓）
      void this.opts.fetch(this.opts.url, { method: 'DELETE', headers: this.baseHeaders() }).catch(() => undefined);
    }
    this.sessionId = null;
    this.initialized = false;
  }

  private async notify(method: string, signal?: AbortSignal): Promise<void> {
    const body = JSON.stringify({ jsonrpc: '2.0', method });
    const url = this.transport === 'sse' ? this.endpoint! : this.opts.url;
    const t = withTimeout(this.opts.timeoutMs ?? 30_000, signal);
    try {
      const res = await this.opts.fetch(url, {
        method: 'POST',
        headers: { ...this.baseHeaders(), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body,
        signal: t.signal,
      });
      if (!res.ok && res.status !== 202) throw new McpHttpError(res.status, describeHttp(res.status, await res.text().catch(() => '')));
    } finally {
      t.done();
    }
  }

  private async request(method: string, params: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const ms = timeoutMs ?? this.opts.timeoutMs ?? 30_000;
    return this.transport === 'sse' ? this.requestSse(id, body, ms, signal) : this.requestHttp(id, body, ms, signal);
  }

  private async requestHttp(id: number, body: string, ms: number, signal?: AbortSignal): Promise<unknown> {
    const t = withTimeout(ms, signal);
    try {
      const res = await this.opts.fetch(this.opts.url, {
        method: 'POST',
        headers: { ...this.baseHeaders(), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body,
        signal: t.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const text = await res.text();
      if (!res.ok) throw new McpHttpError(res.status, describeHttp(res.status, text));
      const type = res.headers.get('content-type') ?? '';
      const messages: unknown[] = [];
      if (type.includes('text/event-stream') || /^\s*(event|data):/.test(text)) {
        for (const ev of parseSse(text)) {
          try {
            messages.push(JSON.parse(ev.data));
          } catch {
            // 忽略非 JSON 事件
          }
        }
      } else if (text.trim()) {
        const j = JSON.parse(text);
        messages.push(...(Array.isArray(j) ? j : [j]));
      }
      const msg = messages.find((m) => (m as { id?: unknown })?.id === id) as { result?: unknown; error?: unknown } | undefined;
      if (!msg) throw new Error('MCP 服务没有返回结果');
      if (msg.error) throw rpcError(msg.error);
      return msg.result;
    } catch (e) {
      if (t.signal.aborted && !signal?.aborted) throw new Error('请求超时：MCP 服务没有响应');
      throw e;
    } finally {
      t.done();
    }
  }

  // ---- 旧版 SSE ----

  private async openStream(signal?: AbortSignal): Promise<void> {
    const ctl = new AbortController();
    this.stream = ctl;
    const res = await this.opts.fetch(this.opts.url, {
      method: 'GET',
      headers: { ...this.opts.headers, Accept: 'text/event-stream' },
      signal: ctl.signal,
    });
    if (!res.ok) {
      this.stream = null;
      throw new McpHttpError(res.status, describeHttp(res.status, await res.text().catch(() => '')));
    }
    if (!res.body) {
      this.stream = null;
      throw new Error('当前环境不支持读取 SSE 事件流');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let gotEndpoint: (url: string) => void = () => undefined;
    const endpoint = new Promise<string>((resolve) => (gotEndpoint = resolve));

    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
            if (ev.event === 'endpoint') gotEndpoint(resolveUrl(this.opts.url, ev.data.trim()));
            else if (ev.event === 'message') this.onStreamMessage(ev.data);
          }
        }
      } catch {
        // 连接被关闭或网络中断
      } finally {
        if (this.stream === ctl) {
          this.stream = null;
          for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error('MCP 事件流已断开'));
          }
          this.pending.clear();
        }
      }
    })();

    const t = withTimeout(this.opts.timeoutMs ?? 30_000, signal);
    try {
      this.endpoint = await Promise.race([
        endpoint,
        new Promise<string>((_, reject) =>
          t.signal.addEventListener('abort', () => reject(new Error('等待 SSE endpoint 超时')), { once: true }),
        ),
      ]);
    } finally {
      t.done();
    }
  }

  private onStreamMessage(data: string): void {
    let msg: { id?: unknown; result?: unknown; error?: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(rpcError(msg.error));
    else p.resolve(msg.result);
  }

  private async requestSse(id: number, body: string, ms: number, signal?: AbortSignal): Promise<unknown> {
    if (!this.endpoint || !this.stream) throw new Error('MCP 事件流未连接');
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('请求超时：MCP 服务没有响应'));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener(
        'abort',
        () => {
          const p = this.pending.get(id);
          if (!p) return;
          this.pending.delete(id);
          clearTimeout(p.timer);
          reject(Object.assign(new Error('已停止'), { name: 'AbortError' }));
        },
        { once: true },
      );
    });
    const res = await this.opts.fetch(this.endpoint, {
      method: 'POST',
      headers: { ...this.opts.headers, 'Content-Type': 'application/json' },
      body,
      signal,
    });
    if (!res.ok && res.status !== 202) {
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
      }
      throw new McpHttpError(res.status, describeHttp(res.status, await res.text().catch(() => '')));
    }
    // 有的服务直接在 POST 响应里返回结果
    const text = await res.text().catch(() => '');
    if (text.trim().startsWith('{')) this.onStreamMessage(text);
    return result;
  }
}
