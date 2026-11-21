// 对话状态：当前对话的界面条目 + 发给模型的历史，运行 Agent，持久化会话列表。

import { fetch as expoFetch } from 'expo/fetch';

import { formatOcr } from '@/agent/ocr';
import { describeScreenshot, ocrAvailable, recognizeText } from '@/native/ocr';
import { connectionStore, getClient } from '@/state/connection';
import { loadJson, saveJson } from '@/state/storage';
import { createStore, useStore } from '@/state/store';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { runAgent, type AgentEvent, type AgentTools } from './agent';
import { formatSize, isSmallTextFile, readText, uploadToPc, type Attachment } from './attachments';
import { canCompress, compressHistory, isContextOverflow } from './compress';
import { downloadToPc } from './downloads';
import { extensionApi, extensionPrompt } from './extensionStore';
import { createExtensionTools, isExtensionTool } from './extensionTools';
import type { ChatMessage, ContentPart, FetchLike, UsageStats } from './llm';
import { resolveActiveModel, type ResolvedModel } from './modelConfig';
import {
  isPhoneTool,
  createPhoneTools,
  type AskAnswer,
  type AskOption,
  type AskQuestion,
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
});

let abort: AbortController | null = null;
let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

let initPromise: Promise<void> | null = null;
export function initConversations(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const list = await loadJson<ConversationMeta[]>(INDEX_KEY, []);
      conversationStore.set({ list, ready: true });
      watchComputer();
    })();
  }
  return initPromise;
}

/** 换了一台电脑：当前对话属于别的电脑时，切到这台电脑最近的对话（没有就新建）。Agent 正在执行时不切换 */
function watchComputer(): void {
  let last = connectionStore.get().pcId;
  connectionStore.subscribe(() => {
    const pc = connectionStore.get().pcId;
    if (!pc || pc === last) return;
    last = pc;
    const s = conversationStore.get();
    if (s.running) return;
    if (!s.currentId) {
      conversationStore.set({ pcId: pc });
      return;
    }
    if (!s.pcId || s.pcId === pc) return;
    const latest = s.list.find((c) => c.pcId === pc);
    if (latest) void openConversation(latest.id);
    else newConversation();
  });
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

/** 电脑工具适配：调用前若连接中断，先等最多 15 秒自动重连，仍未恢复再报错 */
const pcTools: AgentTools = {
  list: () => connectionStore.get().tools,
  async call(name, args, signal) {
    const c = await waitForClient(15_000, signal);
    if (!c) throw new Error('电脑连接已断开（等待 15 秒仍未重连），请检查数据线 / WiFi 和电脑端程序');
    return c.callTool(name, args);
  },
};

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

const phoneDeps: PhoneToolDeps = {
  askUser,
  fetch: expoFetch as unknown as FetchLike,
  downloadToPc: (url, name, opts) => {
    const c = getClient();
    if (!c) throw new Error('电脑连接已断开，请检查数据线 / WiFi');
    return downloadToPc(c, url, name, opts);
  },
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

/** 交给 Agent 的工具：电脑工具（已连接时）+ 手机工具 + 扩展，按名称分派 */
function buildTools(withPc: boolean): AgentTools {
  return {
    list: () => [...(withPc ? pcTools.list() : []), ...phoneTools.list(), ...extTools.list()],
    call: (name, args, signal) =>
      isPhoneTool(name)
        ? phoneTools.call(name, args, signal)
        : isExtensionTool(name)
          ? extTools.call(name, args, signal)
          : pcTools.call(name, args, signal),
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
 * 处理附件：支持图片的模型直接收图片；其余附件上传到电脑，告诉模型保存路径。
 * 电脑未连接时，小的文本文件直接把内容交给模型。
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
    if (a.kind === 'image' && supportsVision) {
      parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${a.base64}` } });
      setAttachment(itemId, a.id, { status: 'sent' });
      continue;
    }
    // 模型看不到图片：先在手机上识别图片里的文字交给模型（同时照常上传到电脑）
    if (a.kind === 'image' && ocrAvailable) {
      const r = await recognizeText(a.base64);
      if (r?.lines.length) notes.push(`- ${a.name} 中的文字（手机端识别，坐标为图片像素）：\n${formatOcr(r, null)}`);
      else if (r) notes.push(`- ${a.name}：图片中没有识别到文字`);
      // 电脑没连接时不用上传，识别结果已经交给模型
      if (r && !getClient()) {
        setAttachment(itemId, a.id, { status: 'sent' });
        continue;
      }
    }
    const client = getClient();
    if (client) {
      setAttachment(itemId, a.id, { status: 'uploading', progress: 0 });
      try {
        const path = await uploadToPc(client, a, (sent, total) => setAttachment(itemId, a.id, { progress: total ? sent / total : 1 }));
        setAttachment(itemId, a.id, { status: 'saved', path, progress: 1 });
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
  mutateItems((items) => [...items, { kind: 'notice', id: uid('n'), text, tone }]);
}

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
    const connected = conn.status === 'connected' && !!getClient();
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
        computer: conn.params ? { host: conn.params.host, os: conn.params.os } : null,
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
          if (e.type === 'tool_start') conversationStore.set({ live: toLive(e.name, e.summary, e.args) });
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
