// 对话状态：当前对话的界面条目 + 发给模型的历史，运行 Agent，持久化会话列表。

import { fetch as expoFetch } from 'expo/fetch';

import { connectionStore, getClient } from '@/state/connection';
import { loadJson, saveJson } from '@/state/storage';
import { createStore, useStore } from '@/state/store';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { runAgent, type AgentEvent, type AgentTools } from './agent';
import type { ChatMessage, ContentPart, FetchLike } from './llm';
import { resolveActiveModel } from './modelConfig';

export type StepStatus = 'running' | 'ok' | 'error';

export interface Step {
  id: string;
  name: string;
  summary: string;
  status: StepStatus;
  result?: string;
}

export type UiItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; reasoning?: string }
  | { kind: 'steps'; id: string; steps: Step[]; image?: { data: string; mimeType: string } }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'error' };

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
}

export interface ConversationState {
  list: ConversationMeta[];
  currentId: string | null;
  title: string;
  items: UiItem[];
  history: ChatMessage[];
  running: boolean;
  modelLabel: string;
  ready: boolean;
}

const INDEX_KEY = 'p2d.conversations.v1';
const convKey = (id: string) => `p2d.conversation.${id}`;
const MAX_CONVERSATIONS = 50;

export const conversationStore = createStore<ConversationState>({
  list: [],
  currentId: null,
  title: '新对话',
  items: [],
  history: [],
  running: false,
  modelLabel: '',
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
    })();
  }
  return initPromise;
}

/** 持久化时去掉图片数据（体积太大），历史中的图片替换为文字 */
function stripImages(history: ChatMessage[]): ChatMessage[] {
  return history.map((m) =>
    Array.isArray(m.content)
      ? { ...m, content: m.content.map((p): ContentPart => (p.type === 'image_url' ? { type: 'text', text: '[截图未保存]' } : p)) }
      : m,
  );
}

async function save(): Promise<void> {
  const s = conversationStore.get();
  if (!s.currentId || s.items.length === 0) return;
  const items = s.items.map((it) => (it.kind === 'steps' ? { ...it, image: undefined } : it));
  await saveJson(convKey(s.currentId), { title: s.title, items, history: stripImages(s.history) });
  const meta: ConversationMeta = { id: s.currentId, title: s.title, updatedAt: Date.now() };
  const list = [meta, ...s.list.filter((c) => c.id !== s.currentId)];
  const dropped = list.slice(MAX_CONVERSATIONS);
  conversationStore.set({ list: list.slice(0, MAX_CONVERSATIONS) });
  await saveJson(INDEX_KEY, list.slice(0, MAX_CONVERSATIONS));
  await Promise.all(dropped.map((c) => AsyncStorage.removeItem(convKey(c.id)).catch(() => undefined)));
}

export function newConversation(): void {
  if (conversationStore.get().running) stop();
  conversationStore.set({ currentId: null, title: '新对话', items: [], history: [] });
}

export async function openConversation(id: string): Promise<void> {
  if (conversationStore.get().running) stop();
  const data = await loadJson<{ title: string; items: UiItem[]; history: ChatMessage[] } | null>(convKey(id), null);
  if (!data) return;
  conversationStore.set({ currentId: id, title: data.title, items: data.items, history: data.history });
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

/** 电脑工具适配：连接中断时调用会报错，由 Agent 告诉模型 */
const pcTools: AgentTools = {
  list: () => connectionStore.get().tools,
  async call(name, args) {
    const c = getClient();
    if (!c) throw new Error('电脑连接已断开，请检查数据线');
    return c.callTool(name, args);
  },
};

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

export async function send(text: string): Promise<void> {
  const t = text.trim();
  const s = conversationStore.get();
  if (!t || s.running) return;

  const model = await resolveActiveModel();
  if (model.problem) {
    mutateItems((items) => [...items, { kind: 'notice', id: uid('n'), text: `模型未配置好：${model.problem}。请到「设置 → 模型」填写。`, tone: 'error' }]);
    return;
  }

  const userMsg: ChatMessage = { role: 'user', content: t };
  const history = [...s.history, userMsg];
  conversationStore.set({
    currentId: s.currentId ?? uid('c'),
    title: s.items.length === 0 ? t.slice(0, 24) : s.title,
    items: [...s.items, { kind: 'user', id: uid('u'), text: t }],
    history,
    running: true,
    modelLabel: model.label,
  });

  abort = new AbortController();
  const conn = connectionStore.get();
  const connected = conn.status === 'connected' && !!getClient();
  const { added, error } = await runAgent(history, {
    llm: model.llm,
    fetch: expoFetch as unknown as FetchLike,
    supportsVision: model.supportsVision,
    supportsTools: model.supportsTools,
    tools: connected ? pcTools : null,
    computer: conn.params ? { host: conn.params.host, os: conn.params.os } : null,
    signal: abort.signal,
    onEvent: applyEvent,
    // TODO(M8)：接入手机端 OCR（Android ML Kit / iOS Vision），供不支持图片的模型使用
  });
  abort = null;

  conversationStore.set((st) => ({ history: [...st.history, ...added], running: false }));
  if (error) {
    const aborted = error.name === 'AbortError';
    mutateItems((items) => [
      ...items.map((it) =>
        it.kind === 'steps'
          ? { ...it, steps: it.steps.map((st) => (st.status === 'running' ? { ...st, status: 'error' as const, result: '已停止' } : st)) }
          : it,
      ),
      { kind: 'notice', id: uid('n'), text: aborted ? '已停止' : error.message, tone: aborted ? 'info' : 'error' },
    ]);
  }
  await save();
}

export function useConversation(): ConversationState {
  return useStore(conversationStore);
}
