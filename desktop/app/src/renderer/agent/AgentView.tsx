// 电脑端 AI 助手界面：左边对话列表，右边聊天（回答、执行步骤、选择卡片），右上角模型设置。
import {
  AlertCircle,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  MessageSquarePlus,
  Minimize2,
  RefreshCw,
  SendHorizontal,
  Settings2,
  Square,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatWindow } from '@agent/contextWindow';
import { listModels } from '@agent/llm';
import { filterModels } from '@agent/modelList';
import { MODEL_PRESETS, type PresetId } from '@agent/presets';
import { Button, Spinner } from '@/components/ui';
import { cn } from '@/lib/utils';
import { ipcFetch } from './bridge';
import {
  answerChoice,
  compressNow,
  convStore,
  initConversations,
  newConversation,
  openConversation,
  removeConversation,
  send,
  stop,
  type ChoiceItem,
  type Step,
  type UiItem,
} from './conversation';
import { Markdown } from './Markdown';
import {
  contextWindowOf,
  getApiKey,
  initModel,
  modelStore,
  setActivePreset,
  setApiKey,
  supportsThinkingToggle,
  thinkingOn,
  updatePreset,
  useStore,
  type PresetSettings,
} from './model';

export function AgentView() {
  const [settings, setSettings] = useState(false);
  const conv = useStore(convStore);
  const model = useStore(modelStore);
  useEffect(() => {
    void initModel();
    void initConversations();
  }, []);
  const preset = model.presets[model.active];
  const configured = model.ready && model.hasKey[model.active] && !!preset.model.trim() && !!preset.baseUrl.trim();

  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar onSettings={() => setSettings(true)} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{conv.title || '新对话'}</span>
          <ContextMeter />
          <button
            className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-accent"
            onClick={() => setSettings(true)}
            title="模型设置"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span className="max-w-[220px] truncate">{modelLabel(model.active, preset)}</span>
          </button>
        </header>
        {conv.items.length ? <Messages items={conv.items} running={conv.running} /> : <Welcome configured={configured} onSettings={() => setSettings(true)} />}
        <Composer />
      </main>
      {settings ? <ModelSettings onClose={() => setSettings(false)} /> : null}
    </div>
  );
}

function modelLabel(id: PresetId, s: PresetSettings): string {
  const name = id === 'custom' ? s.name || '自定义' : MODEL_PRESETS.find((p) => p.id === id)?.label;
  return s.model ? `${name} · ${s.model}` : `${name} · 未选择模型`;
}

// ---------- 左边：对话列表 ----------

function relTime(t: number): string {
  const d = Date.now() - t;
  if (d < 60_000) return '刚刚';
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  const a = new Date(t);
  const now = new Date();
  if (a.toDateString() === now.toDateString()) return `${a.getHours()}:${String(a.getMinutes()).padStart(2, '0')}`;
  return `${a.getMonth() + 1}月${a.getDate()}日`;
}

function Sidebar({ onSettings }: { onSettings: () => void }) {
  const conv = useStore(convStore);
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-muted/40">
      <div className="p-3">
        <Button className="w-full" variant="outline" size="sm" disabled={conv.running} onClick={newConversation}>
          <MessageSquarePlus className="h-4 w-4" />
          新对话
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {conv.list.length === 0 ? <p className="px-2 py-6 text-center text-xs text-muted-foreground">还没有对话</p> : null}
        {conv.list.map((m) => (
          <div
            key={m.id}
            className={cn(
              'group mb-0.5 flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-2 hover:bg-accent',
              m.id === conv.currentId && 'bg-accent',
              conv.running && m.id !== conv.currentId && 'cursor-not-allowed opacity-60',
            )}
            onClick={() => void openConversation(m.id)}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">{m.title}</div>
              <div className="text-[11px] text-muted-foreground">{relTime(m.updatedAt)}</div>
            </div>
            <button
              className="hidden h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-destructive group-hover:flex"
              title="删除对话"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`删除对话「${m.title}」？`)) void removeConversation(m.id);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <button className="flex h-10 items-center gap-2 border-t border-border px-4 text-xs text-muted-foreground hover:text-foreground" onClick={onSettings}>
        <Settings2 className="h-3.5 w-3.5" />
        模型设置
      </button>
    </aside>
  );
}

// ---------- 欢迎页 ----------

const SUGGESTIONS = ['看看这台电脑的配置和系统版本', 'C 盘还剩多少空间？哪些文件夹最大？', '查一下今天的科技新闻', '找到 7-Zip 的官网，下载最新版'];

function Welcome({ configured, onSettings }: { configured: boolean; onSettings: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto p-8">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Bot className="h-7 w-7" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold">电脑上的 AI 助手</h2>
        <p className="mt-1.5 max-w-md text-[13px] text-muted-foreground">
          能联网查资料、读网页、下载文件，也能直接操作这台电脑：执行命令、读写文件、看屏幕、点界面。
        </p>
      </div>
      {configured ? (
        <div className="grid w-full max-w-lg grid-cols-2 gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              className="rounded-lg border border-border px-3 py-2.5 text-left text-[13px] hover:bg-accent"
              onClick={() => void send(s)}
            >
              {s}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <p className="text-[13px] text-warning-foreground">先填写模型的 API Key 并选择模型</p>
          <Button size="sm" onClick={onSettings}>
            <Settings2 className="h-4 w-4" />
            模型设置
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------- 消息 ----------

function Messages({ items, running }: { items: UiItem[]; running: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // 停在底部时跟着新内容滚动；用户往上翻看时不打扰
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  const last = items[items.length - 1];
  const waiting = running && (!last || last.kind === 'user' || (last.kind === 'steps' && last.steps.every((s) => s.status !== 'running')));
  return (
    <div
      ref={ref}
      className="min-h-0 flex-1 overflow-y-auto"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-5">
        {items.map((it) => (
          <Item key={it.id} it={it} />
        ))}
        {waiting ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="h-3.5 w-3.5" />
            思考中…
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Item({ it }: { it: UiItem }) {
  switch (it.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] select-text whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[14px] text-white">
            {it.text}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className="flex flex-col gap-1.5 text-[14px]">
          {it.reasoning ? <Reasoning text={it.reasoning} /> : null}
          {it.text ? <Markdown text={it.text} /> : null}
        </div>
      );
    case 'steps':
      return <Steps steps={it.steps} image={it.image} />;
    case 'notice':
      return (
        <div className={cn('flex items-start justify-center gap-1.5 text-center text-xs', it.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
          {it.tone === 'error' ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : null}
          <span className="select-text">{it.text}</span>
        </div>
      );
    case 'choice':
      return <Choice it={it} />;
  }
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-muted-foreground">
      <button className="flex items-center gap-1 hover:text-foreground" onClick={() => setOpen((v) => !v)}>
        <Brain className="h-3.5 w-3.5" />
        思考过程
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {open ? <div className="mt-1.5 select-text whitespace-pre-wrap border-l-2 border-border pl-3 leading-relaxed">{text}</div> : null}
    </div>
  );
}

const TOOL_LABEL: Record<string, string> = {
  sys_info: '系统信息',
  shell_exec: '执行命令',
  fs_list: '列目录',
  fs_read: '读文件',
  fs_write: '写文件',
  fs_edit: '改文件',
  fs_search: '搜索文件',
  fs_delete: '删除',
  doc_read: '读文档',
  screen_capture: '截图',
  input_mouse: '鼠标',
  input_keyboard: '键盘',
  ui_tree: '读取界面',
  window_activate: '切换窗口',
  ui_act: '操作控件',
  web_search: '搜索',
  web_fetch: '读网页',
  driver_search: '查驱动',
  download_to_pc: '下载',
  ask_user: '询问',
};

/** 命令、路径、网址用等宽字体显示 */
const MONO = new Set(['shell_exec', 'fs_list', 'fs_read', 'fs_write', 'fs_edit', 'fs_delete', 'doc_read', 'web_fetch', 'download_to_pc']);

function Steps({ steps: all, image }: { steps: Step[]; image?: { data: string; mimeType: string } }) {
  const [open, setOpen] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  // ask_user 已经显示成下面的选择卡片
  const steps = all.filter((s) => s.name !== 'ask_user');
  if (!steps.length && !image) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-[13px]">
      {steps.map((s) => (
        <div key={s.id} className="py-0.5">
          <button className="flex w-full min-w-0 items-center gap-2 text-left" onClick={() => setOpen(open === s.id ? null : s.id)}>
            {s.status === 'running' ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
            ) : s.status === 'ok' ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-success" />
            ) : (
              <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
            )}
            <span className="shrink-0 font-medium">{TOOL_LABEL[s.name] ?? s.name}</span>
            <span className={cn('min-w-0 flex-1 truncate text-xs text-muted-foreground', MONO.has(s.name) && 'font-mono')}>
              {s.summary === (TOOL_LABEL[s.name] ?? s.name) ? '' : s.summary}
            </span>
          </button>
          {open === s.id && s.result ? (
            <div className={cn('mt-1 select-text whitespace-pre-wrap break-all pl-[22px] text-xs', s.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
              {s.result}
            </div>
          ) : null}
        </div>
      ))}
      {image ? (
        <>
          <img
            src={`data:${image.mimeType};base64,${image.data}`}
            className="mt-2 max-h-40 cursor-zoom-in rounded border border-border"
            onClick={() => setZoom(true)}
            alt="截图"
          />
          {zoom ? (
            <div className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-6" onClick={() => setZoom(false)}>
              <img src={`data:${image.mimeType};base64,${image.data}`} className="max-h-full max-w-full rounded shadow-lg" alt="截图" />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Choice({ it }: { it: ChoiceItem }) {
  const [sel, setSel] = useState<string[]>([]);
  const [custom, setCustom] = useState('');
  const pending = it.status === 'pending';
  const submit = (selected: string[]) => answerChoice(it.id, { selected, custom: custom.trim() || undefined });
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3.5">
      <div className="mb-2.5 select-text text-[14px] font-medium">{it.question}</div>
      <div className="flex flex-col gap-1.5">
        {it.options.map((o) => {
          const chosen = it.answer?.selected.includes(o.label) || sel.includes(o.label);
          return (
            <button
              key={o.label}
              disabled={!pending}
              className={cn(
                'rounded-md border px-3 py-2 text-left text-[13px]',
                chosen ? 'border-primary bg-primary/10' : 'border-border bg-background',
                pending ? 'hover:border-primary' : 'cursor-default opacity-80',
              )}
              onClick={() => {
                if (!it.multiple) submit([o.label]);
                else setSel((v) => (v.includes(o.label) ? v.filter((x) => x !== o.label) : [...v, o.label]));
              }}
            >
              <div className="font-medium">{o.label}</div>
              {o.description ? <div className="mt-0.5 text-xs text-muted-foreground">{o.description}</div> : null}
            </button>
          );
        })}
      </div>
      {pending && (it.allowCustom || it.multiple) ? (
        <div className="mt-2 flex gap-2">
          {it.allowCustom ? (
            <input
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus:border-primary"
              placeholder="其他（自己填写）"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (custom.trim() || sel.length)) submit(sel);
              }}
            />
          ) : (
            <span className="flex-1" />
          )}
          <Button size="sm" disabled={!sel.length && !custom.trim()} onClick={() => submit(sel)}>
            确定
          </Button>
        </div>
      ) : null}
      {it.status === 'answered' && it.answer?.custom ? <div className="mt-2 text-xs text-muted-foreground">填写了：{it.answer.custom}</div> : null}
      {it.status === 'cancelled' ? <div className="mt-2 text-xs text-muted-foreground">已取消</div> : null}
    </div>
  );
}

// ---------- 输入框 ----------

function ContextMeter() {
  const conv = useStore(convStore);
  const st = conv.stats;
  if (!st) return null;
  const pct = Math.min(100, Math.round((st.contextTokens / st.contextWindow) * 100));
  return (
    <button
      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
      title={`上下文 ${st.contextTokens.toLocaleString()} / ${formatWindow(st.contextWindow)} token${st.tokensPerSec ? `，${st.tokensPerSec.toFixed(0)} token/秒` : ''}\n点击压缩较早的对话`}
      disabled={conv.running}
      onClick={() => void compressNow()}
    >
      <Minimize2 className="h-3.5 w-3.5" />
      上下文 {pct}%
    </button>
  );
}

function Composer() {
  const conv = useStore(convStore);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  useEffect(() => ref.current?.focus(), [conv.currentId]);
  const submit = () => {
    if (!text.trim() || conv.running) return;
    void send(text);
    setText('');
  };
  return (
    <div className="shrink-0 px-6 pb-4 pt-1">
      <div className="mx-auto max-w-3xl">
        {conv.progress ? <div className="mb-1.5 text-xs text-muted-foreground">{conv.progress}</div> : null}
        <div className="flex items-end gap-2 rounded-xl border border-border bg-background p-2 shadow-sm focus-within:border-primary">
          <textarea
            ref={ref}
            rows={1}
            className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] leading-6 outline-none"
            placeholder="让助手查点什么，或者在这台电脑上做点什么…（Enter 发送，Shift+Enter 换行）"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {conv.running ? (
            <Button size="sm" variant="outline" className="h-9 w-9 shrink-0 p-0" title="停止" onClick={stop}>
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          ) : (
            <Button size="sm" className="h-9 w-9 shrink-0 p-0" title="发送" disabled={!text.trim()} onClick={submit}>
              <SendHorizontal className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- 模型设置 ----------

function ModelSettings({ onClose }: { onClose: () => void }) {
  const model = useStore(modelStore);
  const [active, setActive] = useState<PresetId>(model.active);
  // 三个预设各自的草稿和 Key：切换预设不丢已经填的内容，点「保存并使用」时一起保存
  const [drafts, setDrafts] = useState<Record<PresetId, PresetSettings>>(model.presets);
  const [keys, setKeys] = useState<Record<PresetId, string>>({ openai: '', deepseek: '', custom: '' });
  const [savedKeys, setSavedKeys] = useState<Record<PresetId, string>>({ openai: '', deepseek: '', custom: '' });
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const draft = drafts[active];
  const key = keys[active];

  useEffect(() => {
    void Promise.all(MODEL_PRESETS.map(async (p) => [p.id, await getApiKey(p.id)] as const)).then((list) => {
      const k = Object.fromEntries(list) as Record<PresetId, string>;
      setKeys(k);
      setSavedKeys(k);
    });
  }, []);

  useEffect(() => {
    setError('');
    setQuery('');
  }, [active]);

  const patch = (p: Partial<PresetSettings>) => setDrafts((d) => ({ ...d, [active]: { ...d[active], ...p } }));
  const setKey = (v: string) => setKeys((k) => ({ ...k, [active]: v }));

  const dirty =
    active !== model.active ||
    MODEL_PRESETS.some((p) => JSON.stringify(drafts[p.id]) !== JSON.stringify(model.presets[p.id]) || keys[p.id].trim() !== savedKeys[p.id].trim());

  /** 关闭：有没保存的修改时先问一下（点弹窗外面不关闭，免得误点丢掉填好的 Key） */
  const close = () => {
    if (dirty && !confirm('填写的内容还没保存，关闭后会丢掉。确定关闭吗？\n要保存请点「保存并使用」。')) return;
    onClose();
  };

  const fetchModels = async () => {
    setLoading(true);
    setError('');
    try {
      const list = await listModels({ baseUrl: draft.baseUrl.trim(), apiKey: key.trim() }, ipcFetch);
      patch({ models: list, model: draft.model || list[0] || '' });
      if (!list.length) setError('接口没有返回模型，可以直接填写模型名');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const saveAll = async () => {
    for (const p of MODEL_PRESETS) {
      const d = drafts[p.id];
      if (JSON.stringify(d) !== JSON.stringify(model.presets[p.id])) {
        await updatePreset(p.id, { ...d, baseUrl: d.baseUrl.trim(), model: d.model.trim() });
      }
      if (keys[p.id].trim() !== savedKeys[p.id].trim()) await setApiKey(p.id, keys[p.id]);
    }
    await setActivePreset(active);
    onClose();
  };

  const { items, hidden } = filterModels(draft.models, query, { hideNonChat: true, selected: draft.model });
  const field = 'h-8 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus:border-primary';

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-6">
      <div className="flex max-h-full w-[520px] flex-col rounded-xl border border-border bg-background shadow-xl">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-5">
          <span className="font-semibold">模型设置</span>
          <button className="text-muted-foreground hover:text-foreground" onClick={close} aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-[13px]">
          <div className="flex rounded-lg bg-muted p-1">
            {MODEL_PRESETS.map((p) => (
              <button
                key={p.id}
                className={cn('h-7 flex-1 rounded-md text-[13px]', active === p.id ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}
                onClick={() => setActive(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
          {active === 'custom' ? (
            <>
              <Field label="名称">
                <input className={field} value={draft.name} placeholder="如：通义千问" onChange={(e) => patch({ name: e.target.value })} />
              </Field>
              <Field label="接口地址" hint="兼容 OpenAI 协议的地址，一般以 /v1 结尾">
                <input className={field} value={draft.baseUrl} placeholder="https://<接口地址>/v1" onChange={(e) => patch({ baseUrl: e.target.value })} />
              </Field>
            </>
          ) : (
            <Field label="接口地址">
              <div className="text-muted-foreground">{draft.baseUrl}</div>
            </Field>
          )}
          <Field label="API Key" hint="保存在这台电脑上，用系统的加密存储">
            <div className="flex gap-2">
              <input
                className={cn(field, 'font-mono')}
                type={showKey ? 'text' : 'password'}
                value={key}
                placeholder="<YOUR_API_KEY>"
                onChange={(e) => setKey(e.target.value)}
              />
              <button className="flex w-8 shrink-0 items-center justify-center rounded-md border border-border hover:bg-accent" onClick={() => setShowKey((v) => !v)}>
                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </Field>
          <Field label="模型">
            <div className="flex gap-2">
              <input className={field} value={draft.model} placeholder="选择或填写模型名" onChange={(e) => patch({ model: e.target.value })} />
              <Button size="sm" variant="outline" className="shrink-0" disabled={loading || !key.trim() || !draft.baseUrl.trim()} onClick={() => void fetchModels()}>
                {loading ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
                获取列表
              </Button>
            </div>
            {draft.models.length ? (
              <div className="mt-2 rounded-md border border-border">
                {draft.models.length > 8 ? (
                  <input className="h-8 w-full border-b border-border bg-transparent px-2.5 outline-none" placeholder="搜索模型" value={query} onChange={(e) => setQuery(e.target.value)} />
                ) : null}
                <div className="max-h-40 overflow-y-auto p-1">
                  {items.map((m) => (
                    <button
                      key={m}
                      className={cn('flex w-full items-center justify-between rounded px-2 py-1 text-left font-mono text-xs hover:bg-accent', m === draft.model && 'bg-accent')}
                      onClick={() => patch({ model: m })}
                    >
                      {m}
                      {m === draft.model ? <Check className="h-3 w-3 text-primary" /> : null}
                    </button>
                  ))}
                  {hidden ? <div className="px-2 py-1 text-[11px] text-muted-foreground">已隐藏 {hidden} 个不能用来对话的模型</div> : null}
                </div>
              </div>
            ) : null}
            {error ? <div className="mt-1.5 text-xs text-destructive">{error}</div> : null}
          </Field>
          <div className="space-y-2">
            <Toggle label="支持图片" hint="能看截图；不支持时改用命令和控件树操作" on={draft.supportsVision} onChange={(v) => patch({ supportsVision: v })} />
            <Toggle label="支持工具调用" hint="关掉后只能聊天，不能操作电脑、联网" on={draft.supportsTools} onChange={(v) => patch({ supportsTools: v })} />
            {supportsThinkingToggle(active) ? (
              <Toggle label="深度思考" hint="回答更仔细，但更慢" on={thinkingOn(draft)} onChange={(v) => patch({ thinking: v })} />
            ) : null}
          </div>
          <Field label="上下文长度（可不填）" hint={`不填按模型默认（${formatWindow(contextWindowOf({ model: draft.model }))}），快用满时自动压缩较早的对话`}>
            <input
              className={field}
              type="number"
              min={4000}
              value={draft.contextWindow ?? ''}
              placeholder={String(contextWindowOf({ model: draft.model }))}
              onChange={(e) => patch({ contextWindow: e.target.value ? Number(e.target.value) : undefined })}
            />
          </Field>
          <Field label="额外要求（可不填）" hint="加在内置提示词之后，例如回答风格、常用目录">
            <textarea className={cn(field, 'h-20 resize-none py-1.5')} value={draft.systemPrompt ?? ''} onChange={(e) => patch({ systemPrompt: e.target.value })} />
          </Field>
        </div>
        <div className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-border px-5">
          <Button size="sm" variant="outline" onClick={close}>
            取消
          </Button>
          <Button size="sm" onClick={() => void saveAll()}>
            保存并使用
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="font-medium">{label}</span>
        {hint ? <span className="text-right text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Toggle({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span>
        <span className="font-medium">{label}</span>
        <span className="ml-2 text-[11px] text-muted-foreground">{hint}</span>
      </span>
      <input type="checkbox" className="h-4 w-4 accent-primary" checked={on} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
