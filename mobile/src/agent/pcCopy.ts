// 在两台电脑之间传文件（手机中转）：从 A 电脑按块读（p2d/file.read），原样上传到 B 电脑（p2d/upload.*）。
// 数据块是 base64，手机不解码、不落盘，边读边传。不依赖 React Native，可在 Node 中测试（tests/pcCopy.test.ts）。

/** 最小的请求接口（McpClient 满足） */
export interface Rpc {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface CopyResult {
  /** 源文件的绝对路径 */
  from: string;
  /** 目标电脑上的保存路径 */
  path: string;
  size: number;
  sha256?: string;
}

const CHUNK = 512 * 1024;
const MAX_SIZE = 1024 * 1024 * 1024;

/** base64 对应的字节数 */
export function b64Size(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** 路径里的文件名（Windows、Linux 路径都行） */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '文件';
}

interface ReadRes {
  path?: string;
  data: string;
  size: number;
  eof: boolean;
}

function tooOld(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  // 旧版电脑端不认识这个方法（JSON-RPC -32601）
  if (/-32601|不支持|unknown method|method not found/i.test(msg) || (e as { code?: number })?.code === -32601) {
    return new Error('源电脑的电脑端版本太旧，不支持传文件，请先把它的电脑端更新到最新版');
  }
  return e instanceof Error ? e : new Error(msg);
}

export async function copyBetweenPcs(
  from: Rpc,
  to: Rpc,
  path: string,
  opts: { signal?: AbortSignal; onProgress?: (sent: number, total: number) => void } = {},
): Promise<CopyResult> {
  const read = async (offset: number): Promise<ReadRes> => {
    if (opts.signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
    try {
      return (await from.request('p2d/file.read', { path, offset, size: CHUNK }, 60_000)) as ReadRes;
    } catch (e) {
      throw tooOld(e);
    }
  };
  let r = await read(0);
  const total = r.size;
  if (total > MAX_SIZE) throw new Error('文件超过 1 GB，太大了，请分卷压缩后再传');
  const begin = (await to.request('p2d/upload.begin', { name: baseName(r.path || path), size: total })) as { id: string };
  try {
    let sent = 0;
    for (;;) {
      if (r.data) {
        if (opts.signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
        await to.request('p2d/upload.chunk', { id: begin.id, data: r.data });
        sent += b64Size(r.data);
        opts.onProgress?.(sent, total);
      }
      if (r.eof || sent >= total) break;
      if (!r.data) throw new Error('读取源文件时没有读到数据');
      r = await read(sent);
    }
    const end = (await to.request('p2d/upload.end', { id: begin.id }, 90_000)) as { path: string; size: number; sha256?: string };
    return { from: r.path || path, path: end.path, size: end.size, sha256: end.sha256 };
  } catch (e) {
    to.request('p2d/upload.cancel', { id: begin.id }).catch(() => undefined);
    throw e;
  }
}
