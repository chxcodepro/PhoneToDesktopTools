// 电脑端助手的定时任务：共用手机端的时间计算（mobile/src/agent/schedule.ts）和 schedule_* 工具。
// 电脑端常驻托盘，到点直接在电脑上新建对话执行；P2D 没开着时错过的任务（超过 30 分钟）记为错过。
import { checkDue, computeNextRun, describeSchedule, type ScheduledTask, type ScheduleInput } from '@agent/schedule';
import type { ScheduleApi, SchedulePatch } from '@agent/phoneTools';
import { uid } from './bridge';
import { createStore } from './model';

export interface ScheduleState {
  tasks: ScheduledTask[];
  ready: boolean;
}

export const scheduleStore = createStore<ScheduleState>({ tasks: [], ready: false });

function setTasks(fn: (t: ScheduledTask[]) => ScheduledTask[]): void {
  scheduleStore.set((s) => ({ tasks: fn(s.tasks) }));
  void window.p2d.agent.storeSave('schedules', scheduleStore.get().tasks);
}

function patchTask(id: string, patch: Partial<ScheduledTask>): void {
  setTasks((tasks) => tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
}

export function createTask(input: ScheduleInput, createdBy: 'user' | 'agent'): ScheduledTask {
  const now = Date.now();
  const task: ScheduledTask = { ...input, id: uid('s'), enabled: true, createdAt: now, createdBy, nextRunAt: null };
  delete task.pcs; // 电脑端只在本机执行
  task.nextRunAt = computeNextRun(task, now);
  setTasks((tasks) => [...tasks, task]);
  return task;
}

export function updateTask(id: string, patch: SchedulePatch): ScheduledTask | null {
  const cur = scheduleStore.get().tasks.find((t) => t.id === id);
  if (!cur) return null;
  const { pcs: _pcs, ...rest } = patch;
  const next: ScheduledTask = { ...cur, ...rest };
  next.nextRunAt = next.enabled ? computeNextRun(next, Date.now()) : cur.nextRunAt;
  setTasks((tasks) => tasks.map((t) => (t.id === id ? next : t)));
  return next;
}

export function deleteTask(id: string): boolean {
  const exists = scheduleStore.get().tasks.some((t) => t.id === id);
  if (exists) setTasks((tasks) => tasks.filter((t) => t.id !== id));
  return exists;
}

export const scheduleApi: ScheduleApi = {
  list: () => scheduleStore.get().tasks,
  create: (input) => createTask(input, 'agent'),
  update: (id, patch) => updateTask(id, patch),
  remove: deleteTask,
};

/** 定时任务执行时附加给助手的说明 */
export function scheduledPrompt(t: ScheduledTask): string {
  return (
    `这是定时任务「${t.name}」（${describeSchedule(t)}）自动发起的执行，用户可能不在电脑前。` +
    '只做查询和低风险的操作；需要用户确认的事项（安装、删除、改系统设置、重启等）不要执行，在结果里列出来，留给用户决定。不要用键盘鼠标操作界面（会打扰正在用电脑的人）。完成后简要汇报结果。'
  );
}

/** 执行一个任务：由对话模块注入（避免循环引用） */
type Runner = (t: ScheduledTask) => Promise<{ ok: boolean; note?: string; conversationId?: string }>;
let runner: Runner | null = null;
let isBusy: () => boolean = () => false;
let running: string | null = null;

export async function runTask(id: string): Promise<void> {
  const t = scheduleStore.get().tasks.find((x) => x.id === id);
  if (!t || !runner || running || isBusy()) return;
  running = id;
  patchTask(id, { lastRunAt: Date.now(), lastStatus: 'running', lastNote: undefined });
  try {
    const r = await runner(t);
    patchTask(id, { lastStatus: r.ok ? 'ok' : 'error', lastNote: r.note, lastConversationId: r.conversationId });
  } catch (e) {
    patchTask(id, { lastStatus: 'error', lastNote: (e as Error).message });
  } finally {
    running = null;
  }
}

function tick(): void {
  const now = Date.now();
  const { due, missed } = checkDue(scheduleStore.get().tasks, now);
  for (const t of missed) {
    patchTask(t.id, {
      lastStatus: 'missed',
      lastRunAt: t.nextRunAt ?? now,
      lastNote: '到点时 P2D 没在运行，已错过',
      nextRunAt: computeNextRun(t, now),
      enabled: t.kind === 'once' ? false : t.enabled,
    });
  }
  // 助手正忙时先等着（30 分钟内会补执行）
  if (!due.length || running || isBusy()) return;
  const t = due[0];
  patchTask(t.id, { nextRunAt: computeNextRun({ ...t, lastRunAt: now }, now), enabled: t.kind === 'once' ? false : t.enabled });
  void runTask(t.id);
}

let initPromise: Promise<void> | null = null;

export function initSchedules(run: Runner, busy: () => boolean): Promise<void> {
  runner = run;
  isBusy = busy;
  initPromise ??= (async () => {
    const saved = ((await window.p2d.agent.storeLoad('schedules')) ?? []) as ScheduledTask[];
    scheduleStore.set({
      tasks: saved.map((t) => (t.lastStatus === 'running' ? { ...t, lastStatus: 'error', lastNote: 'P2D 被关闭，执行中断' } : t)),
      ready: true,
    });
    setInterval(tick, 20_000);
    setTimeout(tick, 3000);
  })();
  return initPromise;
}
