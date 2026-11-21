// 定时任务：到点后让 Agent 自动执行一段指令（如每天早上体检电脑、每周清理一次下载目录）。
// 这里只有数据结构和时间计算，不依赖 React Native，可在 Node 中测试；执行在 scheduler.ts。
// 时间一律按手机本地时区。

export type ScheduleKind = 'once' | 'daily' | 'weekly' | 'interval';

export interface ScheduleSpec {
  kind: ScheduleKind;
  /** once：执行时刻（毫秒时间戳） */
  at?: number;
  /** daily / weekly：每天的时刻 "HH:MM" */
  time?: string;
  /** weekly：周几执行，1 = 周一 … 7 = 周日 */
  weekdays?: number[];
  /** interval：间隔分钟数（不少于 MIN_INTERVAL） */
  intervalMin?: number;
}

export type RunStatus = 'running' | 'ok' | 'error' | 'missed';

export interface ScheduledTask extends ScheduleSpec {
  id: string;
  name: string;
  /** 到点后发给 Agent 的指令 */
  prompt: string;
  enabled: boolean;
  createdAt: number;
  createdBy: 'user' | 'agent';
  /** 下次执行时刻；null 表示不再执行（一次性任务已执行或已过期） */
  nextRunAt: number | null;
  lastRunAt?: number;
  lastStatus?: RunStatus;
  lastNote?: string;
  /** 最近一次执行所在的对话 */
  lastConversationId?: string;
}

/** 间隔任务最短间隔（分钟） */
export const MIN_INTERVAL = 15;
/** 到点后多久内仍会补执行（App 被系统冻结、电脑暂时没连上时）；超过就记为错过 */
export const GRACE_MS = 30 * 60_000;

const WEEKDAY_NAMES = ['', '一', '二', '三', '四', '五', '六', '日'];

export function parseTime(time: string | undefined): { h: number; m: number } | null {
  const m = /^(\d{1,2})[:：](\d{2})$/.exec((time ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? { h, m: min } : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** JS 的 getDay()（0 = 周日）转成 1 = 周一 … 7 = 周日 */
const isoWeekday = (d: Date) => ((d.getDay() + 6) % 7) + 1;

/** 计算 after 之后的下一次执行时刻 */
export function computeNextRun(spec: ScheduleSpec & { createdAt?: number; lastRunAt?: number }, after: number): number | null {
  switch (spec.kind) {
    case 'once':
      return spec.at && spec.at > after ? spec.at : null;
    case 'daily':
    case 'weekly': {
      const t = parseTime(spec.time);
      if (!t) return null;
      const days = spec.kind === 'weekly' ? (spec.weekdays ?? []).filter((d) => d >= 1 && d <= 7) : [1, 2, 3, 4, 5, 6, 7];
      if (!days.length) return null;
      const base = new Date(after);
      for (let i = 0; i <= 7; i++) {
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, t.h, t.m, 0, 0);
        if (d.getTime() > after && days.includes(isoWeekday(d))) return d.getTime();
      }
      return null;
    }
    case 'interval': {
      const step = Math.max(MIN_INTERVAL, spec.intervalMin ?? 0) * 60_000;
      const origin = spec.lastRunAt ?? spec.createdAt ?? after;
      if (origin > after) return origin;
      return origin + (Math.floor((after - origin) / step) + 1) * step;
    }
  }
}

export function formatDateTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const diff = Math.round((day - today) / 86_400_000);
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `明天 ${hm}`;
  if (diff === -1) return `昨天 ${hm}`;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear() === n.getFullYear() ? md : `${d.getFullYear()}年${md}`} ${hm}`;
}

/** 给人看的周期说明，如「每天 08:30」「每周一、三、五 09:00」「每 2 小时」 */
export function describeSchedule(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case 'once':
      return spec.at ? `${formatDateTime(spec.at)}（一次）` : '一次';
    case 'daily':
      return `每天 ${spec.time ?? ''}`;
    case 'weekly': {
      const days = [...new Set(spec.weekdays ?? [])].sort((a, b) => a - b);
      const label =
        days.length === 7
          ? '每天'
          : days.join(',') === '1,2,3,4,5'
            ? '工作日'
            : days.join(',') === '6,7'
              ? '周末'
              : `每周${days.map((d) => WEEKDAY_NAMES[d]).join('、')}`;
      return `${label} ${spec.time ?? ''}`;
    }
    case 'interval': {
      const n = spec.intervalMin ?? MIN_INTERVAL;
      return n % 60 === 0 ? `每 ${n / 60} 小时` : `每 ${n} 分钟`;
    }
  }
}

/** 解析「YYYY-MM-DD HH:MM」（本地时间） */
export function parseLocalDateTime(s: string): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  return Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 ? null : d.getTime();
}

export interface ScheduleInput extends ScheduleSpec {
  name: string;
  prompt: string;
}

/** 整理 Agent 工具（或表单）传来的参数；不合法时返回错误说明 */
export function parseScheduleArgs(args: Record<string, unknown>, now = Date.now()): ScheduleInput | string {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const name = str(args.name).slice(0, 40);
  const prompt = str(args.prompt).slice(0, 2000);
  if (!name) return 'name 不能为空';
  if (!prompt) return 'prompt 不能为空（到点后要让 Agent 做什么）';
  const kind = str(args.kind) as ScheduleKind;
  switch (kind) {
    case 'once': {
      const at = parseLocalDateTime(str(args.datetime));
      if (!at) return 'once 需要 datetime，格式 "YYYY-MM-DD HH:MM"（手机本地时间）';
      if (at <= now) return '执行时间已经过去了';
      return { name, prompt, kind, at };
    }
    case 'daily':
    case 'weekly': {
      const time = str(args.time);
      const t = parseTime(time);
      if (!t) return `${kind} 需要 time，格式 "HH:MM"`;
      const normalized = `${pad(t.h)}:${pad(t.m)}`;
      if (kind === 'daily') return { name, prompt, kind, time: normalized };
      const weekdays = [
        ...new Set((Array.isArray(args.weekdays) ? args.weekdays : []).map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)),
      ].sort((a, b) => a - b);
      if (!weekdays.length) return 'weekly 需要 weekdays，如 [1,3,5]（1 = 周一，7 = 周日）';
      return { name, prompt, kind, time: normalized, weekdays };
    }
    case 'interval': {
      const n = Math.round(Number(args.interval_minutes));
      if (!Number.isFinite(n) || n < MIN_INTERVAL) return `interval 需要 interval_minutes，不少于 ${MIN_INTERVAL}`;
      return { name, prompt, kind, intervalMin: Math.min(n, 7 * 24 * 60) };
    }
    default:
      return 'kind 只能是 once / daily / weekly / interval';
  }
}

/** 到点检查：返回需要立即执行的任务，以及已经错过（超过补执行时限）的任务 */
export function checkDue(tasks: ScheduledTask[], now: number): { due: ScheduledTask[]; missed: ScheduledTask[] } {
  const due: ScheduledTask[] = [];
  const missed: ScheduledTask[] = [];
  for (const t of tasks) {
    if (!t.enabled || t.nextRunAt == null || t.nextRunAt > now || t.lastStatus === 'running') continue;
    (now - t.nextRunAt > GRACE_MS ? missed : due).push(t);
  }
  return { due, missed };
}
