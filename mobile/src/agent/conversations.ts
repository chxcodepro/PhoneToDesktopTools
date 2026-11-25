// 对话状态：当前对话的界面条目 + 发给模型的历史，运行 Agent，持久化会话列表。

import { fetch as expoFetch } from 'expo/fetch';

import { formatOcr } from '@/agent/ocr';
import { describeScreenshot, ocrAvailable, recognizeText } from '@/native/ocr';
import type { McpClient } from '@/protocol/mcpClient';
import type { ToolInfo, ToolResult } from '@/protocol/types';
import { connectionStore, getClient } from '@/state/connection';
import { deviceLabel, getDevice, onDeviceMerged } from '@/state/devices';
import { activeIds, getExtraClient, multiStore } from '@/state/multi';
import { uiStore } from '@/state/ui';
import { loadJson, saveJson } from '@/state/storage';
import { createStore, useStore } from '@/state/store';
import { appLog } from '@/lib/applog';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { runAgent, type AgentEvent, type AgentTools } from './agent';
import { formatSize, isSmallTextFile, readText, uploadToPcDetailed, type Attachment } from './attachments';
import { canCompress, compressHistory, isContextOverflow } from './compress';
import { downloadToPc } from './downloads';
import { extensionApi, extensionPrompt } from './extensionStore';
import { createExtensionTools, isExtensionTool } from './extensionTools';
import { createPcTools, uniqueNames, type PcTarget } from './multiPc';
import { copyBetweenPcs } from './pcCopy';
import type { ChatMessage, ContentPart, FetchLike, UsageStats } from './llm';
import { resolveActiveModel, type ResolvedModel } from './modelConfig';
import {
  isPhoneTool,
  createPhoneTools,
  type AskAnswer,
  type AskOption,
  type AskQuestion,
  type PcFile,
  type PhoneToolDeps,
  type ScheduleApi,
} from './phoneTools';

export type StepStatus = 'running' | 'ok' | 'error';

export interface Step {
  id: string;
  name: string;
  summary: string;
  status: StepStatus;
  result?: string;
}

/** 用户消息里的附件（界面显示用） */
export interface UiAttachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  size: number;
  /** 图片缩略图（手机本地文件） */
  uri?: string;
  /** pending 等待处理；sent 已发给模型；uploading 正在传到电脑；saved 已保存到电脑；error 失败 */
  status: 'pending' | 'sent' | 'uploading' | 'saved' | 'error';
  progress?: number;
  path?: string;
  error?: string;
}

/** 最近一次请求模型的统计（显示在输入框上方） */
export interface TurnStats {
  model: string;
  /** 上下文长度：本次请求的输入 + 输出 token */
  contextTokens: number;
  promptTokens: number;
  cachedTokens: number;
  /** 输出 token（含思考过程） */
  completionTokens: number;
  tokensPerSec: number | null;
  estimated: boolean;
  /** 模型的上下文上限（token） */
  contextWindow: number;
}

/** Agent 正在执行的操作（实时画面小窗、虚拟桌面页显示） */
export interface LiveAction {
  name: string;
  summary: string;
  at: number;
  /** 鼠标操作的屏幕坐标 */
  point?: { x: number; y: number };
}

function toLive(name: string, summary: string, args: Record<string, unknown>): LiveAction {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const x = num(args.to_x) ?? num(args.x);
  const y = num(args.to_y) ?? num(args.y);
  return { name, summary, at: Date.now(), point: name === 'input_mouse' && x !== undefined && y !== undefined ? { x, y } : undefined };
}

/** 上下文用到上限的这个比例时，发送前自动压缩 */
export const AUTO_COMPRESS_RATIO = 0.75;

export type UiItem =
  | { kind: 'user'; id: string; text: string; attachments?: UiAttachment[] }
  | { kind: 'assistant'; id: string; text: string; reasoning?: string }
  | { kind: 'steps'; id: string; steps: Step[]; image?: { data: string; mimeType: string } }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'error' }
  | ChoiceItem;

/** Agent 用 ask_user 弹出的选择卡片 */
export interface ChoiceItem {
  kind: 'choice';
  id: string;
  question: string;
  options: AskOption[];
  multiple: boolean;
  allowCustom: boolean;
  status: 'pending' | 'answered' | 'cancelled';
  answer?: AskAnswer;
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
  /** 属于哪台电脑（每台电脑各自的对话）；旧对话没有 */
  pcId?: string;
}

export interface ConversationState {
  list: ConversationMeta[];
  currentId: string | null;
  /** 当前对话属于哪台电脑 */
  pcId: string | null;
  title: string;
  items: UiItem[];
  history: ChatMessage[];
  running: boolean;
  modelLabel: string;
  stats: TurnStats | null;
  /** 本对话累计消耗的 token（每次请求的输入 + 输出之和） */
  totalTokens: number;
  live: LiveAction | null;
  ready: boolean;
  /** 对话面板中间短暂显示的提示（附件上传到电脑成功后等），id 每次不同 */
  toast: { id: string; text: string } | null;
}

const INDEX_KEY = 'p2d.conversations.v1';
const convKey = (id: string) => `p2d.conversation.${id}`;
const MAX_CONVERSATIONS = 50;

export const conversationStore = createStore<ConversationState>({
  list: [],
  currentId: null,
  pcId: null,
  title: '新对话',
  items: [],
  history: [],
  running: false,
  modelLabel: '',
  stats: null,
  totalTokens: 0,
  live: null,
  ready: false,
  toast: null,
});

/** 在对话面板中间显示一条提示，2.5 秒后自动消失 */
function flashToast(text: string): void {
  const toast = { id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, text };
  conversationStore.set({ toast });
  setTimeout(() => {
    if (conversationStore.get().toast?.id === toast.id) conversationStore.set({ toast: null });
  }, 2500);
}

let abort: AbortController | null = null;
let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

let initPromise: Promise<void> | null = null;
export function initConversations(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const list = await loadJson<ConversationMeta[]>(INDEX_KEY, []);
      conversationStore.set({ list, ready: true });
      // 打开 App 时已经在连（或连上了）某台电脑：直接显示这台电脑上次的对话，可以接着聊
      const pc = connectionStore.get().pcId;
      if (pc) resumeLatest(pc);
      watchComputer();
      onDeviceMerged((from, to) => void remapPcId(from, to));
    })();
  }
  return initPromise;
}

/** 还没开始聊（空白的新对话）时，显示这台电脑最近的对话；这台电脑没聊过就保持空白 */
function resumeLatest(pc: string): void {
  const s = conversationStore.get();
  if (s.running || s.currentId || s.items.length) return;
  const latest = s.list.find((c) => c.pcId === pc);
  if (latest) void openConversation(latest.id);
  else conversationStore.set({ pcId: pc });
}

/**
 * 换了一台电脑：当前对话属于别的电脑时，切到这台电脑最近的对话（没有就新建）；
 * 还没开始聊时（如刚打开 App）显示这台电脑上次的对话。Agent 正在执行时不切换
 */
function watchComputer(): void {
  let last = connectionStore.get().pcId;
  connectionStore.subscribe(() => {
    const pc = connectionStore.get().pcId;
    if (!pc || pc === last) return;
    last = pc;
    const s = conversationStore.get();
    if (s.running) return;
    if (!s.currentId) {
      resumeLatest(pc);
      return;
    }
    if (!s.pcId || s.pcId === pc) return;
    const latest = s.list.find((c) => c.pcId === pc);
    if (latest) void openConversation(latest.id);
    else newConversation();
  });
}

/** 同一台电脑的重复记录被合并：旧 pcId 下的对话归到新 pcId，按电脑筛选时不会被藏起来 */
async function remapPcId(from: string, to: string): Promise<void> {
  const s = conversationStore.get();
  if (!s.list.some((c) => c.pcId === from) && s.pcId !== from) return;
  const list = s.list.map((c) => (c.pcId === from ? { ...c, pcId: to } : c));
  conversationStore.set({ list, ...(s.pcId === from ? { pcId: to } : {}) });
  await saveJson(INDEX_KEY, list);
}

/** 持久化时去掉图片数据（体积太大），历史中的图片替换为文字 */
function stripImages(history: ChatMessage[]): ChatMessage[] {
  return history.map((m) =>
    Array.isArray(m.content)
      ? { ...m, content: m.content.map((p): ContentPart => (p.type === 'image_url' ? { type: 'text', text: '[图片未保存]' } : p)) }
      : m,
  );
}

async function save(): Promise<void> {
  const s = conversationStore.get();
  if (!s.currentId || s.items.length === 0) return;
  const items = s.items.map((it) => (it.kind === 'steps' ? { ...it, image: undefined } : it));
  await saveJson(convKey(s.currentId), {
    title: s.title,
    items,
    history: stripImages(s.history),
    stats: s.stats,
    totalTokens: s.totalTokens,
  });
  const meta: ConversationMeta = { id: s.currentId, title: s.title, updatedAt: Date.now(), pcId: s.pcId ?? undefined };
  const list = [meta, ...s.list.filter((c) => c.id !== s.currentId)];
  const dropped = list.slice(MAX_CONVERSATIONS);
  conversationStore.set({ list: list.slice(0, MAX_CONVERSATIONS) });
  await saveJson(INDEX_KEY, list.slice(0, MAX_CONVERSATIONS));
  await Promise.all(dropped.map((c) => AsyncStorage.removeItem(convKey(c.id)).catch(() => undefined)));
}

export function newConversation(): void {
  if (conversationStore.get().running) stop();
  conversationStore.set({
    currentId: null,
    pcId: connectionStore.get().pcId,
    title: '新对话',
    items: [],
    history: [],
    stats: null,
    totalTokens: 0,
  });
}

export async function openConversation(id: string): Promise<void> {
  if (conversationStore.get().running) stop();
  const data = await loadJson<{
    title: string;
    items: UiItem[];
    history: ChatMessage[];
    stats?: TurnStats | null;
    totalTokens?: number;
  } | null>(convKey(id), null);
  if (!data) return;
  conversationStore.set({
    currentId: id,
    pcId: conversationStore.get().list.find((c) => c.id === id)?.pcId ?? null,
    title: data.title,
    items: data.items,
    history: data.history,
    stats: data.stats ?? null,
    totalTokens: data.totalTokens ?? 0,
  });
}

export async function deleteConversation(id: string): Promise<void> {
  const s = conversationStore.get();
  const list = s.list.filter((c) => c.id !== id);
  conversationStore.set({ list });
  await saveJson(INDEX_KEY, list);
  await AsyncStorage.removeItem(convKey(id)).catch(() => undefined);
  if (s.currentId === id) newConversation();
}

export function stop(): void {
  abort?.abort();
}

/** 连接暂时中断时（换线、电脑端重启）等它自动重连，最多等 ms 毫秒 */
async function waitForClient(ms: number, signal?: AbortSignal) {
  const deadline = Date.now() + ms;
  for (;;) {
    const c = getClient();
    if (c && connectionStore.get().status === 'connected') return c;
    if (signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** 同时连接的电脑：连接暂时中断时等它自动重连，最多等 ms 毫秒 */
async function waitForExtra(pcId: string, ms: number, signal?: AbortSignal): Promise<McpClient | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const c = getExtraClient(pcId);
    if (c) return c;
    if (signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** 连接是否算「在用」：已连上，或者暂时断开正在自动重连（工具清单还在） */
const usable = (status: string, tools: unknown[]) =>
  tools.length > 0 && (status === 'connected' || status === 'connecting' || status === 'disconnected');

/**
 * Agent 能操作的电脑：当前电脑 + 同时连接的电脑。调用前若连接中断，先等最多 15 秒自动重连，仍未恢复再报错。
 * 电脑名去重后就是工具 pc 参数里的名字。
 */
function pcTargets(): PcTarget[] {
  const conn = connectionStore.get();
  const list: Omit<PcTarget, 'name'>[] = [];
  const labels: string[] = [];
  const allowed = (id: string | null) => !onlyPcs || (!!id && onlyPcs.includes(id));
  if (usable(conn.status, conn.tools) && allowed(conn.pcId)) {
    const dev = getDevice(conn.pcId);
    labels.push(dev ? deviceLabel(dev) : (conn.params?.host ?? '电脑'));
    list.push({
      id: conn.pcId ?? 'current',
      os: conn.params?.os ?? dev?.os ?? '',
      tools: conn.tools,
      async call(name, args, signal) {
        const c = await waitForClient(15_000, signal);
        if (!c) throw new Error('电脑连接已断开（等待 15 秒仍未重连），请检查数据线 / WiFi 和电脑端程序');
        return c.callTool(name, args, { signal });
      },
    });
  }
  const ms = multiStore.get();
  for (const id of activeIds(ms)) {
    const x = ms.conns[id];
    if (!x || id === conn.pcId || !allowed(id) || !usable(x.status, x.tools)) continue;
    const dev = getDevice(id);
    labels.push(deviceLabel(dev));
    list.push({
      id,
      os: dev?.os ?? '',
      tools: x.tools,
      async call(name, args, signal) {
        const c = await waitForExtra(id, 15_000, signal);
        if (!c) throw new Error(`「${deviceLabel(dev)}」的连接已断开（等待 15 秒仍未重连），请检查 WiFi 和电脑端程序`);
        return c.callTool(name, args, { signal });
      },
    });
  }
  const names = uniqueNames(labels);
  return list.map((t, i) => ({ ...t, name: names[i] }));
}

/** 定时任务指定了电脑时，这次运行只让 Agent 操作这几台（pcId） */
let onlyPcs: string[] | null = null;

/** 电脑工具：只连一台时原样；连多台时每个工具多一个 pc 参数 */
const pcTools = createPcTools(pcTargets);

/** 某台电脑现在的客户端（当前电脑或同时连接的） */
function clientOf(t: PcTarget): McpClient | null {
  return t.id === connectionStore.get().pcId || t.id === 'current' ? getClient() : getExtraClient(t.id);
}

/** 手机端工具：用手机的网络搜索、读网页、查微软驱动目录，下载文件后经 USB 传到电脑 */
/** 等待用户选择的卡片：卡片 id → 选完后继续 Agent 的回调 */
const pendingChoices = new Map<string, { resolve: (a: AskAnswer) => void; reject: (e: Error) => void }>();

function setChoice(id: string, patch: Partial<ChoiceItem>): void {
  mutateItems((items) => items.map((it) => (it.kind === 'choice' && it.id === id ? { ...it, ...patch } : it)));
}

/** 在对话里显示选择卡片，等用户选完（停止任务时取消） */
function askUser(q: AskQuestion, signal?: AbortSignal): Promise<AskAnswer> {
  const id = uid('q');
  mutateItems((items) => [...items, { kind: 'choice', id, ...q, status: 'pending' }]);
  return new Promise<AskAnswer>((resolve, reject) => {
    const onAbort = () => {
      pendingChoices.delete(id);
      setChoice(id, { status: 'cancelled' });
      reject(Object.assign(new Error('已停止'), { name: 'AbortError' }));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    pendingChoices.set(id, {
      resolve: (a) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(a);
      },
      reject,
    });
  });
}

/** 用户在选择卡片上做出选择 */
export function answerChoice(id: string, answer: AskAnswer): void {
  const p = pendingChoices.get(id);
  if (!p) return;
  pendingChoices.delete(id);
  setChoice(id, { status: 'answered', answer });
  conversationStore.set((st) => (st.live ? { live: { ...st.live, summary: '已选择，继续执行' } } : {}));
  p.resolve(answer);
}

/** 这张卡片是否还在等用户选择（重新打开 App 后旧卡片已失效） */
export function isChoiceWaiting(id: string): boolean {
  return pendingChoices.has(id);
}

/** 多台电脑时 download_to_pc / save_attachment_to_pc 要传到的那台（调用期间设置；这两个工具不会同时执行） */
let downloadClient: McpClient | null = null;

/** 需要选电脑的手机工具（同时连着多台电脑时要加 pc 参数） */
const PC_TARGET_PHONE_TOOLS = new Set(['download_to_pc', 'save_attachment_to_pc']);

/** 最近发给模型、没有存到电脑的图片（编号 → 附件），用户之后说「存到电脑」时由 save_attachment_to_pc 上传。只在内存里，App 重开后清空 */
const recentImages = new Map<string, { att: Attachment; itemId: string }>();
const MAX_RECENT_IMAGES = 20;

function rememberImage(att: Attachment, itemId: string): void {
  recentImages.delete(att.id);
  recentImages.set(att.id, { att, itemId });
  while (recentImages.size > MAX_RECENT_IMAGES) recentImages.delete(recentImages.keys().next().value as string);
}

/** 按编号或文件名找图片；不填时取最近一张 */
function findRecentImage(ref: string): { att: Attachment; itemId: string } | null {
  const list = [...recentImages.values()];
  if (!ref) return list[list.length - 1] ?? null;
  return recentImages.get(ref) ?? [...list].reverse().find((x) => x.att.name === ref) ?? null;
}

async function saveAttachment(ref: string, opts: { signal?: AbortSignal }): Promise<PcFile & { name: string }> {
  const hit = findRecentImage(ref);
  if (!hit) throw new Error(recentImages.size ? `没有找到附件「${ref}」` : '没有可以保存的图片（App 重新打开后之前的图片会清空），请让用户重新发送');
  const c = downloadClient ?? getClient();
  if (!c) throw new Error('电脑连接已断开，请检查数据线 / WiFi');
  const { att, itemId } = hit;
  setAttachment(itemId, att.id, { status: 'uploading', progress: 0 });
  try {
    const r = await uploadToPcDetailed(c, att, {
      signal: opts.signal,
      onProgress: (sent, total) => setAttachment(itemId, att.id, { progress: total ? sent / total : 1 }),
    });
    // 电脑确认收完（upload.end 成功）才算存好，这时才提示
    setAttachment(itemId, att.id, { status: 'saved', path: r.path, progress: 1 });
    flashToast(`已把 ${att.name} 存到电脑`);
    return { ...r, name: att.name };
  } catch (e) {
    setAttachment(itemId, att.id, { status: 'sent' }); // 模型已经看过了，上传失败不算附件出错
    throw e;
  }
}

const phoneDeps: PhoneToolDeps = {
  askUser,
  fetch: expoFetch as unknown as FetchLike,
  downloadToPc: (url, name, opts) => {
    const c = downloadClient ?? getClient();
    if (!c) throw new Error('电脑连接已断开，请检查数据线 / WiFi');
    return downloadToPc(c, url, name, opts);
  },
  saveAttachment,
  // 下载进度显示在实时画面小窗和虚拟桌面页的状态栏
  onProgress: (text) => conversationStore.set((st) => (st.live ? { live: { ...st.live, summary: text } } : {})),
};
const phoneTools = createPhoneTools(phoneDeps);

/** 定时任务模块启动时注册（避免两个模块互相导入） */
export function registerScheduleApi(api: ScheduleApi): void {
  phoneDeps.schedules = api;
}

/** 扩展：已安装 MCP 的工具、skill_read / skill_run、ext_* */
const extTools = createExtensionTools({ api: extensionApi, askUser });

const errorResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** 两台电脑之间传文件（同时连着两台及以上时才有） */
function pcCopyTool(names: string[]): ToolInfo {
  return {
    name: 'pc_copy_file',
    description:
      '把一台电脑上的文件传到另一台电脑（经手机中转，不需要两台电脑互通网络），保存到目标电脑的「下载/p2d」目录，返回保存路径。只能传单个文件，文件夹请先压缩；最大 1 GB。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', enum: names, description: '源电脑' },
        path: { type: 'string', description: '源电脑上文件的绝对路径' },
        to: { type: 'string', enum: names, description: '目标电脑' },
      },
      required: ['from', 'path', 'to'],
    },
  };
}

async function runPcCopy(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const ts = pcTargets();
  const from = pcTools.resolve({ pc: args.from });
  const to = pcTools.resolve({ pc: args.to });
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  if (!from || !to) return errorResult(`请用 from / to 指定电脑：${ts.map((t) => t.name).join('、')}`);
  if (from.id === to.id) return errorResult('源电脑和目标电脑是同一台，用命令复制即可');
  if (!path) return errorResult('需要源文件路径 path');
  const a = clientOf(from);
  const b = clientOf(to);
  if (!a || !b) return errorResult(`「${(a ? to : from).name}」的连接已断开`);
  let last = 0;
  const r = await copyBetweenPcs(a, b, path, {
    signal,
    onProgress: (sent, total) => {
      const now = Date.now();
      if (now - last < 500 && sent < total) return;
      last = now;
      const text = `传文件 ${total ? Math.round((sent / total) * 100) : 100}%（${formatSize(sent)} / ${formatSize(total)}）`;
      conversationStore.set((st) => (st.live ? { live: { ...st.live, summary: text } } : {}));
    },
  });
  return {
    content: [
      {
        type: 'text',
        text: `已把【${from.name}】${r.from} 传到【${to.name}】${r.path}（${formatSize(r.size)}${r.sha256 ? `，SHA-256 ${r.sha256}` : ''}）`,
      },
    ],
  };
}

/** 多台电脑时 download_to_pc 也要指定传到哪台：加上必填的 pc 参数 */
function withPcParam(t: ToolInfo, names: string[], description: string): ToolInfo {
  const schema = (t.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
  return {
    ...t,
    inputSchema: {
      ...schema,
      type: 'object',
      properties: { pc: { type: 'string', enum: names, description }, ...(schema.properties ?? {}) },
      required: ['pc', ...(schema.required ?? [])],
    },
  };
}

/** 交给 Agent 的工具：电脑工具（已连接时，多台时带 pc 参数）+ 手机工具 + 扩展，按名称分派 */
function buildTools(withPc: boolean): AgentTools {
  const multi = () => withPc && pcTargets().length > 1;
  return {
    list: () => {
      const pcs = withPc ? pcTargets() : [];
      const names = pcs.map((t) => t.name);
      const phone = phoneTools
        .list()
        .map((t) => (pcs.length > 1 && PC_TARGET_PHONE_TOOLS.has(t.name) ? withPcParam(t, names, '传到哪台电脑') : t));
      return [...(withPc ? pcTools.list() : []), ...(pcs.length > 1 ? [pcCopyTool(names)] : []), ...phone, ...extTools.list()];
    },
    async call(name, args, signal) {
      if (name === 'pc_copy_file') return runPcCopy(args, signal);
      if (PC_TARGET_PHONE_TOOLS.has(name) && multi()) {
        const { pc, ...rest } = args;
        const t = pcTools.resolve({ pc });
        if (!t) return errorResult(`请用 pc 参数指定传到哪台电脑：${pcTargets().map((x) => x.name).join('、')}`);
        const c = clientOf(t);
        if (!c) return errorResult(`「${t.name}」的连接已断开`);
        downloadClient = c;
        try {
          const r = await phoneTools.call(name, rest, signal);
          return { ...r, content: r.content.map((x, i) => (i === 0 && x.type === 'text' ? { ...x, text: `【${t.name}】${x.text}` } : x)) };
        } finally {
          downloadClient = null;
        }
      }
      return isPhoneTool(name)
        ? phoneTools.call(name, args, signal)
        : isExtensionTool(name)
          ? extTools.call(name, args, signal)
          : pcTools.call(name, args, signal);
    },
    // 电脑工具按电脑分组（不同电脑同时执行）；传文件占两台电脑，和手机工具、扩展一起放在 main 组按顺序执行
    group: (name, args) =>
      isPhoneTool(name) || isExtensionTool(name) || name === 'pc_copy_file' ? 'main' : pcTools.group(name, args),
  };
}

function mutateItems(fn: (items: UiItem[]) => UiItem[]): void {
  conversationStore.set((s) => ({ items: fn(s.items) }));
}

/** 把 Agent 事件转换成界面条目 */
function applyEvent(e: AgentEvent): void {
  mutateItems((items) => {
    const out = [...items];
    const last = out[out.length - 1];
    switch (e.type) {
      case 'text':
      case 'reasoning': {
        if (last?.kind === 'assistant') {
          out[out.length - 1] =
            e.type === 'text' ? { ...last, text: last.text + e.delta } : { ...last, reasoning: (last.reasoning ?? '') + e.delta };
        } else {
          out.push(
            e.type === 'text'
              ? { kind: 'assistant', id: uid('a'), text: e.delta }
              : { kind: 'assistant', id: uid('a'), text: '', reasoning: e.delta },
          );
        }
        break;
      }
      case 'tool_start': {
        const step: Step = { id: e.id, name: e.name, summary: e.summary, status: 'running' };
        // 只有思考过程、没有正文的助手条目不单独显示
        if (last?.kind === 'assistant' && !last.text.trim()) out.pop();
        const tail = out[out.length - 1];
        if (tail?.kind === 'steps') out[out.length - 1] = { ...tail, steps: [...tail.steps, step] };
        else out.push({ kind: 'steps', id: uid('s'), steps: [step] });
        break;
      }
      case 'tool_end': {
        // 只记工具名和简短结果（不记参数和对话内容）
        if (e.isError) appLog('warn', `工具 ${e.name} 出错：${e.summary}`.slice(0, 500));
        for (let i = out.length - 1; i >= 0; i--) {
          const it = out[i];
          if (it.kind !== 'steps' || !it.steps.some((s) => s.id === e.id)) continue;
          out[i] = {
            ...it,
            steps: it.steps.map((s) => (s.id === e.id ? { ...s, status: e.isError ? 'error' : 'ok', result: e.summary } : s)),
            image: e.image ?? it.image,
          };
          break;
        }
        break;
      }
      case 'notice':
        out.push({ kind: 'notice', id: uid('n'), text: e.text, tone: 'info' });
        break;
    }
    return out;
  });
}

function setAttachment(itemId: string, attId: string, patch: Partial<UiAttachment>): void {
  mutateItems((items) =>
    items.map((it) =>
      it.kind === 'user' && it.id === itemId && it.attachments
        ? { ...it, attachments: it.attachments.map((a) => (a.id === attId ? { ...a, ...patch } : a)) }
        : it,
    ),
  );
}

/**
 * 处理附件：
 * - 图片只给模型看（支持图片的模型直接收图片，否则在手机上识别文字），不存到电脑；用户要放到电脑上时 Agent 调用 save_attachment_to_pc。
 * - 文件在电脑连着时上传到电脑（模型看不到文件，要在电脑上读），告诉模型保存路径；电脑未连接时，小的文本文件直接把内容交给模型。
 */
async function prepareAttachments(
  itemId: string,
  atts: Attachment[],
  supportsVision: boolean,
  signal: AbortSignal,
): Promise<{ parts: ContentPart[]; notes: string[] }> {
  const parts: ContentPart[] = [];
  const notes: string[] = [];
  for (const a of atts) {
    if (signal.aborted) break;
    if (a.kind === 'image') {
      rememberImage(a, itemId);
      const where = `编号 ${a.id}，没有存到电脑；用户要放到电脑上时调用 save_attachment_to_pc`;
      if (supportsVision) {
        parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${a.base64}` } });
        notes.push(`- 图片 ${a.name}（${formatSize(a.size)}，${where}）`);
      } else {
        // 模型看不到图片：在手机上识别图片里的文字交给模型
        const r = ocrAvailable ? await recognizeText(a.base64) : null;
        if (r?.lines.length) notes.push(`- 图片 ${a.name}（${where}）中的文字（手机端识别，坐标为图片像素）：\n${formatOcr(r, null)}`);
        else notes.push(`- 图片 ${a.name}（${where}）：${r ? '图片中没有识别到文字' : '当前模型看不到图片'}`);
      }
      setAttachment(itemId, a.id, { status: 'sent' });
      continue;
    }
    const client = getClient();
    if (client) {
      setAttachment(itemId, a.id, { status: 'uploading', progress: 0 });
      try {
        const { path } = await uploadToPcDetailed(client, a, {
          onProgress: (sent, total) => setAttachment(itemId, a.id, { progress: total ? sent / total : 1 }),
          signal,
        });
        setAttachment(itemId, a.id, { status: 'saved', path, progress: 1 });
        flashToast(`已把 ${a.name} 存到电脑`);
        notes.push(`- ${a.name}（${formatSize(a.size)}）：已保存到电脑 ${path}`);
      } catch (e) {
        const msg = (e as Error).message;
        setAttachment(itemId, a.id, { status: 'error', error: msg });
        notes.push(`- ${a.name}：上传到电脑失败（${msg}）`);
      }
      continue;
    }
    if (a.kind === 'file' && isSmallTextFile(a)) {
      try {
        const content = await readText(a);
        const fence = '```';
        notes.push(`- ${a.name} 的内容：\n${fence}\n${content}\n${fence}`);
        setAttachment(itemId, a.id, { status: 'sent' });
      } catch (e) {
        setAttachment(itemId, a.id, { status: 'error', error: (e as Error).message });
      }
      continue;
    }
    setAttachment(itemId, a.id, { status: 'error', error: '电脑未连接，无法上传' });
    notes.push(`- ${a.name}：电脑未连接，无法上传`);
  }
  return { parts, notes };
}

function toTurnStats(model: string, contextWindow: number, st: UsageStats): TurnStats {
  return {
    model,
    contextWindow,
    contextTokens: st.promptTokens + st.completionTokens,
    promptTokens: st.promptTokens,
    cachedTokens: st.cachedTokens,
    completionTokens: st.completionTokens,
    tokensPerSec: st.tokensPerSec,
    estimated: st.estimated,
  };
}

function notice(text: string, tone: 'info' | 'error' = 'info'): void {
  appLog(tone === 'error' ? 'warn' : 'info', `对话提示：${text}`);
  mutateItems((items) => [...items, { kind: 'notice', id: uid('n'), text, tone }]);
}

/** 在当前对话里显示一条提示（定时任务没能执行时等） */
export const showNotice = notice;

/** 压缩发给模型的历史；成功返回 true */
async function compressCurrent(model: ResolvedModel, signal: AbortSignal, reason: string, keepTurns = 2): Promise<boolean> {
  const st = conversationStore.get();
  if (!canCompress(st.history, keepTurns)) return false;
  notice(`${reason}，正在压缩较早的对话…`);
  try {
    const r = await compressHistory(st.history, { llm: model.llm, fetch: expoFetch as unknown as FetchLike, keepTurns, signal });
    if (!r) return false;
    // 压缩后上下文长度要等下一次请求才知道
    conversationStore.set({ history: r.history, stats: null });
    notice(`已把 ${r.compressed} 条较早的消息压缩成摘要，保留最近 ${keepTurns} 轮`);
    return true;
  } catch (e) {
    if ((e as Error).name === 'AbortError' || signal.aborted) throw e;
    notice(`压缩失败：${(e as Error).message}`, 'error');
    return false;
  }
}

/** 手动压缩上下文 */
export async function compressContext(): Promise<void> {
  if (conversationStore.get().running) return;
  const model = await resolveActiveModel();
  if (model.problem) {
    notice(`模型未配置好：${model.problem}`, 'error');
    return;
  }
  if (!canCompress(conversationStore.get().history)) {
    notice('对话还很短，不需要压缩');
    return;
  }
  abort = new AbortController();
  conversationStore.set({ running: true });
  try {
    await compressCurrent(model, abort.signal, '手动压缩');
  } catch {
    notice('已停止');
  } finally {
    abort = null;
    conversationStore.set({ running: false });
    await save();
  }
}

export interface SendOptions {
  /** 新对话的标题（默认取消息开头） */
  title?: string;
  /** 本次运行附加的系统提示（如定时任务说明） */
  extraPrompt?: string;
  /** 只让 Agent 操作这几台电脑（pcId；定时任务指定了电脑时） */
  pcs?: string[];
}

/** 发给模型的消息末尾附上发送时间（手机本地时间），便于理解「明天」「下周一」；界面上不显示 */
export function timeStamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const w = '日一二三四五六'[now.getDay()];
  return `［发送时间 ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} 周${w} ${p(now.getHours())}:${p(now.getMinutes())}］`;
}

export async function send(text: string, attachments: Attachment[] = [], opts: SendOptions = {}): Promise<void> {
  const t = text.trim();
  const s = conversationStore.get();
  if ((!t && attachments.length === 0) || s.running) return;

  const model = await resolveActiveModel();
  if (model.problem) {
    notice(`模型未配置好：${model.problem}。请到「设置 → 模型」填写。`, 'error');
    return;
  }

  const userItemId = uid('u');
  const uiAtts: UiAttachment[] = attachments.map((a) => ({
    id: a.id,
    kind: a.kind,
    name: a.name,
    size: a.size,
    uri: a.kind === 'image' ? a.uri : undefined,
    status: 'pending',
  }));
  conversationStore.set({
    currentId: s.currentId ?? uid('c'),
    pcId: s.pcId ?? connectionStore.get().pcId,
    title: s.items.length === 0 ? (opts.title || t || attachments[0]?.name || '新对话').slice(0, 24) : s.title,
    items: [...s.items, { kind: 'user', id: userItemId, text: t, attachments: uiAtts.length ? uiAtts : undefined }],
    running: true,
    modelLabel: model.label,
    live: null,
  });

  onlyPcs = opts.pcs?.length ? opts.pcs : null;
  abort = new AbortController();
  const signal = abort.signal;
  const aborted = () => Object.assign(new Error('已停止'), { name: 'AbortError' });
  let error: Error | undefined;

  try {
    const { parts, notes } = await prepareAttachments(userItemId, attachments, model.supportsVision, signal);

    // 上次请求的上下文已接近上限：先压缩较早的对话
    const last = s.stats;
    if (last && last.model === model.llm.model && last.contextTokens > model.contextWindow * AUTO_COMPRESS_RATIO) {
      const pct = Math.round((last.contextTokens / model.contextWindow) * 100);
      await compressCurrent(model, signal, `上下文已用 ${pct}%`);
    }

    let body = t || (parts.length ? '请看图片。' : '我添加了一些附件。');
    if (notes.length) body += `\n\n用户添加的附件：\n${notes.join('\n')}`;
    body += `\n\n${timeStamp()}`;
    const userMsg: ChatMessage = { role: 'user', content: parts.length ? [{ type: 'text', text: body }, ...parts] : body };
    conversationStore.set((st) => ({ history: [...st.history, userMsg] }));

    const conn = connectionStore.get();
    const pcs = pcTargets();
    const connected = pcs.length > 0;
    // 上下文超长时压缩后重试一次
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw aborted();
      const r = await runAgent(conversationStore.get().history, {
        llm: model.llm,
        fetch: expoFetch as unknown as FetchLike,
        supportsVision: model.supportsVision,
        supportsTools: model.supportsTools,
        tools: buildTools(connected),
        pcConnected: connected,
        extensionPrompt,
        computer:
          conn.params && !onlyPcs ? { host: conn.params.host, os: conn.params.os } : pcs[0] ? { host: pcs[0].name, os: pcs[0].os } : null,
        computers: pcs.length > 1 ? pcs.map((t) => ({ host: t.name, os: t.os })) : undefined,
        customPrompt: [model.systemPrompt, opts.extraPrompt].filter(Boolean).join('\n\n'),
        signal,
        onEvent: (e) => {
          if (e.type === 'usage') {
            conversationStore.set((st) => ({
              stats: toTurnStats(model.llm.model, model.contextWindow, e.stats),
              totalTokens: st.totalTokens + e.stats.promptTokens + e.stats.completionTokens,
            }));
            return;
          }
          applyEvent(e);
          if (e.type === 'tool_start') {
            conversationStore.set({ live: toLive(e.name, e.summary, e.args) });
            // 多台电脑：虚拟桌面和实时画面切到 Agent 正在操作的那台
            if (typeof e.args.pc === 'string') {
              const t = pcTools.resolve(e.args);
              if (t) uiStore.set({ viewPc: t.id === connectionStore.get().pcId || t.id === 'current' ? null : t.id });
            }
          }
        },
        // 模型看不到图片时，截图在手机上离线识别成文字和屏幕坐标
        describeImage: ocrAvailable ? describeScreenshot : undefined,
      });
      conversationStore.set((st) => ({ history: [...st.history, ...r.added] }));
      if (r.error && attempt === 0 && isContextOverflow(r.error) && (await compressCurrent(model, signal, '上下文超出模型上限', 1))) {
        continue;
      }
      error = r.error;
      break;
    }
  } catch (e) {
    error = e as Error;
  }
  abort = null;
  onlyPcs = null;
  conversationStore.set({ running: false, live: null });
  // 任务已结束，仍在等待的卡片作废
  mutateItems((items) =>
    items.map((it) => (it.kind === 'choice' && it.status === 'pending' ? { ...it, status: 'cancelled' as const } : it)),
  );

  if (error) {
    const isAbort = error.name === 'AbortError';
    mutateItems((items) => [
      ...items.map((it) =>
        it.kind === 'steps'
          ? { ...it, steps: it.steps.map((st) => (st.status === 'running' ? { ...st, status: 'error' as const, result: '已停止' } : st)) }
          : it,
      ),
      { kind: 'notice', id: uid('n'), text: isAbort ? '已停止' : error.message, tone: isAbort ? 'info' : 'error' },
    ]);
  }
  await save();
}

export function useConversation(): ConversationState {
  return useStore(conversationStore);
}
