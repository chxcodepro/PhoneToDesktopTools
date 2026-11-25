// 手机端运行日志：记下控制台输出、连接状态变化、Agent 工具出错、未捕获的错误，出问题时在「关于」里导出发给开发者。
// 只在内存里保留最近 3000 行，每 5 秒写一次 App 私有目录的 p2d-app.log；启动时把上次运行的日志留作「上次运行」（App 闪退后也能导出）。
// 不记录对话内容、API key、连接令牌。

import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { redact } from '@/lib/redact';

const MAX_LINES = 3000;
const MAX_LINE = 2000;
const FLUSH_MS = 5000;
/** 上次运行的日志最多保留多少字符 */
const MAX_PREV = 400_000;

type Level = 'info' | 'warn' | 'error';

const lines: string[] = [];
let dirty = false;
let installed = false;
let prevSession = '';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function time(d = new Date()): string {
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack.split('\n').slice(1, 6).join('\n')}` : ''}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 记一条日志 */
export function appLog(level: Level, ...parts: unknown[]): void {
  let text = redact(parts.map(stringify).join(' '));
  if (text.length > MAX_LINE) text = `${text.slice(0, MAX_LINE)}…（共 ${text.length} 字）`;
  lines.push(`${time()} ${level === 'info' ? 'I' : level === 'warn' ? 'W' : 'E'} ${text}`);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  dirty = true;
}

const logFile = () => new File(Paths.document, 'p2d-app.log');

function flush(): void {
  if (!dirty) return;
  dirty = false;
  try {
    const f = logFile();
    if (!f.exists) f.create();
    f.writeSync(lines.join('\n'));
  } catch {
    // 写不进去也不影响使用
  }
}

/** App 启动时调用一次：读出上次运行的日志，开始接管 console 和未捕获的错误 */
export function installAppLog(): void {
  if (installed) return;
  installed = true;
  try {
    const f = logFile();
    if (f.exists) {
      const t = f.textSync();
      prevSession = t.length > MAX_PREV ? `…（前面省略）…\n${t.slice(-MAX_PREV)}` : t;
    }
  } catch {
    // 读不了就算了
  }
  for (const [name, level] of [
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
  ] as const) {
    const orig = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      appLog(level, ...args);
      orig(...args);
    };
  }
  // 未捕获的 JS 错误（会导致闪退的那种）：先记下并立即写盘，再交给原来的处理
  const eu = (globalThis as { ErrorUtils?: { getGlobalHandler(): (e: unknown, fatal?: boolean) => void; setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void } }).ErrorUtils;
  if (eu) {
    const prev = eu.getGlobalHandler();
    eu.setGlobalHandler((e, fatal) => {
      appLog('error', fatal ? '未捕获的错误（App 会退出）：' : '未捕获的错误：', e);
      dirty = true;
      flush();
      prev(e, fatal);
    });
  }
  setInterval(flush, FLUSH_MS);
  appLog('info', `App 启动：版本 ${appVersion()}，${deviceLabel()}`);
}

export function appVersion(): string {
  return Constants.expoConfig?.version ?? '未知';
}

/** 手机型号和系统版本，如「OnePlus PJZ110，Android 15（API 35）」 */
export function deviceLabel(): string {
  if (Platform.OS !== 'android') return `${Platform.OS} ${String(Platform.Version)}`;
  const c = Platform.constants as { Brand?: string; Model?: string; Release?: string };
  return `${c.Brand ?? ''} ${c.Model ?? ''}，Android ${c.Release ?? '?'}（API ${String(Platform.Version)}）`.trim();
}

/** 导出的日志正文 */
export function buildLogText(extra: string[] = []): string {
  const head = [
    `p2d 手机端日志（导出时间 ${new Date().toLocaleString()}）`,
    `版本：${appVersion()}　手机：${deviceLabel()}`,
    ...extra,
  ];
  return [
    ...head,
    '',
    '===== 本次运行 =====',
    lines.join('\n') || '（没有记录）',
    '',
    '===== 上次运行 =====',
    prevSession || '（没有记录）',
    '',
  ].join('\n');
}

function stamp(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 把日志写到缓存目录的一个新文件，返回它（之后分享或传到电脑） */
export function writeLogFile(extra: string[] = []): File {
  flush();
  const f = new File(Paths.cache, `p2d-手机端日志-${stamp()}.txt`);
  if (f.exists) f.delete();
  f.create();
  f.writeSync(buildLogText(extra));
  return f;
}
