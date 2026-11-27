// 电脑端 AI 助手的主进程部分：页面里运行 Agent（复用手机端的 Agent 循环），这里只提供页面做不了的事：
//   - 网络请求（模型接口、搜索、读网页）：页面直接请求会被跨域限制挡住，改由主进程的 net 模块发（走系统代理），
//     流式地把响应传回页面；
//   - 调用电脑工具：带令牌请求 Core 的 /api/agent/*（令牌在数据目录的 agent-token-<端口> 文件里）；
//   - 下载文件到「下载/P2D」、保存模型配置（API Key 用系统加密存储）和对话记录。
import { app, ipcMain, net, safeStorage, type WebContents } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { CORE_PORT } from './core';

const dataDir = () => path.join(app.getPath('userData'), 'agent');
const convDir = () => path.join(dataDir(), 'conversations');

/** 进行中的请求（网络请求、工具调用、下载），页面点「停止」时按编号取消 */
const running = new Map<string, () => void>();

// ---------- 网络请求 ----------

interface HttpInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function startHttp(sender: WebContents, id: string, url: string, init: HttpInit): void {
  const send = (msg: Record<string, unknown>) => {
    if (!sender.isDestroyed()) sender.send('p2d:http', id, msg);
  };
  if (!/^https?:\/\//i.test(url)) {
    send({ type: 'error', message: '只支持 http / https 地址' });
    return;
  }
  let req: Electron.ClientRequest;
  try {
    req = net.request({ method: init.method || 'GET', url, redirect: 'follow', useSessionCookies: false });
  } catch (e) {
    send({ type: 'error', message: (e as Error).message });
    return;
  }
  let done = false;
  const finish = () => {
    done = true;
    running.delete(id);
  };
  running.set(id, () => {
    if (done) return;
    finish();
    req.abort();
    send({ type: 'error', message: '已停止', abort: true });
  });
  for (const [k, v] of Object.entries(init.headers ?? {})) {
    try {
      req.setHeader(k, v);
    } catch {
      // Host、Content-Length 等由 Chromium 自己设置的请求头不能改，跳过
    }
  }
  req.on('response', (res) => {
    send({ type: 'head', status: res.statusCode });
    res.on('data', (chunk: Buffer) => {
      if (!done) send({ type: 'data', data: new Uint8Array(chunk) });
    });
    res.on('end', () => {
      if (done) return;
      finish();
      send({ type: 'end' });
    });
    res.on('error', (e: Error) => {
      if (done) return;
      finish();
      send({ type: 'error', message: e.message });
    });
  });
  req.on('error', (e) => {
    if (done) return;
    finish();
    send({ type: 'error', message: e.message });
  });
  if (init.body !== undefined) req.write(init.body);
  req.end();
}

// ---------- 电脑工具（Core） ----------

let token: string | null = null;

function readToken(): string {
  try {
    return fs.readFileSync(path.join(app.getPath('userData'), `agent-token-${CORE_PORT}`), 'utf8').trim();
  } catch {
    return '';
  }
}

function coreRequest(method: 'GET' | 'POST', p: string, body: unknown, id?: string, retry = true): Promise<unknown> {
  token ??= readToken();
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: CORE_PORT,
        path: p,
        method,
        headers: { 'X-P2D-Agent': token ?? '', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          if (id) running.delete(id);
          // 电脑端服务重启过：令牌变了，重新读一次
          if (res.statusCode === 401 && retry) {
            token = readToken();
            coreRequest(method, p, body, id, false).then(resolve, reject);
            return;
          }
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(res.statusCode === 401 ? '电脑端服务的令牌不对，请退出 P2D 后重新打开' : text.trim() || `HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('电脑端服务返回的不是 JSON'));
          }
        });
      },
    );
    let cancelled = false;
    req.on('error', (e) => {
      if (id) running.delete(id);
      reject(cancelled ? e : new Error(`连不上电脑端服务：${e.message}`));
    });
    if (id) {
      running.set(id, () => {
        running.delete(id);
        cancelled = true;
        req.destroy(new Error('已停止'));
      });
    }
    if (data) req.write(data);
    req.end();
  });
}

// ---------- 下载 ----------

interface DownloadResult {
  path: string;
  size: number;
  sha256: string;
  sha1: string;
  signature?: string;
}

const MAX_DOWNLOAD = 1024 * 1024 * 1024;

/** 不覆盖已有文件：重名时加 (1)、(2)… */
function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

function download(sender: WebContents, id: string, url: string, name: string, dir: string): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    if (!/^https?:\/\//i.test(url)) {
      reject(new Error('只支持 http / https 地址'));
      return;
    }
    const safe = path.basename(name).replace(/[\\/:*?"<>|]/g, '_') || 'download.bin';
    fs.mkdirSync(dir, { recursive: true });
    const target = uniquePath(dir, safe);
    const tmp = `${target}.part`;
    const out = fs.createWriteStream(tmp);
    const sha256 = crypto.createHash('sha256');
    const sha1 = crypto.createHash('sha1');
    let size = 0;
    let total = 0;
    let lastReport = 0;
    let failed = false;
    const req = net.request({ url, redirect: 'follow', useSessionCookies: false });
    const fail = (e: Error) => {
      if (failed) return;
      failed = true;
      running.delete(id);
      req.abort();
      out.destroy();
      fs.rm(tmp, { force: true }, () => reject(e));
    };
    running.set(id, () => fail(new Error('已停止')));
    req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36');
    req.on('response', (res) => {
      if (res.statusCode >= 400) {
        fail(new Error(`下载失败：HTTP ${res.statusCode}`));
        return;
      }
      const len = res.headers['content-length'];
      total = Number(Array.isArray(len) ? len[0] : len) || 0;
      if (total > MAX_DOWNLOAD) {
        fail(new Error('文件超过 1 GB'));
        return;
      }
      res.on('data', (chunk: Buffer) => {
        if (failed) return;
        size += chunk.length;
        if (size > MAX_DOWNLOAD) {
          fail(new Error('文件超过 1 GB'));
          return;
        }
        sha256.update(chunk);
        sha1.update(chunk);
        // 写盘跟不上网速时先暂停接收，免得数据堆在内存里
        if (!out.write(chunk)) {
          const stream = res as unknown as NodeJS.ReadableStream; // 实际是 Readable，类型声明里没写
          stream.pause();
          out.once('drain', () => stream.resume());
        }
        const now = Date.now();
        if (now - lastReport > 500 && !sender.isDestroyed()) {
          lastReport = now;
          sender.send('p2d:downloadProgress', id, size, total);
        }
      });
      res.on('end', () => {
        if (failed) return;
        out.end(() => {
          if (failed) return;
          try {
            fs.renameSync(tmp, target);
          } catch (e) {
            fail(e as Error);
            return;
          }
          running.delete(id);
          resolve({ path: target, size, sha256: sha256.digest('hex'), sha1: sha1.digest('hex') });
        });
      });
      res.on('error', (e: Error) => fail(e));
    });
    req.on('error', (e) => fail(e));
    out.on('error', (e) => fail(new Error(`保存失败：${e.message}`)));
    req.end();
  });
}

// ---------- 配置和对话记录 ----------

function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** 先写临时文件再改名，写到一半断电也不会把原文件弄坏 */
function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, p);
}

const keysPath = () => path.join(dataDir(), 'keys.json');

function getKey(preset: string): string {
  const v = readJson<Record<string, string>>(keysPath(), {})[preset];
  if (!v) return '';
  if (v.startsWith('plain:')) return v.slice(6);
  try {
    return safeStorage.decryptString(Buffer.from(v, 'base64'));
  } catch {
    return '';
  }
}

function setKey(preset: string, key: string): void {
  const all = readJson<Record<string, string>>(keysPath(), {});
  if (!key) delete all[preset];
  // 系统没有可用的加密存储（Linux 没装密钥环）时只能明文保存，文件在用户自己的数据目录里
  else all[preset] = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key).toString('base64') : `plain:${key}`;
  writeJson(keysPath(), all);
}

/** 对话编号只能是字母数字（防止拼出别的路径） */
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);

export function registerAgentIpc(): void {
  ipcMain.on('p2d:httpStart', (e, id: unknown, url: unknown, init: unknown) => {
    if (typeof id === 'string' && typeof url === 'string') startHttp(e.sender, id, url, (init ?? {}) as HttpInit);
  });
  ipcMain.on('p2d:cancel', (_e, id: unknown) => {
    if (typeof id === 'string') running.get(id)?.();
  });
  ipcMain.handle('p2d:agentTools', () => coreRequest('GET', '/api/agent/tools', undefined));
  ipcMain.handle('p2d:agentCall', (_e, id: unknown, name: unknown, args: unknown) =>
    coreRequest('POST', '/api/agent/call', { name, arguments: args ?? {} }, typeof id === 'string' ? id : undefined),
  );
  ipcMain.handle('p2d:download', async (e, id: unknown, url: unknown, name: unknown, dir: unknown) => {
    if (typeof id !== 'string' || typeof url !== 'string' || typeof name !== 'string' || typeof dir !== 'string') {
      throw new Error('参数不对');
    }
    const r = await download(e.sender, id, url, name, dir);
    if (process.platform === 'win32' && /\.(exe|msi|cab|dll|sys|cat|msu)$/i.test(r.path)) {
      try {
        const v = (await coreRequest('POST', '/api/agent/verify', { path: r.path })) as { signature?: string };
        if (v.signature) r.signature = v.signature;
      } catch {
        // 查不到签名不影响下载结果
      }
    }
    return r;
  });
  ipcMain.handle('p2d:agentConfig', () => readJson<unknown>(path.join(dataDir(), 'config.json'), null));
  ipcMain.handle('p2d:agentSaveConfig', (_e, v: unknown) => writeJson(path.join(dataDir(), 'config.json'), v));
  ipcMain.handle('p2d:agentKey', (_e, preset: unknown) => (typeof preset === 'string' ? getKey(preset) : ''));
  ipcMain.handle('p2d:agentSetKey', (_e, preset: unknown, key: unknown) => {
    if (typeof preset === 'string' && typeof key === 'string') setKey(preset, key.trim());
  });
  ipcMain.handle('p2d:convList', () => readJson<unknown[]>(path.join(convDir(), 'index.json'), []));
  ipcMain.handle('p2d:convLoad', (_e, id: unknown) => (validId(id) ? readJson<unknown>(path.join(convDir(), `${id}.json`), null) : null));
  ipcMain.handle('p2d:convSave', (_e, id: unknown, data: unknown, list: unknown) => {
    if (!validId(id)) return;
    writeJson(path.join(convDir(), `${id}.json`), data);
    writeJson(path.join(convDir(), 'index.json'), list);
  });
  ipcMain.handle('p2d:convRemove', (_e, id: unknown, list: unknown) => {
    if (!validId(id)) return;
    fs.rmSync(path.join(convDir(), `${id}.json`), { force: true });
    writeJson(path.join(convDir(), 'index.json'), list);
  });
}
