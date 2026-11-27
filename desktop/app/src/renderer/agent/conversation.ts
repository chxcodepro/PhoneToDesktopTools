// 电脑端助手的对话：界面条目 + 发给模型的历史，运行 Agent（共用手机端的 runAgent），保存对话记录。
// 工具 = Core 的电脑工具（经主进程调用 /api/agent/call）+ 共用的联网工具（搜索、读网页、查驱动、下载、ask_user）。
import { runAgent, type AgentEvent, type AgentTools } from '@agent/agent';
import { canCompress, compressHistory, isContextOverflow } from '@agent/compress';
import type { ChatMessage, UsageStats } from '@agent/llm';
import { createPhoneTools, PHONE_TOOLS, type AskAnswer, type AskOption, type AskQuestion } from '@agent/phoneTools';
import type { ToolInfo, ToolResult } from '../../../../../mobile/src/protocol/types';
import type { AgentToolsInfo } from '../../shared/types';
import { ipcFetch, uid } from './bridge';
import { createStore, resolveActiveModel, type ResolvedModel } from './model';
import { desktopSystemPrompt } from './prompt';

export type StepStatus = 'running' | 'ok' | 'error';

export interface Step {
  id: string;
  name: string;
  summary: string;
  status: StepStatus;
  result?: string;
}

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

export type UiItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; reasoning?: string }
  | { kind: 'steps'; id: string; steps: Step[]; image?: { data: string; mimeType: string } }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'error' }
  | ChoiceItem;

export interface TurnStats {
  model: string;
  contextTokens: number;
  contextWindow: number;
  tokensPerSec: number | null;
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
}

interface Saved {
  id: string;
  title: string;
  items: UiItem[];
  history: ChatMessage[];
  stats: TurnStats | null;
}

export interface ConversationState {
  list: ConversationMeta[];
  currentId: string | null;
  title: string;
  items: UiItem[];
  history: ChatMessage[];
  running: boolean;
  modelLabel: string;
  stats: TurnStats | null;
  /** 下载进度等实时提示（显示在输入框上方） */
  progress: string | null;
  ready: boolean;
}

const MAX_CONVERSATIONS = 100;
/** 上下文用到上限的这个比例时，发送前自动压缩 */
const AUTO_COMPRESS_RATIO = 0.75;

export const convStore = createStore<ConversationState>({
  list: [],
  currentId: null,
  title: '',
  items: [],
  history: [],
  running: false,
  modelLabel: '',
  stats: null,
  progress: null,
  ready: false,
});

let abort: AbortController | null = null;

export async function initConversations(): Promise<void> {
  const list = ((await window.p2d.agent.convList()) as ConversationMeta[]).filter((m) => m && typeof m.id === 'string');
  convStore.set({ list, ready: true });
}

function mutateItems(f: (items: UiItem[]) => UiItem[]): void {
  convStore.set((s) => ({ items: f(s.items) }));
}

async function save(): Promise<void> {
  const s = convStore.get();
  if (!s.currentId || !s.items.length) return;
  const meta: ConversationMeta = { id: s.currentId, title: s.title || '新对话', updatedAt: Date.now() };
  let list = [meta, ...s.list.filter((m) => m.id !== s.currentId)];
  const dropped = list.slice(MAX_CONVERSATIONS);
  list = list.slice(0, MAX_CONVERSATIONS);
  convStore.set({ list });
  const data: Saved = { id: s.currentId, title: meta.title, items: s.items, history: s.history, stats: s.stats };
  try {
    await window.p2d.agent.convSave(s.currentId, data, list);
    for (const d of dropped) await window.p2d.agent.convRemove(d.id, list);
  } catch (e) {
    console.error('保存对话失败：', e);
  }
}

export function newConversation(): void {
  if (convStore.get().running) return;
  convStore.set({ currentId: null, title: '', items: [], history: [], stats: null, progress: null });
}

export async function openConversation(id: string): Promise<void> {
  if (convStore.get().running || convStore.get().currentId === id) return;
  const d = (await window.p2d.agent.convLoad(id)) as Saved | null;
  if (!d) {
    const list = convStore.get().list.filter((m) => m.id !== id);
    convStore.set({ list });
    await window.p2d.agent.convRemove(id, list);
    return;
  }
  convStore.set({ currentId: d.id, title: d.title, items: d.items ?? [], history: d.history ?? [], stats: d.stats ?? null, progress: null });
}

export async function removeConversation(id: string): Promise<void> {
  const s = convStore.get();
  if (s.running && s.currentId === id) return;
  const list = s.list.filter((m) => m.id !== id);
  convStore.set({ list });
  if (s.currentId === id) newConversation();
  await window.p2d.agent.convRemove(id, list);
}

export function stop(): void {
  abort?.abort();
}

// ---------- 工具 ----------

/** 共用的联网工具里，电脑端用不上的（定时任务、对话图片存到电脑） */
const SKIP = new Set(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete', 'save_attachment_to_pc']);

/** 手机端的说明写的是「用手机的网络」，电脑端改一下 */
const DESCRIPTIONS: Record<string, string> = {
  web_search: '搜索网页（必应），返回标题、链接和摘要。查资料、查报错原因、找软件或驱动的官方下载页都用它。查到链接后用 web_fetch 读取页面。',
  web_fetch: '读取网页，返回正文文字和页面上的可下载文件链接（exe/msi/cab/zip/deb 等）。',
  ask_user:
    '在对话里显示一张选择卡片，等用户点选后返回结果。需要用户做决定时使用（几个版本选哪个、是否安装 / 重启、几种方案选哪种），不要在文字里让用户回复。选项写清楚区别，推荐项放第一个并在 description 里说明理由。',
  download_to_pc:
    '下载文件到这台电脑的「下载/P2D」目录，返回保存路径、SHA-256，Windows 上的安装包还会返回数字签名状态。只从官方来源下载（微软、厂商官网、系统官方软件源）。最大 1 GB。',
};

const LOCAL_TOOLS: ToolInfo[] = PHONE_TOOLS.filter((t) => !SKIP.has(t.name)).map((t) =>
  DESCRIPTIONS[t.name] ? { ...t, description: DESCRIPTIONS[t.name] } : t,
);
const LOCAL_NAMES = new Set(LOCAL_TOOLS.map((t) => t.name));

/** ask_user 等用户点选：选择卡片编号 → 回调 */
const pendingChoices = new Map<string, (a: AskAnswer) => void>();

export function answerChoice(id: string, answer: AskAnswer): void {
  const resolve = pendingChoices.get(id);
  if (!resolve) return;
  pendingChoices.delete(id);
  mutateItems((items) => items.map((it) => (it.kind === 'choice' && it.id === id ? { ...it, status: 'answered', answer } : it)));
  resolve(answer);
}

function askUser(q: AskQuestion, signal?: AbortSignal): Promise<AskAnswer> {
  const id = uid('q');
  mutateItems((items) => [
    ...items,
    { kind: 'choice', id, question: q.question, options: q.options, multiple: q.multiple, allowCustom: q.allowCustom, status: 'pending' },
  ]);
  return new Promise((resolve, reject) => {
    pendingChoices.set(id, resolve);
    signal?.addEventListener('abort', () => {
      pendingChoices.delete(id);
      reject(Object.assign(new Error('已停止'), { name: 'AbortError' }));
    });
  });
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function buildTools(info: AgentToolsInfo | null): AgentTools {
  const local = createPhoneTools({
    fetch: ipcFetch,
    downloadToPc: info
      ? async (url, name, { signal }) => {
          const id = uid('d');
          const off = window.p2d.agent.onDownloadProgress((did, got, total) => {
            if (did !== id) return;
            convStore.set({ progress: `正在下载 ${name}：${formatBytes(got)}${total ? ` / ${formatBytes(total)}` : ''}` });
          });
          const onAbort = () => window.p2d.agent.cancel(id);
          signal?.addEventListener('abort', onAbort);
          try {
            convStore.set({ progress: `正在下载 ${name}` });
            return await window.p2d.agent.download(id, url, name, info.downloadDir);
          } finally {
            off();
            signal?.removeEventListener('abort', onAbort);
            convStore.set({ progress: null });
          }
        }
      : null,
    askUser,
  });
  const pcTools = info?.tools.map((t): ToolInfo => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as ToolInfo['inputSchema'] })) ?? [];
  return {
    list: () => [...pcTools, ...LOCAL_TOOLS],
    async call(name, args, signal) {
      if (LOCAL_NAMES.has(name)) return local.call(name, args, signal);
      if (!info) return { content: [{ type: 'text', text: '电脑端服务连不上，电脑工具暂不可用' }], isError: true };
      const id = uid('t');
      const onAbort = () => window.p2d.agent.cancel(id);
      signal?.addEventListener('abort', onAbort);
      try {
        return (await window.p2d.agent.call(id, name, args)) as ToolResult;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

// ---------- 运行 ----------

function applyEvent(e: AgentEvent): void {
  mutateItems((items) => {
    const out = [...items];
    const last = out[out.length - 1];
    switch (e.type) {
      case 'text':
      case 'reasoning':
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
      case 'tool_start': {
        const step: Step = { id: e.id, name: e.name, summary: e.summary, status: 'running' };
        if (last?.kind === 'assistant' && !last.text.trim()) out.pop();
        const tail = out[out.length - 1];
        if (tail?.kind === 'steps') out[out.length - 1] = { ...tail, steps: [...tail.steps, step] };
        else out.push({ kind: 'steps', id: uid('s'), steps: [step] });
        break;
      }
      case 'tool_end':
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
      case 'notice':
        out.push({ kind: 'notice', id: uid('n'), text: e.text, tone: 'info' });
        break;
    }
    return out;
  });
}

function notice(text: string, tone: 'info' | 'error' = 'info'): void {
  mutateItems((items) => [...items, { kind: 'notice', id: uid('n'), text, tone }]);
}

function toStats(model: string, contextWindow: number, st: UsageStats): TurnStats {
  return { model, contextWindow, contextTokens: st.promptTokens + st.completionTokens, tokensPerSec: st.tokensPerSec };
}

async function compressCurrent(model: ResolvedModel, signal: AbortSignal, reason: string, keepTurns = 2): Promise<boolean> {
  const st = convStore.get();
  if (!canCompress(st.history, keepTurns)) return false;
  notice(`${reason}，正在压缩较早的对话…`);
  try {
    const r = await compressHistory(st.history, { llm: model.llm, fetch: ipcFetch, keepTurns, signal });
    if (!r) return false;
    convStore.set({ history: r.history, stats: null });
    notice(`已把 ${r.compressed} 条较早的消息压缩成摘要，保留最近 ${keepTurns} 轮`);
    return true;
  } catch (e) {
    if ((e as Error).name === 'AbortError' || signal.aborted) throw e;
    notice(`压缩失败：${(e as Error).message}`, 'error');
    return false;
  }
}

/** 发给模型的消息末尾附上发送时间（电脑本地时间），便于理解「明天」「下周一」；界面上不显示 */
function timeStamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const w = '日一二三四五六'[now.getDay()];
  return `［发送时间 ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} 周${w} ${p(now.getHours())}:${p(now.getMinutes())}］`;
}

export async function send(text: string): Promise<void> {
  const t = text.trim();
  const s = convStore.get();
  if (!t || s.running) return;
  const model = await resolveActiveModel();
  if (model.problem) {
    notice(`模型还没配置好：${model.problem}。请点右上角的「模型设置」填写。`, 'error');
    return;
  }
  convStore.set({
    currentId: s.currentId ?? uid('c'),
    title: s.items.length === 0 ? t.slice(0, 24) : s.title,
    items: [...s.items, { kind: 'user', id: uid('u'), text: t }],
    running: true,
    modelLabel: model.label,
  });
  abort = new AbortController();
  const signal = abort.signal;
  let error: Error | undefined;
  void save(); // 新对话马上出现在左边的列表里
  try {
    let info: AgentToolsInfo | null = null;
    try {
      info = await window.p2d.agent.tools();
    } catch (e) {
      console.error('取电脑工具失败：', e);
    }
    const last = s.stats;
    if (last && last.model === model.llm.model && last.contextTokens > model.contextWindow * AUTO_COMPRESS_RATIO) {
      await compressCurrent(model, signal, `上下文已用 ${Math.round((last.contextTokens / model.contextWindow) * 100)}%`);
    }
    const userMsg: ChatMessage = { role: 'user', content: `${t}\n\n${timeStamp()}` };
    convStore.set((st) => ({ history: [...st.history, userMsg] }));
    const tools = buildTools(info);
    for (let attempt = 0; ; attempt++) {
      const r = await runAgent(convStore.get().history, {
        llm: model.llm,
        fetch: ipcFetch,
        supportsVision: model.supportsVision,
        supportsTools: model.supportsTools,
        tools,
        signal,
        systemPrompt: (canSee) =>
          desktopSystemPrompt({
            host: info?.host ?? '本机',
            os: info?.os ?? '',
            canSee,
            supportsTools: model.supportsTools,
            pcTools: !!info,
            customPrompt: model.systemPrompt,
          }),
        onEvent: (e) => {
          if (e.type === 'usage') convStore.set({ stats: toStats(model.llm.model, model.contextWindow, e.stats) });
          else applyEvent(e);
        },
      });
      convStore.set((st) => ({ history: [...st.history, ...r.added] }));
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
  convStore.set({ running: false, progress: null });
  pendingChoices.clear();
  mutateItems((items) => items.map((it) => (it.kind === 'choice' && it.status === 'pending' ? { ...it, status: 'cancelled' as const } : it)));
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

/** 手动压缩上下文 */
export async function compressNow(): Promise<void> {
  if (convStore.get().running) return;
  const model = await resolveActiveModel();
  if (model.problem) {
    notice(`模型还没配置好：${model.problem}`, 'error');
    return;
  }
  if (!canCompress(convStore.get().history)) {
    notice('对话还很短，不需要压缩');
    return;
  }
  abort = new AbortController();
  convStore.set({ running: true });
  try {
    await compressCurrent(model, abort.signal, '手动压缩');
  } catch {
    notice('已停止');
  } finally {
    abort = null;
    convStore.set({ running: false });
    await save();
  }
}
