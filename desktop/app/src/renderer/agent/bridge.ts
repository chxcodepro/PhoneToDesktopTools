// 页面和主进程之间的桥：网络请求改由主进程发（页面直接请求会被跨域限制挡住），响应流式传回来，
// 包装成共用 Agent 代码需要的 fetch 接口（FetchLike）。
import type { FetchLike } from '@agent/llm';
import type { McpFetch } from '../../../../../mobile/src/protocol/httpMcp';
import type { HttpEvent } from '../../shared/types';

let seq = 0;
export const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

type Listener = (e: HttpEvent) => void;
const listeners = new Map<string, Listener>();
let subscribed = false;

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  window.p2d.agent.onHttp((id, e) => listeners.get(id)?.(e));
}

const abortError = () => Object.assign(new Error('已停止'), { name: 'AbortError' });

/** 经主进程发请求；响应头到达时返回，正文以流的方式读取 */
export const ipcFetch: FetchLike & McpFetch = (url, init) => {
  subscribe();
  const id = uid('h');
  return new Promise((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(abortError());
      return;
    }
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let settled = false;
    const chunks: Uint8Array[] = [];
    let ended = false;
    let failure: Error | null = null;
    const cleanup = () => {
      listeners.delete(id);
      init.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => window.p2d.agent.cancel(id);
    init.signal?.addEventListener('abort', onAbort);

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        for (const ch of chunks) c.enqueue(ch);
        chunks.length = 0;
        if (failure) c.error(failure);
        else if (ended) c.close();
      },
      cancel() {
        window.p2d.agent.cancel(id);
        cleanup();
      },
    });

    listeners.set(id, (e) => {
      switch (e.type) {
        case 'head': {
          settled = true;
          const status = e.status;
          let used = false;
          const headers = e.headers ?? {};
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
            body,
            // text() 读完整个正文（和 body 只能用一个）
            async text() {
              if (used) throw new Error('响应正文已读取');
              used = true;
              const reader = body.getReader();
              const dec = new TextDecoder();
              let out = '';
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                out += dec.decode(value, { stream: true });
              }
              return out + dec.decode();
            },
          });
          break;
        }
        case 'data':
          if (controller) controller.enqueue(e.data);
          else chunks.push(e.data);
          break;
        case 'end':
          cleanup();
          ended = true;
          controller?.close();
          break;
        case 'error': {
          cleanup();
          const err = e.abort || init.signal?.aborted ? abortError() : new TypeError(e.message);
          failure = err;
          if (!settled) {
            settled = true;
            reject(err);
          } else {
            controller?.error(err);
          }
          break;
        }
      }
    });
    window.p2d.agent.httpStart(id, url, { method: init.method, headers: init.headers, body: init.body });
  });
};

/** 读完整个响应正文（二进制，下载 Skill 压缩包等），超过 max 字节时报错 */
export async function fetchBytes(url: string, opts: { signal?: AbortSignal; max?: number; headers?: Record<string, string> } = {}): Promise<Uint8Array> {
  const res = await ipcFetch(url, { method: 'GET', headers: opts.headers ?? {}, signal: opts.signal });
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (opts.max && total > opts.max) {
      void reader.cancel();
      throw new Error('文件太大');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 主进程抛回来的错误带着「Error invoking remote method 'p2d:xxx': Error: 」前缀，去掉只留原因 */
export function cleanError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  const err = new Error(msg.replace(/^Error invoking remote method '[^']+':\s*(\w*Error:\s*)?/, ''));
  if (e instanceof Error && e.name === 'AbortError') err.name = 'AbortError';
  return err;
}

/** 调主进程接口，出错时去掉前缀 */
export async function ipc<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw cleanError(e);
  }
}
