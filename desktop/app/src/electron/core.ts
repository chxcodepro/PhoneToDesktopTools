// 启动和管理 Core 子进程（p2d-core）。
import { app } from 'electron';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { CoreStatus } from '../shared/types';

// 与手机端约定的端口；P2D_PORT 仅供开发调试时使用其他端口
export const CORE_PORT = Number(process.env.P2D_PORT) || 39271;

const goOS: Record<string, string> = { win32: 'windows', linux: 'linux' };
const goArch: Record<string, string> = { x64: 'amd64', ia32: '386', arm64: 'arm64', loong64: 'loong64' };

/** Core 可执行文件路径：打包后在 resources/core 下，开发时用仓库根目录 dist/core/<系统>-<架构>/ */
export function corePath(): string {
  if (process.env.P2D_CORE_PATH) return process.env.P2D_CORE_PATH;
  const exe = process.platform === 'win32' ? 'p2d-core.exe' : 'p2d-core';
  if (app.isPackaged) return path.join(process.resourcesPath, 'core', exe);
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const dir = `${goOS[process.platform] ?? process.platform}-${goArch[process.arch] ?? process.arch}`;
  return path.join(repoRoot, 'dist', 'core', dir, exe);
}

export class CoreProcess {
  private child: ChildProcess | null = null;
  private quitting = false;
  private restarts = 0;
  lastError = '';

  /** 没有由本程序启动的 Core 子进程（或已结束） */
  get stopped(): boolean {
    return this.child === null;
  }

  start(): void {
    this.lastAttempt = Date.now();
    const exe = corePath();
    if (!fs.existsSync(exe)) {
      this.lastError = `找不到电脑端服务程序：${exe}`;
      console.error(this.lastError);
      return;
    }
    // 额外参数（开发调试用），例如 P2D_CORE_ARGS="-dev-token e2etoken"
    const extra = (process.env.P2D_CORE_ARGS ?? '').split(/\s+/).filter(Boolean);
    if (process.env.P2D_PORT) extra.push('-port', String(CORE_PORT));
    const startedAt = Date.now();
    const child = spawn(exe, extra, {
      cwd: path.dirname(exe),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let tail = '';
    const onData = (b: Buffer) => {
      const s = b.toString('utf8');
      tail = (tail + s).slice(-2000);
      process.stdout.write(`[core] ${s}`);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e) => {
      this.lastError = `电脑端服务启动失败：${e.message}`;
    });
    child.on('exit', (code) => {
      this.child = null;
      if (this.quitting) return;
      // 端口已被占用：说明已有一个 Core 在运行，直接复用它
      if (/无法监听端口|address already in use|Only one usage/i.test(tail)) {
        console.log('[core] 端口已被占用：若已有电脑端服务在运行则直接复用，否则稍后重试');
        return;
      }
      this.lastError = `电脑端服务已退出（代码 ${code}）`;
      if (this.restarts < 5 && Date.now() - startedAt > 1000) {
        this.restarts++;
        setTimeout(() => this.start(), 2000);
      }
    });
  }

  private lastAttempt = 0;

  /** 服务连不上且本程序没有在运行 Core 时，每 5 秒重试启动一次（例如之前端口被占用、后来释放了） */
  ensureRunning(): void {
    if (this.quitting || this.child || Date.now() - this.lastAttempt < 5000) return;
    this.start();
  }

  /** 退出前先请求断开（清理手机端连接），再结束进程 */
  async stop(): Promise<void> {
    this.quitting = true;
    if (!this.child) return;
    await disconnect().catch(() => undefined);
    this.child.kill();
    this.child = null;
  }
}

function request(method: 'GET' | 'POST', p: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: CORE_PORT, path: p, method, timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) reject(new Error(`HTTP ${res.statusCode}`));
          else resolve(body);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

export async function fetchStatus(): Promise<CoreStatus> {
  return JSON.parse(await request('GET', '/api/status', 800)) as CoreStatus;
}

export async function disconnect(): Promise<void> {
  await request('POST', '/api/disconnect', 2000);
}

/** 局域网配对：打开 / 关闭「配对新手机」窗口，取消某部手机的配对 */
export async function startPairing(): Promise<void> {
  await request('POST', '/api/pairing/start', 2000);
}

export async function cancelPairing(): Promise<void> {
  await request('POST', '/api/pairing/cancel', 2000);
}

/** 安装手机 USB 驱动：电脑端弹出 UAC，等用户确认并装完（最多 10 分钟） */
export async function installDriver(): Promise<{ ok: boolean; message?: string }> {
  return JSON.parse(await request('POST', '/api/driver/install', 11 * 60_000)) as { ok: boolean; message?: string };
}

/** 放行防火墙（银河麒麟）：电脑端弹出系统的密码框，等用户输入密码并完成 */
export async function allowFirewall(): Promise<{ ok: boolean; message?: string }> {
  return JSON.parse(await request('POST', '/api/firewall/allow', 11 * 60_000)) as { ok: boolean; message?: string };
}

export async function removePaired(id: string): Promise<void> {
  await request('POST', `/api/paired/remove?id=${encodeURIComponent(id)}`, 2000);
}
