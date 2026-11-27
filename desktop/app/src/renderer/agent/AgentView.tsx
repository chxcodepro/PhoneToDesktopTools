// 电脑端 AI 助手界面：左边对话列表（底部是扩展、定时任务、设置），右边聊天（回答、执行步骤、选择卡片），右上角模型设置。
import {
  AlertCircle,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Crop,
  Eye,
  EyeOff,
  Loader2,
  MessageSquarePlus,
  Minimize2,
  Paperclip,
  Pencil,
  Puzzle,
  RefreshCw,
  RotateCcw,
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
import { PROMPT_PRESETS } from '@agent/promptPresets';
import { Button, Spinner } from '@/components/ui';
import { cn } from '@/lib/utils';
import { ipcFetch } from './bridge';
import { composerBus, fileAttachments, imageAttachment, pushToComposer, takeFromComposerBus } from './composer';
import {
  answerChoice,
  compressNow,
  convStore,
  editLast,
  lastUserItem,
  newConversation,
  openConversation,
  regenerate,
  removeConversation,
  send,
  stop,
  type Attachment,
  type ChoiceItem,
  type Step,
  type UiAttachment,
  type UiItem,
} from './conversation';
import { Markdown } from './Markdown';
import { ExtensionsPanel, SchedulesPanel } from './Panels';
import {
  contextWindowOf,
  getApiKey,
  modelStore,
  setActivePreset,
  setApiKey,
  settingsStore,
  supportsThinkingToggle,
  thinkingOn,
  updatePreset,
  updateSettings,
  useStore,
  type ConfirmMode,
  type PresetSettings,
} from './model';

type Panel = 'settings' | 'extensions' | 'schedules' | null;

export function AgentView() {
  const [panel, setPanel] = useState<Panel>(null);
  const conv = useStore(convStore);
  const model = useStore(modelStore);
  const preset = model.presets[model.active];
  const configured = model.ready && model.hasKey[model.active] && !!preset.model.trim() && !!preset.baseUrl.trim();
  const [dragging, setDragging] = useState(false);

  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar onPanel={setPanel} />
      <main
        className="relative flex min-w-0 flex-1 flex-col"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void fileAttachments(e.dataTransfer.files).then((a) => a.length && pushToComposer({ attachments: a }));
        }}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{conv.title || '新对话'}</span>
          <ContextMeter />
          <button
            className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-accent"
            onClick={() => setPanel('settings')}
            title="模型设置"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span className="max-w-[220px] truncate">{modelLabel(model.active, preset)}</span>
          </button>
        </header>
        {conv.items.length ? (
          <Messages items={conv.items} running={conv.running} />
        ) : (
          <Welcome configured={configured} onSettings={() => setPanel('settings')} />
        )}
        <Composer />
        {dragging ? (
          <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5 text-primary">
            松开鼠标，把文件交给助手
          </div>
        ) : null}
      </main>
      {panel === 'settings' ? <ModelSettings onClose={() => setPanel(null)} /> : null}
      {panel === 'extensions' ? <ExtensionsPanel onClose={() => setPanel(null)} /> : null}
      {panel === 'schedules' ? <SchedulesPanel onClose={() => setPanel(null)} /> : null}
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

function Sidebar({ onPanel }: { onPanel: (p: Panel) => void }) {
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
      <div className="flex border-t border-border">
        {(
          [
            ['extensions', Puzzle, '扩展'],
            ['schedules', Clock, '定时任务'],
            ['settings', Settings2, '设置'],
          ] as const
        ).map(([p, Icon, label]) => (
          <button
            key={p}
            className="flex h-10 flex-1 items-center justify-center gap-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onPanel(p)}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>
    </aside>
  );
}

// ---------- 欢迎页 ----------

const SUGGESTIONS = ['看看这台电脑的配置和系统版本', 'C 盘还剩多少空间？哪些文件夹最大？', '查一下今天的科技新闻', '找到 7-Zip 的官网，下载最新版'];

function useHotkeys() {
  const [keys, setKeys] = useState<{ ask?: string; capture?: string; stop?: string }>({});
  useEffect(() => {
    void window.p2d.agentHotkeys().then(setKeys);
  }, []);
  return keys;
}

function Welcome({ configured, onSettings }: { configured: boolean; onSettings: () => void }) {
  const keys = useHotkeys();
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
      <div className="flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {keys.ask ? <span>{keys.ask} 随时唤起</span> : null}
        {keys.capture ? <span>{keys.capture} 框选屏幕提问</span> : null}
        <span>可以拖入文件、粘贴截图</span>
      </div>
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
  // 只有最后一轮能「编辑」「重新回答」
  const lastUser = lastUserItem(items);
  const editable = lastUser?.id;
  const lastAnswer = lastUser ? [...items].reverse().find((x) => x.kind === 'assistant' && x.text.trim())?.id : undefined;
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
          <Item key={it.id} it={it} canEdit={!running && it.id === editable} canRegenerate={!running && it.id === lastAnswer} />
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

function Attachments({ list, light }: { list: UiAttachment[]; light?: boolean }) {
  return (
    <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
      {list.map((a, i) =>
        a.kind === 'image' && a.thumb ? (
          <img key={i} src={a.thumb} title={a.path ?? a.name} className="h-16 max-w-[160px] rounded-md border border-white/30 object-cover" alt={a.name} />
        ) : (
          <span
            key={i}
            title={a.path}
            className={cn('flex items-center gap-1 rounded-md px-2 py-1 text-xs', light ? 'bg-white/20 text-white' : 'bg-muted text-foreground')}
          >
            <Paperclip className="h-3 w-3" />
            {a.name}
          </span>
        ),
      )}
    </div>
  );
}

function ActionButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} className="flex h-6 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClick}>
      {children}
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <ActionButton
      title="复制回答"
      onClick={() => {
        void window.p2d.agent.clipboardWrite(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? '已复制' : '复制'}
    </ActionButton>
  );
}

function Item({ it, canEdit, canRegenerate }: { it: UiItem; canEdit: boolean; canRegenerate: boolean }) {
  switch (it.kind) {
    case 'user':
      return (
        <div className="group flex flex-col items-end">
          <div className="max-w-[80%]">
            {it.attachments?.length ? <Attachments list={it.attachments} /> : null}
            {it.text ? (
              <div className="select-text whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[14px] text-white">{it.text}</div>
            ) : null}
          </div>
          {canEdit ? (
            <div className="invisible mt-0.5 group-hover:visible">
              <ActionButton
                title="编辑这条消息重新发送"
                onClick={() => {
                  const r = editLast();
                  if (r) pushToComposer(r);
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
                编辑
              </ActionButton>
            </div>
          ) : null}
        </div>
      );
    case 'assistant':
      return (
        <div className="group flex flex-col gap-1.5 text-[14px]">
          {it.reasoning ? <Reasoning text={it.reasoning} /> : null}
          {it.text ? <Markdown text={it.text} /> : null}
          {it.text ? (
            <div className={cn('-ml-1.5 flex gap-0.5', !canRegenerate && 'invisible group-hover:visible')}>
              <CopyButton text={it.text} />
              {canRegenerate ? (
                <ActionButton title="让助手重新回答这个问题" onClick={() => void regenerate()}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  重新回答
                </ActionButton>
              ) : null}
            </div>
          ) : null}
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
  const bus = useStore(composerBus);
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<Attachment[]>([]);
  // 热键唤起时，剪贴板里有新复制的文字就提示「引用」
  const [clip, setClip] = useState('');
  const lastClip = useRef('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  useEffect(() => ref.current?.focus(), [conv.currentId]);
  // 外面交过来的文字和附件（编辑上一条、框选截图、拖入文件、热键唤起）
  useEffect(() => {
    const p = takeFromComposerBus();
    if (p.text !== undefined) setText(p.text);
    if (p.attachments.length) setAtts((a) => [...a, ...p.attachments]);
    ref.current?.focus();
    if (bus.focusSeq > 0 && p.text === undefined && !p.attachments.length) {
      void window.p2d.agent.clipboardRead().then((c) => {
        const t = c.text.trim();
        if (t && t.length <= 4000 && t !== lastClip.current) setClip(t);
      });
    }
  }, [bus.focusSeq]);
  const submit = () => {
    if ((!text.trim() && !atts.length) || conv.running) return;
    void send(text, atts);
    setText('');
    setAtts([]);
    setClip('');
  };
  const addFiles = (files: FileList | null) => {
    if (files?.length) void fileAttachments(files).then((a) => setAtts((x) => [...x, ...a]));
  };
  return (
    <div className="shrink-0 px-6 pb-4 pt-1">
      <div className="mx-auto max-w-3xl">
        {conv.progress ? <div className="mb-1.5 text-xs text-muted-foreground">{conv.progress}</div> : null}
        {clip ? (
          <div className="mb-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs">
            <span className="shrink-0 text-muted-foreground">剪贴板：</span>
            <span className="min-w-0 flex-1 truncate">{clip}</span>
            <button
              className="shrink-0 text-primary hover:underline"
              onClick={() => {
                setText((t) => `${clip}\n\n${t}`);
                lastClip.current = clip;
                setClip('');
                ref.current?.focus();
              }}
            >
              引用
            </button>
            <button
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="不引用"
              onClick={() => {
                lastClip.current = clip;
                setClip('');
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        <div className="rounded-xl border border-border bg-background p-2 shadow-sm focus-within:border-primary">
          {atts.length ? (
            <div className="mb-1.5 flex flex-wrap gap-1.5 px-1">
              {atts.map((a, i) => (
                <div key={i} className="group relative" title={a.path ?? a.name}>
                  {a.kind === 'image' && a.thumb ? (
                    <img src={a.thumb} className="h-14 max-w-[120px] rounded-md border border-border object-cover" alt={a.name} />
                  ) : (
                    <span className="flex h-7 items-center gap-1 rounded-md bg-muted px-2 text-xs">
                      <Paperclip className="h-3 w-3" />
                      {a.name}
                    </span>
                  )}
                  <button
                    className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-foreground text-background group-hover:flex"
                    aria-label="移除"
                    onClick={() => setAtts((x) => x.filter((_, k) => k !== i))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-1">
            <button className="flex h-9 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" title="添加文件或图片" onClick={() => picker.current?.click()}>
              <Paperclip className="h-4 w-4" />
            </button>
            <button className="flex h-9 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" title="框选屏幕提问" onClick={() => window.p2d.captureRegion()}>
              <Crop className="h-4 w-4" />
            </button>
            <input ref={picker} type="file" multiple className="hidden" onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
            <textarea
              ref={ref}
              rows={1}
              className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] leading-6 outline-none"
              placeholder="让助手查点什么，或者在这台电脑上做点什么…（Enter 发送，Shift+Enter 换行，可以粘贴截图）"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                const items = Array.from(e.clipboardData.items).filter((x) => x.kind === 'file');
                if (!items.length) return;
                e.preventDefault();
                for (const it of items) {
                  const f = it.getAsFile();
                  if (!f) continue;
                  if (f.type.startsWith('image/')) {
                    const r = new FileReader();
                    r.onload = () =>
                      void imageAttachment(String(r.result), (f.name || '截图.png').replace(/^image\.png$/, '粘贴的图片.png')).then((a) => setAtts((x) => [...x, a]));
                    r.readAsDataURL(f);
                  } else addFiles(e.clipboardData.files);
                }
              }}
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
              <Button size="sm" className="h-9 w-9 shrink-0 p-0" title="发送" disabled={!text.trim() && !atts.length} onClick={submit}>
                <SendHorizontal className="h-4 w-4" />
              </Button>
            )}
          </div>
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
                <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                  本机模型：
                  {LOCAL_MODELS.map((m) => (
                    <button
                      key={m.name}
                      className="rounded border border-border px-2 py-0.5 text-foreground hover:bg-accent"
                      title={`${m.baseUrl}（本机模型不校验 Key，自动填一个）`}
                      onClick={() => {
                        patch({ name: m.name, baseUrl: m.baseUrl, supportsVision: false, models: [] });
                        if (!key.trim()) setKey(m.key);
                      }}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
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
            <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
              填入预设：
              {PROMPT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className="rounded border border-border px-2 py-0.5 text-foreground hover:bg-accent"
                  title={p.summary}
                  onClick={() => {
                    if (draft.systemPrompt?.trim() && !confirm('替换现在填写的要求？')) return;
                    patch({ systemPrompt: p.text });
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </Field>
          <OtherSettings />
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

/** 本机运行的模型（OpenAI 兼容接口，不校验 Key） */
const LOCAL_MODELS = [
  { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', key: 'ollama' },
  { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', key: 'lm-studio' },
];

const CONFIRM_MODES: { id: ConfirmMode; label: string; hint: string }[] = [
  { id: 'risky', label: '高风险操作', hint: '管理员命令、删除、格式化、改注册表 / 服务等先问一下' },
  { id: 'all', label: '执行命令和改文件都问', hint: '每条命令、写文件、删除、下载前都要你点允许' },
  { id: 'off', label: '不确认', hint: '助手自己决定（不建议）' },
];

/** 操作确认和快捷键（改了马上生效，不用点「保存并使用」） */
function OtherSettings() {
  const st = useStore(settingsStore);
  const keys = useHotkeys();
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <Field label="操作前确认" hint="改了马上生效">
        <div className="space-y-1">
          {CONFIRM_MODES.map((m) => (
            <label key={m.id} className="flex cursor-pointer items-baseline gap-2">
              <input type="radio" className="accent-primary" checked={st.confirm === m.id} onChange={() => void updateSettings({ confirm: m.id })} />
              <span>{m.label}</span>
              <span className="text-[11px] text-muted-foreground">{m.hint}</span>
            </label>
          ))}
        </div>
      </Field>
      <Field label="快捷键" hint="被别的程序占用时会换成备用的组合">
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-muted-foreground">
          <span>随时唤起助手</span>
          <span className="font-mono text-foreground">{keys.ask ?? '（没注册上）'}</span>
          <span>框选屏幕提问</span>
          <span className="font-mono text-foreground">{keys.capture ?? '（没注册上）'}</span>
          <span>停止助手（运行时）</span>
          <span className="font-mono text-foreground">{keys.stop ?? '—'}</span>
        </div>
      </Field>
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
