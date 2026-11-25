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

/** Core 的运行日志（追加写入，超过 1 MB 时从头开始），出问题时让用户把它发过来 */
export function coreLogPath(): string {
  return path.join(app.getPath('userData'), 'core.log');
}

function openLog(): fs.WriteStream | null {
  try {
    const p = coreLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const big = fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024;
    const w = fs.createWriteStream(p, { flags: big ? 'w' : 'a' });
    w.on('error', () => undefined);
    return w;
  } catch {
    return null;
  }
}

/** 服务启动后连续这么久都连不上，就提示「已启动但没有响应」 */
const UNRESPONSIVE_MS = 15_000;

export class CoreProcess {
  private child: ChildProcess | null = null;
  private quitting = false;
  private restarts = 0;
  private startedAt = 0;
  private log: fs.WriteStream | null = null;
  lastError = '';

  /** 没有由本程序启动的 Core 子进程（或已结束） */
  get stopped(): boolean {
    return this.child === null;
  }

  private note(line: string): void {
    this.log ??= openLog();
    this.log?.write(`[${new Date().toLocaleString()}] ${line}\n`);
  }

  start(): void {
    this.lastAttempt = Date.now();
    const exe = corePath();
    if (!fs.existsSync(exe)) {
      // 杀毒软件（Windows Defender、火绒等）常把没有数字签名的服务程序当成可疑程序删掉
      this.lastError =
        `找不到电脑端服务程序（${exe}）。通常是杀毒软件把它删掉了：请在「Windows 安全中心 → 病毒和威胁防护 → 保护历史记录」里` +
        '找到 p2d-core.exe，选择「还原」或「允许」，然后重新打开本程序。';
      this.note(this.lastError);
      console.error(this.lastError);
      return;
    }
    // 额外参数（开发调试用），例如 P2D_CORE_ARGS="-dev-token e2etoken"
    const extra = (process.env.P2D_CORE_ARGS ?? '').split(/\s+/).filter(Boolean);
    if (process.env.P2D_PORT) extra.push('-port', String(CORE_PORT));
    const startedAt = Date.now();
    this.startedAt = startedAt;
    this.note(`启动 ${exe} ${extra.join(' ')}`);
    let child: ChildProcess;
    try {
      child = spawn(exe, extra, {
        cwd: path.dirname(exe),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.lastError = spawnFailed(e as Error);
      this.note(this.lastError);
      return;
    }
    this.child = child;
    let tail = '';
    const onData = (b: Buffer) => {
      const s = b.toString('utf8');
      tail = (tail + s).slice(-2000);
      process.stdout.write(`[core] ${s}`);
      this.log ??= openLog();
      this.log?.write(s);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e) => {
      this.lastError = spawnFailed(e);
      this.note(this.lastError);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (this.quitting) return;
      this.note(`服务已退出（代码 ${code}）`);
      // 端口被 Windows 保留（Hyper-V / WSL / Docker）：服务会说明处理办法，原样显示；等用户处理后每 5 秒的重试会自动连上
      const reserved = /无法启动：(端口 \d+ 被 Windows 保留[^\r\n]*)/.exec(tail);
      if (reserved) {
        this.lastError = reserved[1];
        return;
      }
      // 端口已被占用：已有一个 Core 在运行时直接复用它（状态能连上，这条提示就不会显示）；否则是别的程序占着端口
      if (/无法监听端口|address already in use|Only one usage/i.test(tail)) {
        console.log('[core] 端口已被占用：若已有电脑端服务在运行则直接复用，否则稍后重试');
        this.lastError =
          `端口 ${CORE_PORT} 被占用，电脑端服务无法启动。可能是上次的服务卡住了：在任务管理器里结束所有 p2d-core.exe 后会自动重试；` +
          '如果没有 p2d-core.exe，说明是别的程序占用了这个端口，重启电脑后再试。';
        return;
      }
      const last = tail.trim().split(/\r?\n/).pop()?.trim();
      this.lastError = `电脑端服务已退出（代码 ${code}）${last ? `：${last}` : ''}`;
      if (this.restarts < 5 && Date.now() - startedAt > 1000) {
        this.restarts++;
        setTimeout(() => this.start(), 2000);
      }
    });
  }

  /**
   * 状态接口连不上时界面显示的原因。服务进程在运行却一直连不上时也要说明，不能一直停在「正在启动服务」：
   * 常见于安全软件拦截了本机连接、或服务启动时卡住。
   */
  offlineReason(): string {
    if (this.lastError) return this.lastError;
    if (this.child && Date.now() - this.startedAt > UNRESPONSIVE_MS) {
      return (
        `电脑端服务已经运行了 ${Math.round((Date.now() - this.startedAt) / 1000)} 秒，但连不上它（127.0.0.1:${CORE_PORT}）。` +
        `可能被安全软件拦截了，请把 p2d 加入信任；运行日志在 ${coreLogPath()}`
      );
    }
    return '';
  }

  private lastAttempt = 0;

  /** 服务连不上且本程序没有在运行 Core 时，每 5 秒重试启动一次（例如之前端口被占用、后来释放了） */
  ensureRunning(): void {
    if (this.quitting || this.child || Date.now() - this.lastAttempt < 5000) return;
    this.start();
  }

  /** 连上了：清掉之前的错误 */
  markOnline(): void {
    if (this.lastError) this.note('服务已连上');
    this.lastError = '';
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

/** 服务程序启动失败的说明：没有数字签名的程序可能被 Windows「智能应用控制」或杀毒软件拦截 */
function spawnFailed(e: Error): string {
  return (
    `电脑端服务启动失败：${e.message}。可能被 Windows「智能应用控制」或杀毒软件拦截了：请在「Windows 安全中心 → 保护历史记录」里允许 p2d-core.exe，` +
    '或在「Windows 安全中心 → 应用和浏览器控制 → 智能应用控制」里查看是否拦截了它。'
  );
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

/** 免调试连接（AOA，Linux）：让一台没开 USB 调试的手机切换到配件模式 */
export async function aoaConnect(id: string): Promise<{ ok: boolean; message?: string }> {
  return JSON.parse(await request('POST', `/api/aoa/connect?id=${encodeURIComponent(id)}`, 5000)) as { ok: boolean; message?: string };
}

export async function removePaired(id: string): Promise<void> {
  await request('POST', `/api/paired/remove?id=${encodeURIComponent(id)}`, 2000);
}
