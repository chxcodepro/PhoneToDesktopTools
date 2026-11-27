// 电脑端助手的对话：界面条目 + 发给模型的历史，运行 Agent（共用手机端的 runAgent），保存对话记录。
// 工具 = Core 的电脑工具（经主进程调用 /api/agent/call）+ 共用的联网工具（搜索、读网页、查驱动、下载、ask_user、定时任务）
//      + 剪贴板 + 扩展（Skill、MCP）。危险操作按设置先弹确认卡片。
import { runAgent, type AgentEvent, type AgentTools } from '@agent/agent';
import { canCompress, compressHistory, isContextOverflow } from '@agent/compress';
import { createExtensionTools } from '@agent/extensionTools';
import type { ChatMessage, ContentPart, UsageStats } from '@agent/llm';
import { createPhoneTools, PHONE_TOOLS, type AskAnswer, type AskOption, type AskQuestion } from '@agent/phoneTools';
import type { ScheduledTask } from '@agent/schedule';
import type { ToolInfo, ToolResult } from '../../../../../mobile/src/protocol/types';
import type { AgentToolsInfo } from '../../shared/types';
import { ipc, ipcFetch, uid } from './bridge';
import { extensionApi, extensionPrompt, initExtensions, setPlatformOs } from './extensions';
import { createStore, initSettings, resolveActiveModel, settingsStore, type ConfirmMode, type ResolvedModel } from './model';
import { desktopSystemPrompt } from './prompt';
import { initSchedules, scheduleApi, scheduledPrompt } from './schedules';

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

/** 用户消息里的附件（界面显示用；图片只存缩略图，原图在发给模型的历史里） */
export interface UiAttachment {
  kind: 'image' | 'file';
  name: string;
  path?: string;
  thumb?: string;
}

/** 发送时的附件：图片带原图（data URL，已缩到合适大小） */
export interface Attachment extends UiAttachment {
  dataUrl?: string;
}

export type UiItem =
  /** histLen：发这条消息前历史的长度（重新回答、编辑时截断用；压缩过上下文后作废） */
  | { kind: 'user'; id: string; text: string; attachments?: UiAttachment[]; histLen?: number }
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
/** 「这次对话都允许」：记下是哪个对话 */
let allowAllIn: string | null = null;
/** 定时任务自动执行（没人在电脑前）：不弹确认卡片，危险操作直接拒绝 */
let unattended = false;

let initPromise: Promise<void> | null = null;

export function initConversations(): Promise<void> {
  initPromise ??= (async () => {
    const list = ((await window.p2d.agent.convList()) as ConversationMeta[]).filter((m) => m && typeof m.id === 'string');
    convStore.set({ list, ready: true });
    await initSettings();
    void initExtensions();
    void initSchedules(runScheduled, () => convStore.get().running);
  })();
  return initPromise;
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

/** 共用的联网工具里，电脑端用不上的 */
const SKIP = new Set(['save_attachment_to_pc']);

/** 手机端的说明写的是「用手机的网络」「App」，电脑端改一下 */
const DESCRIPTIONS: Record<string, string> = {
  web_search: '搜索网页（必应），返回标题、链接和摘要。查资料、查报错原因、找软件或驱动的官方下载页都用它。查到链接后用 web_fetch 读取页面。',
  web_fetch: '读取网页，返回正文文字和页面上的可下载文件链接（exe/msi/cab/zip/deb 等）。',
  ask_user:
    '在对话里显示一张选择卡片，等用户点选后返回结果。需要用户做决定时使用（几个版本选哪个、是否安装 / 重启、几种方案选哪种），不要在文字里让用户回复。选项写清楚区别，推荐项放第一个并在 description 里说明理由。',
  download_to_pc:
    '下载文件到这台电脑的「下载/P2D」目录，返回保存路径、SHA-256，Windows 上的安装包还会返回数字签名状态。只从官方来源下载（微软、厂商官网、系统官方软件源）。最大 1 GB。',
  schedule_create:
    '创建定时任务：到点后在这台电脑上新建对话，把 prompt 当作用户指令交给你执行（例如每天早上体检电脑、每周五清理下载目录）。时间按电脑本地时间，参考用户消息末尾的发送时间换算。' +
    'P2D 要开着（在托盘里就行）；到点时没开着，30 分钟内打开会补执行。无人值守时只会做查询和低风险操作。',
};

const LOCAL_TOOLS: ToolInfo[] = PHONE_TOOLS.filter((t) => !SKIP.has(t.name)).map((t) => {
  if (t.name === 'schedule_create' || t.name === 'schedule_update') {
    // 去掉「在哪几台电脑上执行」
    const schema = t.inputSchema as { properties?: Record<string, unknown> };
    const { pcs: _pcs, ...props } = schema.properties ?? {};
    return { ...t, description: DESCRIPTIONS[t.name] ?? t.description, inputSchema: { ...t.inputSchema, properties: props } };
  }
  return DESCRIPTIONS[t.name] ? { ...t, description: DESCRIPTIONS[t.name] } : t;
});
const LOCAL_NAMES = new Set(LOCAL_TOOLS.map((t) => t.name));

const CLIPBOARD_TOOLS: ToolInfo[] = [
  {
    name: 'clipboard_read',
    description: '读取剪贴板：文字，以及复制的图片（有的话）。用户说「我复制的」「剪贴板里的」时用。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'clipboard_write',
    description: '把文字放进剪贴板，用户可以直接粘贴（如生成好的命令、文案、翻译结果）。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

/** 动键鼠、操作界面的工具：执行时显示「AI 助手正在操作电脑」的提示 */
const OPERATING = new Set(['input_mouse', 'input_keyboard', 'ui_act', 'window_activate']);

const textResult = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], isError });

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
  if (unattended) return Promise.resolve({ selected: [], custom: '（定时任务自动执行，用户不在电脑前，没法回答。不要做需要用户决定的事，在汇报里列出来）' });
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

// 高风险命令：删除、格式化、关机、改注册表 / 服务 / 账户 / 权限、卸载软件等
const DANGER =
  /(^|[\s&|;(])(del|erase|rd|rmdir|format|diskpart|shutdown|restart-computer|stop-computer|bcdedit|takeown|icacls|cacls|cipher|vssadmin|wevtutil|remove-item|rm|mkfs|dd|chmod|chown|userdel|passwd|reboot|poweroff|halt)(\s|$|\.exe)|reg(\.exe)?\s+(delete|add|import)|sc(\.exe)?\s+(delete|config|stop)|net(\.exe)?\s+(user|localgroup|stop|share)|taskkill|wmic\b.*\b(delete|call\s+terminate|uninstall)|systemctl\s+(stop|disable|mask)|(apt|apt-get|yum|dnf)\s+(remove|purge|autoremove)|dpkg\s+(-r|-P|--remove|--purge)|msiexec(\.exe)?\s+\/x|set-executionpolicy|netsh\s+(advfirewall|firewall|winsock|int)/i;

/** 这个工具调用要不要先问用户；要问时返回卡片上的说明 */
function confirmText(mode: ConfirmMode, name: string, args: Record<string, unknown>): string | null {
  if (mode === 'off') return null;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const all = mode === 'all';
  switch (name) {
    case 'shell_exec': {
      const cmd = s(args.command);
      if (all || args.admin === true || DANGER.test(cmd)) return `${args.admin ? '以管理员身份' : ''}执行命令：\n${cmd}`;
      return null;
    }
    case 'skill_run':
      return all || args.admin === true ? `运行 Skill「${s(args.name)}」的脚本 ${s(args.script)}${args.admin ? '（管理员）' : ''}` : null;
    case 'fs_delete':
      return `删除（移到回收站）：\n${s(args.path)}`;
    case 'fs_write':
      return all ? `写入文件：\n${s(args.path)}` : null;
    case 'fs_edit':
      return all ? `修改文件：\n${s(args.path)}` : null;
    case 'download_to_pc':
      return all ? `下载文件：\n${s(args.url) || s(args.catalog_id)}` : null;
    default:
      return null;
  }
}

/** 危险操作先弹确认卡片；返回 null 表示可以执行，否则是给模型的拒绝说明 */
async function confirmCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string | null> {
  const what = confirmText(settingsStore.get().confirm, name, args);
  if (!what) return null;
  if (unattended) return '定时任务自动执行时不做这类操作（用户不在电脑前，没法确认）。在汇报里列出来，留给用户决定。';
  const cur = convStore.get().currentId;
  if (cur && allowAllIn === cur) return null;
  const a = await askUser(
    {
      question: `助手要${what}`,
      options: [{ label: '允许' }, { label: '这次对话都允许', description: '这个对话里后面的操作不再询问' }, { label: '不允许' }],
      multiple: false,
      allowCustom: true,
    },
    signal,
  );
  const pick = a.selected[0];
  if (pick === '这次对话都允许') {
    allowAllIn = convStore.get().currentId;
    return null;
  }
  if (pick === '允许') return null;
  return `用户没有允许这个操作${a.custom ? `，并说：${a.custom}` : ''}。不要再尝试同样的操作；换一种方式，或问用户想怎么做。`;
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
            return await ipc(window.p2d.agent.download(id, url, name, info.downloadDir));
          } finally {
            off();
            signal?.removeEventListener('abort', onAbort);
            convStore.set({ progress: null });
          }
        }
      : null,
    askUser,
    schedules: scheduleApi,
  });
  const ext = createExtensionTools({ api: extensionApi, askUser });
  const pcTools = info?.tools.map((t): ToolInfo => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as ToolInfo['inputSchema'] })) ?? [];
  const pcNames = new Set(pcTools.map((t) => t.name));
  return {
    list: () => [...pcTools, ...LOCAL_TOOLS, ...CLIPBOARD_TOOLS, ...ext.list()],
    async call(name, args, signal) {
      const refused = await confirmCall(name, args, signal);
      if (refused) return textResult(refused, true);
      if (LOCAL_NAMES.has(name)) return local.call(name, args, signal);
      if (name === 'clipboard_read') {
        const c = await window.p2d.agent.clipboardRead();
        const content: ToolResult['content'] = [{ type: 'text', text: c.text ? `剪贴板文字：\n${c.text.slice(0, 20000)}` : '剪贴板里没有文字' }];
        if (c.image) content.push({ type: 'image', data: c.image.replace(/^data:[^,]+,/, ''), mimeType: 'image/png' });
        return { content };
      }
      if (name === 'clipboard_write') {
        await window.p2d.agent.clipboardWrite(typeof args.text === 'string' ? args.text : '');
        return textResult('已放进剪贴板');
      }
      if (!pcNames.has(name)) return ext.call(name, args, signal);
      if (!info) return textResult('电脑端服务连不上，电脑工具暂不可用', true);
      const id = uid('t');
      const onAbort = () => window.p2d.agent.cancel(id);
      signal?.addEventListener('abort', onAbort);
      try {
        return (await ipc(window.p2d.agent.call(id, name, args))) as ToolResult;
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
    // 历史变短了，记下的位置作废（压缩前的消息不能再「重新回答」「编辑」）
    convStore.set((s) => ({
      history: r.history,
      stats: null,
      items: s.items.map((it) => (it.kind === 'user' && it.histLen !== undefined ? { ...it, histLen: undefined } : it)),
    }));
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

/** 用户消息：文字 + 附件说明 + 图片 */
function buildUserMessage(text: string, atts: Attachment[], vision: boolean): ChatMessage {
  const notes: string[] = [];
  const parts: ContentPart[] = [];
  for (const a of atts) {
    if (a.kind === 'image' && a.dataUrl && vision) {
      parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
      if (a.path) notes.push(`- 图片「${a.name}」：${a.path}`);
    } else if (a.kind === 'image') {
      notes.push(`- 图片「${a.name}」${a.path ? `：${a.path}` : ''}（当前模型看不到图片${a.path ? '，需要时可以用工具处理这个文件' : ''}）`);
    } else {
      notes.push(`- 文件「${a.name}」：${a.path}（文本用 fs_read，Word / Excel / PPT / PDF 用 doc_read）`);
    }
  }
  let body = text || (parts.length ? '请看图片。' : '请看我添加的文件。');
  if (notes.length) body += `\n\n用户添加的附件：\n${notes.join('\n')}`;
  body += `\n\n${timeStamp()}`;
  return { role: 'user', content: parts.length ? [{ type: 'text', text: body }, ...parts] : body };
}

export interface SendOptions {
  /** 新对话的标题（默认取消息开头） */
  title?: string;
  /** 本次运行附加的系统提示（定时任务说明） */
  extraPrompt?: string;
  /** 定时任务自动执行 */
  unattended?: boolean;
}

export async function send(text: string, attachments: Attachment[] = [], opts: SendOptions = {}): Promise<void> {
  const t = text.trim();
  if ((!t && !attachments.length) || convStore.get().running) return;
  const model = await resolveActiveModel();
  if (model.problem) {
    notice(`模型还没配置好：${model.problem}。请点右上角的「模型设置」填写。`, 'error');
    return;
  }
  const s = convStore.get();
  const ui: UiAttachment[] = attachments.map(({ dataUrl: _d, ...a }) => a);
  const userId = uid('u');
  convStore.set({
    currentId: s.currentId ?? uid('c'),
    title: s.items.length === 0 ? (opts.title || t || attachments[0]?.name || '新对话').slice(0, 24) : s.title,
    items: [...s.items, { kind: 'user', id: userId, text: t, attachments: ui.length ? ui : undefined }],
  });
  await runTurn(model, (m) => buildUserMessage(t, attachments, m.supportsVision), userId, opts);
}

/**
 * 运行一轮：（需要时先压缩）→ 加上用户消息 → 运行 Agent。
 * makeUser 在压缩之后调用，用户消息的位置记在界面条目上（重新回答、编辑时按它截断历史）。
 */
async function runTurn(model: ResolvedModel, makeUser: (m: ResolvedModel) => ChatMessage, userItemId: string, opts: SendOptions): Promise<void> {
  convStore.set({ running: true, modelLabel: model.label });
  unattended = opts.unattended === true;
  abort = new AbortController();
  const signal = abort.signal;
  let error: Error | undefined;
  let operating = false;
  window.p2d.agentActive(true, false);
  void save(); // 新对话马上出现在左边的列表里
  try {
    let info: AgentToolsInfo | null = null;
    try {
      info = await ipc(window.p2d.agent.tools());
      setPlatformOs(info.os);
    } catch (e) {
      console.error('取电脑工具失败：', e);
    }
    const last = convStore.get().stats;
    if (last && last.model === model.llm.model && last.contextTokens > model.contextWindow * AUTO_COMPRESS_RATIO) {
      await compressCurrent(model, signal, `上下文已用 ${Math.round((last.contextTokens / model.contextWindow) * 100)}%`);
    }
    const userMsg = makeUser(model);
    convStore.set((st) => ({
      history: [...st.history, userMsg],
      items: st.items.map((it) => (it.kind === 'user' && it.id === userItemId ? { ...it, histLen: st.history.length } : it)),
    }));
    const tools = buildTools(info);
    const custom = [model.systemPrompt, opts.extraPrompt].filter(Boolean).join('\n\n');
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
            extensionPrompt: extensionPrompt(),
            customPrompt: custom,
          }),
        onEvent: (e) => {
          if (e.type === 'usage') {
            convStore.set({ stats: toStats(model.llm.model, model.contextWindow, e.stats) });
            return;
          }
          if (e.type === 'tool_start' && OPERATING.has(e.name) && !operating) {
            operating = true;
            window.p2d.agentActive(true, true);
          }
          applyEvent(e);
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
  unattended = false;
  window.p2d.agentActive(false, false);
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

/** 最后一条用户消息（能重新回答 / 编辑的那条） */
export function lastUserItem(items: UiItem[]): Extract<UiItem, { kind: 'user' }> | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'user') return it.histLen !== undefined ? it : null;
  }
  return null;
}

/** 截断到最后一条用户消息之前；返回那条消息（发给模型的原样） */
function truncateToLastUser(): { item: Extract<UiItem, { kind: 'user' }>; msg: ChatMessage } | null {
  const s = convStore.get();
  const item = lastUserItem(s.items);
  if (s.running || !item || item.histLen === undefined) return null;
  const msg = s.history[item.histLen];
  if (!msg || msg.role !== 'user') return null;
  const idx = s.items.indexOf(item);
  convStore.set({ items: s.items.slice(0, idx), history: s.history.slice(0, item.histLen) });
  return { item, msg };
}

/** 重新回答最后一个问题（用户消息原样再发一次，图片也在） */
export async function regenerate(): Promise<void> {
  const model = await resolveActiveModel();
  if (model.problem) {
    notice(`模型还没配置好：${model.problem}`, 'error');
    return;
  }
  const r = truncateToLastUser();
  if (!r) return;
  const id = uid('u');
  mutateItems((items) => [...items, { ...r.item, id, histLen: undefined }]);
  await runTurn(model, () => r.msg, id, {});
}

/** 编辑最后一条消息：截掉它和之后的回答，把文字和附件还给输入框 */
export function editLast(): { text: string; attachments: Attachment[] } | null {
  const r = truncateToLastUser();
  if (!r) return null;
  const images = Array.isArray(r.msg.content)
    ? r.msg.content.filter((p): p is Extract<ContentPart, { type: 'image_url' }> => p.type === 'image_url').map((p) => p.image_url.url)
    : [];
  let n = 0;
  const attachments: Attachment[] = (r.item.attachments ?? []).map((a) => (a.kind === 'image' && images[n] ? { ...a, dataUrl: images[n++] } : { ...a }));
  void save();
  return { text: r.item.text, attachments };
}

/** 定时任务：新建对话，无人值守地执行 */
async function runScheduled(t: ScheduledTask): Promise<{ ok: boolean; note?: string; conversationId?: string }> {
  newConversation();
  await send(t.prompt, [], { title: `定时：${t.name}`, extraPrompt: scheduledPrompt(t), unattended: true });
  const st = convStore.get();
  const last = st.items[st.items.length - 1];
  const failed = last?.kind === 'notice' && last.tone === 'error';
  return { ok: !failed, note: failed ? last.text : undefined, conversationId: st.currentId ?? undefined };
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
