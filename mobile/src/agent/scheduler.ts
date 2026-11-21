// 定时任务的保存和执行。
// - App 开着时每 15 秒检查一次，回到前台时立即检查；到点且电脑已连接、Agent 空闲时，新建一个对话执行指令。
// - 每个启用的任务都在系统里预约一条到点通知：App 被系统冻结时，点通知打开 App 即可执行（30 分钟内补执行）。
// - 超过 30 分钟仍没能执行的记为「错过」，按周期算下一次。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { AppState, Platform } from 'react-native';

import { connectionStore } from '@/state/connection';
import { createStore, useStore } from '@/state/store';

import { conversationStore, newConversation, registerScheduleApi, send } from './conversations';
import { checkDue, computeNextRun, describeSchedule, type ScheduledTask, type ScheduleInput } from './schedule';

const STORAGE_KEY = 'p2d.schedules.v1';
const CHANNEL = 'schedules';
const TICK_MS = 15_000;

export interface SchedulerState {
  tasks: ScheduledTask[];
  ready: boolean;
}

export const schedulerStore = createStore<SchedulerState>({ tasks: [], ready: false });

export function useSchedules(): SchedulerState {
  return useStore(schedulerStore);
}

let seq = 0;
const uid = () => `t_${Date.now().toString(36)}_${(seq++).toString(36)}`;

async function persist(): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(schedulerStore.get().tasks)).catch(() => undefined);
  void syncNotifications();
}

function setTasks(fn: (tasks: ScheduledTask[]) => ScheduledTask[]): void {
  schedulerStore.set((s) => ({ tasks: fn(s.tasks) }));
  void persist();
}

function patchTask(id: string, patch: Partial<ScheduledTask>): void {
  setTasks((tasks) => tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
}

// ---------- 通知 ----------

let notifyReady: Promise<boolean> | null = null;

/** 第一次有启用的任务时请求通知权限 */
function ensureNotifications(): Promise<boolean> {
  if (!notifyReady) {
    notifyReady = (async () => {
      try {
        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync(CHANNEL, { name: '定时任务', importance: AndroidImportance.HIGH });
        }
        const cur = await Notifications.getPermissionsAsync();
        if (cur.granted) return true;
        return (await Notifications.requestPermissionsAsync()).granted;
      } catch {
        return false;
      }
    })();
  }
  return notifyReady;
}

/** 按当前任务重新预约所有到点通知 */
async function syncNotifications(): Promise<void> {
  const tasks = schedulerStore.get().tasks.filter((t) => t.enabled && t.nextRunAt && t.nextRunAt > Date.now());
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
    if (!tasks.length || !(await ensureNotifications())) return;
    for (const t of tasks) {
      await Notifications.scheduleNotificationAsync({
        content: { title: `定时任务「${t.name}」到时间了`, body: '打开 App 后会自动执行（电脑需要已连接）', data: { taskId: t.id } },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: t.nextRunAt!, channelId: CHANNEL },
      });
    }
  } catch {
    // 通知失败不影响 App 开着时的定时执行
  }
}

// ---------- 增删改 ----------

export function createTask(input: ScheduleInput, createdBy: 'user' | 'agent'): ScheduledTask {
  const now = Date.now();
  const task: ScheduledTask = { ...input, id: uid(), enabled: true, createdAt: now, createdBy, nextRunAt: null };
  task.nextRunAt = computeNextRun(task, now);
  setTasks((tasks) => [...tasks, task]);
  return task;
}

export function updateTask(id: string, input: Partial<ScheduleInput> & { enabled?: boolean }): ScheduledTask | null {
  const cur = schedulerStore.get().tasks.find((t) => t.id === id);
  if (!cur) return null;
  const next: ScheduledTask = { ...cur, ...input };
  // 修改了时间或重新启用：重新计算下次执行
  next.nextRunAt = next.enabled ? computeNextRun(next, Date.now()) : cur.nextRunAt;
  setTasks((tasks) => tasks.map((t) => (t.id === id ? next : t)));
  return next;
}

export function deleteTask(id: string): boolean {
  const exists = schedulerStore.get().tasks.some((t) => t.id === id);
  if (exists) setTasks((tasks) => tasks.filter((t) => t.id !== id));
  return exists;
}

// ---------- 执行 ----------

/** 定时任务执行时附加给 Agent 的说明 */
function scheduledPrompt(t: ScheduledTask): string {
  return (
    `这是定时任务「${t.name}」（${describeSchedule(t)}）自动发起的执行，用户可能不在手机旁。` +
    '只做查询和低风险的操作；需要用户确认的事项（安装、删除、改系统设置、重启等）不要执行，在结果里列出来，留给用户决定。完成后简要汇报结果。'
  );
}

let running: string | null = null;

/** 立即执行某个任务（到点执行或用户点「立即运行」） */
export async function runTask(id: string): Promise<void> {
  const t = schedulerStore.get().tasks.find((x) => x.id === id);
  if (!t || running || conversationStore.get().running) return;
  running = id;
  const startedAt = Date.now();
  patchTask(id, { lastRunAt: startedAt, lastStatus: 'running', lastNote: undefined });
  try {
    newConversation();
    await send(t.prompt, [], { title: `⏰ ${t.name}`, extraPrompt: scheduledPrompt(t) });
    const st = conversationStore.get();
    const last = st.items[st.items.length - 1];
    const failed = last?.kind === 'notice' && last.tone === 'error';
    patchTask(id, {
      lastStatus: failed ? 'error' : 'ok',
      lastNote: failed ? last.text : undefined,
      lastConversationId: st.currentId ?? undefined,
    });
  } catch (e) {
    patchTask(id, { lastStatus: 'error', lastNote: (e as Error).message });
  } finally {
    running = null;
  }
}

/** 到点检查 */
export function tick(): void {
  const now = Date.now();
  const { tasks } = schedulerStore.get();
  const { due, missed } = checkDue(tasks, now);
  for (const t of missed) {
    const nextRunAt = computeNextRun(t, now);
    patchTask(t.id, {
      lastStatus: 'missed',
      lastRunAt: t.nextRunAt ?? now,
      lastNote: '到点时 App 没在运行或电脑没连接，已错过',
      nextRunAt,
      enabled: t.kind === 'once' ? false : t.enabled,
    });
  }
  // 电脑没连接或 Agent 正忙时先等着（30 分钟内会补执行）
  if (!due.length || running || conversationStore.get().running || connectionStore.get().status !== 'connected') return;
  const t = due[0];
  // 先推进下次执行时间，避免重复触发；一次性任务执行后停用
  patchTask(t.id, { nextRunAt: computeNextRun({ ...t, lastRunAt: now }, now), enabled: t.kind === 'once' ? false : t.enabled });
  void runTask(t.id);
}

let initPromise: Promise<void> | null = null;

export function initScheduler(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        const tasks = raw ? (JSON.parse(raw) as ScheduledTask[]) : [];
        // 上次运行中被打断的任务记为失败
        schedulerStore.set({
          tasks: tasks.map((t) => (t.lastStatus === 'running' ? { ...t, lastStatus: 'error', lastNote: 'App 被关闭，执行中断' } : t)),
          ready: true,
        });
      } catch {
        schedulerStore.set({ ready: true });
      }
      registerScheduleApi({
        list: () => schedulerStore.get().tasks,
        create: (input) => createTask(input, 'agent'),
        update: (id, patch) => updateTask(id, patch),
        remove: deleteTask,
      });
      Notifications.setNotificationHandler({
        handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
      });
      void syncNotifications();
      setInterval(tick, TICK_MS);
      AppState.addEventListener('change', (s) => {
        if (s === 'active') tick();
      });
      // 电脑连上时也检查一次（到点时还没连上的任务）
      let last = connectionStore.get().status;
      connectionStore.subscribe(() => {
        const cur = connectionStore.get().status;
        if (cur === 'connected' && last !== 'connected') setTimeout(tick, 2000);
        last = cur;
      });
      tick();
    })();
  }
  return initPromise;
}
