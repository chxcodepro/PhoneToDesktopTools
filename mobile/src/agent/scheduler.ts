// 定时任务的保存和执行。
// - App 开着时每 15 秒检查一次，回到前台时立即检查；到点且电脑已连接、Agent 空闲时，新建一个对话执行指令。
// - 每个启用的任务都在系统里预约一条到点通知：App 被系统冻结时，点通知打开 App 即可执行（30 分钟内补执行）。
// - 超过 30 分钟仍没能执行的记为「错过」，按周期算下一次。
// - 指定了电脑的任务：到点后自动连上这些电脑（没在「同时连接」里的临时连，执行完断开），
//   全部连上就执行；等了 2 分钟还有没连上的，就只在已连上的电脑上执行，并在结果里说明。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { AppState, Platform } from 'react-native';

import { connectionStore, connectPicked } from '@/state/connection';
import { deviceLabel, devicesStore, getDevice, onDeviceMerged, type PcDevice } from '@/state/devices';
import { connectExtra, getExtraClient, multiStore, releaseTemp } from '@/state/multi';
import { createStore, useStore } from '@/state/store';

import { conversationStore, newConversation, registerScheduleApi, send, showNotice } from './conversations';
import { resolvePc, uniqueNames } from './multiPc';
import type { SchedulePatch } from './phoneTools';
import { checkDue, computeNextRun, describeSchedule, PCS_WAIT_MS, type ScheduledTask, type ScheduleInput } from './schedule';

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

export function updateTask(id: string, input: Partial<ScheduleInput> & SchedulePatch): ScheduledTask | null {
  const cur = schedulerStore.get().tasks.find((t) => t.id === id);
  if (!cur) return null;
  const next: ScheduledTask = { ...cur, ...input };
  if (input.pcs && !input.pcs.length) delete next.pcs;
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

// ---------- 指定的电脑 ----------

/** 所有记住的电脑（名字去重，和 Agent 看到的一致） */
function knownPcs(devs: PcDevice[] = devicesStore.get().devices): { id: string; name: string }[] {
  const names = uniqueNames(devs.map((d) => deviceLabel(d)));
  return devs.map((d, i) => ({ id: d.pcId, name: names[i] }));
}

/** 电脑的显示名；界面里传入 useDevices() 的列表，改名、加载后才会刷新 */
export function pcLabel(id: string, devs?: PcDevice[]): string {
  return knownPcs(devs).find((p) => p.id === id)?.name ?? '已删除的电脑';
}

function resolvePcs(names: string[]): string[] | string {
  const pcs = knownPcs();
  const ids: string[] = [];
  const bad: string[] = [];
  for (const n of names) {
    const p = resolvePc(pcs, n);
    if (p) ids.push(p.id);
    else bad.push(n);
  }
  if (bad.length) return `找不到电脑：${bad.join('、')}。记住的电脑有：${pcs.map((p) => p.name).join('、') || '（无）'}`;
  return [...new Set(ids)];
}

/** 任务指定的电脑（去掉已删除的）；没指定返回 null */
function taskPcs(t: ScheduledTask): string[] | null {
  return t.pcs?.length ? t.pcs.filter((id) => getDevice(id)) : null;
}

/** 这台电脑现在能用：已连上并拿到了工具清单 */
function pcReady(id: string): boolean {
  const cur = connectionStore.get();
  if (cur.pcId === id) return cur.status === 'connected' && cur.tools.length > 0;
  return !!getExtraClient(id) && (multiStore.get().conns[id]?.tools.length ?? 0) > 0;
}

const lastTry = new Map<string, number>();

/** 去连指定的电脑：当前电脑没在连就重连，其他电脑临时同时连接。每台 30 秒内只试一次 */
function connectPcs(ids: string[]): void {
  const now = Date.now();
  const cur = connectionStore.get();
  for (const id of ids) {
    if (pcReady(id) || now - (lastTry.get(id) ?? 0) < 30_000) continue;
    lastTry.set(id, now);
    if (cur.pcId === id) {
      // 正在自动重连的不用管
      if (cur.status === 'idle') void connectPicked(id).catch(() => undefined);
      continue;
    }
    const x = multiStore.get().conns[id];
    if (!x || x.status === 'idle') void connectExtra(id, { manual: false, remember: false }).catch(() => undefined);
  }
}

/** 连上指定的电脑，最多等 ms 毫秒，返回已连上的 */
async function ensurePcs(ids: string[], ms: number): Promise<string[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    connectPcs(ids);
    const ready = ids.filter(pcReady);
    // 剩下的都是没配对的（又不是当前电脑）：连不上，不用等
    const cur = connectionStore.get().pcId;
    const hopeless = ids.every((id) => ready.includes(id) || (id !== cur && !getDevice(id)?.paired));
    if (ready.length === ids.length || hopeless || Date.now() >= deadline) return ready;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const names = (ids: string[]) => ids.map((id) => pcLabel(id)).join('、');

/** 电脑都没连上时的说明：没配对的（又不是当前电脑）只能插线用，单独说 */
function notConnected(ids: string[]): string {
  const cur = connectionStore.get().pcId;
  const unpaired = ids.filter((id) => id !== cur && !getDevice(id)?.paired);
  const rest = ids.filter((id) => !unpaired.includes(id));
  const parts: string[] = [];
  if (rest.length) parts.push(`「${names(rest)}」没连上，请确认电脑开着、电脑端在运行，手机和电脑在同一个 WiFi 或都连着 Tailscale`);
  if (unpaired.length) parts.push(`「${names(unpaired)}」还没配对，只能插数据线时用（插一次线就会自动配对）`);
  return parts.join('；');
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

/**
 * 立即执行某个任务（到点执行或用户点「立即运行」）。
 * 指定了电脑时先连上它们，最多等 waitMs 毫秒；只连上一部分就在这部分上执行。
 */
export async function runTask(id: string, waitMs = 20_000): Promise<void> {
  const t = schedulerStore.get().tasks.find((x) => x.id === id);
  if (!t || running || conversationStore.get().running) return;
  running = id;
  const startedAt = Date.now();
  patchTask(id, { lastRunAt: startedAt, lastStatus: 'running', lastNote: undefined });
  const ids = taskPcs(t);
  try {
    let extra = scheduledPrompt(t);
    let only: string[] | undefined;
    if (ids) {
      if (!ids.length) throw new Error('指定的电脑都已从设备列表删除，请编辑任务重新选择电脑');
      const ready = await ensurePcs(ids, waitMs);
      if (!ready.length) throw new Error(notConnected(ids));
      only = ready;
      const missing = ids.filter((x) => !ready.includes(x));
      extra += `\n这个任务指定在「${names(ids)}」上执行。`;
      if (missing.length) extra += `其中「${names(missing)}」没连上，这次只在「${names(ready)}」上执行，请在汇报里说明哪几台没执行。`;
    }
    newConversation();
    await send(t.prompt, [], { title: `⏰ ${t.name}`, extraPrompt: extra, pcs: only });
    const st = conversationStore.get();
    const last = st.items[st.items.length - 1];
    const failed = last?.kind === 'notice' && last.tone === 'error';
    patchTask(id, {
      lastStatus: failed ? 'error' : 'ok',
      lastNote: failed ? last.text : undefined,
      lastConversationId: st.currentId ?? undefined,
    });
  } catch (e) {
    const msg = (e as Error).message;
    patchTask(id, { lastStatus: 'error', lastNote: msg });
    if (!conversationStore.get().running) {
      newConversation();
      showNotice(`定时任务「${t.name}」没能执行：${msg}`, 'error');
    }
  } finally {
    running = null;
    for (const x of ids ?? []) releaseTemp(x);
  }
}

/** 到点的任务现在能不能执行 */
function runnable(t: ScheduledTask, now: number): boolean {
  const ids = taskPcs(t);
  if (!ids) return connectionStore.get().status === 'connected';
  // 电脑都被删了：执行时报错
  if (!ids.length) return true;
  const ready = ids.filter(pcReady).length;
  return ready === ids.length || (ready > 0 && now - (t.nextRunAt ?? now) >= PCS_WAIT_MS);
}

/** 到点检查 */
export function tick(): void {
  const now = Date.now();
  const { tasks } = schedulerStore.get();
  const { due, missed } = checkDue(tasks, now);
  for (const t of missed) {
    const nextRunAt = computeNextRun(t, now);
    const ids = taskPcs(t);
    patchTask(t.id, {
      lastStatus: 'missed',
      lastRunAt: t.nextRunAt ?? now,
      lastNote: ids?.length ? `到点时 App 没在运行或「${names(ids)}」没连上，已错过` : '到点时 App 没在运行或电脑没连接，已错过',
      nextRunAt,
      enabled: t.kind === 'once' ? false : t.enabled,
    });
    for (const x of ids ?? []) releaseTemp(x);
  }
  if (!due.length) return;
  // 指定了电脑的任务：先去连上
  for (const t of due) {
    const ids = taskPcs(t);
    if (ids?.length) connectPcs(ids);
  }
  // 电脑没连上或 Agent 正忙时先等着（30 分钟内会补执行）
  if (running || conversationStore.get().running) return;
  const t = due.find((x) => runnable(x, now));
  if (!t) return;
  // 先推进下次执行时间，避免重复触发；一次性任务执行后停用
  patchTask(t.id, { nextRunAt: computeNextRun({ ...t, lastRunAt: now }, now), enabled: t.kind === 'once' ? false : t.enabled });
  void runTask(t.id, 0);
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
        pcNames: () => knownPcs().map((p) => p.name),
        resolvePcs,
        pcLabel: (id) => pcLabel(id),
      });
      // 同一台电脑的旧记录合并时，任务里的 pcId 跟着换
      onDeviceMerged((from, to) => {
        if (!schedulerStore.get().tasks.some((t) => t.pcs?.includes(from))) return;
        setTasks((tasks) => tasks.map((t) => (t.pcs?.includes(from) ? { ...t, pcs: [...new Set(t.pcs.map((x) => (x === from ? to : x)))] } : t)));
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
      // 同时连接的电脑连上（拿到工具清单）时也检查一次
      let readyKey = '';
      multiStore.subscribe(() => {
        const { conns } = multiStore.get();
        const key = Object.values(conns)
          .filter((c) => c.status === 'connected' && c.tools.length)
          .map((c) => c.pcId)
          .sort()
          .join(',');
        if (key !== readyKey && key.split(',').some((id) => id && !readyKey.split(',').includes(id))) setTimeout(tick, 1000);
        readyKey = key;
      });
      tick();
    })();
  }
  return initPromise;
}
