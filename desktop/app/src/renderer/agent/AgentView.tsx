// 电脑端 AI 助手界面：左边对话列表（新对话、定时任务、扩展、设置），右边聊天（回答、执行过的操作、选择卡片）和输入框（模型选择在输入框里）。
import {
  AlertCircle,
  CheckCircle2,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Clock,
  Copy,
  Crop,
  Download,
  Eye,
  EyeOff,
  FileText,
  HardDrive,
  ListChecks,
  Loader2,
  Monitor,
  Newspaper,
  PanelLeft,
  Pencil,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  SquarePen,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatWindow } from '@agent/contextWindow';
import { listModelsDetailed } from '@agent/llm';
import { filterModels } from '@agent/modelList';
import { MODEL_PRESETS, type PresetId } from '@agent/presets';
import { defaultPrompt, MAX_PROMPT } from '@agent/promptPresets';
import { reasoningOptions, type ReasoningLevel } from '@agent/reasoning';
import { Button, Spinner } from '@/components/ui';
import { APPEARANCES, setAppearance, useAppearance } from '@/lib/appearance';
import { cn } from '@/lib/utils';
import { ipcFetch } from './bridge';
import { composerBus, fileAttachments, imageAttachment, pushToComposer, takeFromComposerBus } from './composer';
import {
  AUTO_COMPRESS_RATIO,
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
  keyStorageHint,
  reasoningOf,
  setReasoning,
  useKeyEncrypted,
  updatePreset,
  updateSettings,
  useStore,
  type ConfirmMode,
  type PresetSettings,
} from './model';
import type { HotkeyConfig, HotkeyId, HotkeySettings, HotkeyStatus } from '../../shared/types';

type Panel = 'settings' | 'extensions' | 'schedules' | null;

// 布局参考 Claude 桌面版和 Codex：左边是可收起的对话列表；对话居中、最宽 46rem；
// 用户消息是浅灰气泡、助手回答不加气泡；执行过的操作折叠成一行；输入框是一张卡片，模型选择放在输入框里；
// 新对话时标题和输入框放在页面中间。

export function AgentView() {
  const [panel, setPanel] = useState<Panel>(null);
  const [sidebar, setSidebar] = useState(true);
  const conv = useStore(convStore);
  const [dragging, setDragging] = useState(false);
  const empty = conv.items.length === 0;

  return (
    <div className="flex min-h-0 flex-1 bg-background">
      {sidebar ? <Sidebar onPanel={setPanel} /> : null}
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
        <header className="flex h-11 shrink-0 items-center gap-1 px-2.5">
          <IconButton title={sidebar ? '收起侧栏' : '展开侧栏'} onClick={() => setSidebar((v) => !v)}>
            <PanelLeft className="h-4 w-4" />
          </IconButton>
          {!sidebar ? (
            <IconButton title="新对话" onClick={newConversation} disabled={conv.running}>
              <SquarePen className="h-4 w-4" />
            </IconButton>
          ) : null}
          <span className="ml-1 min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{empty ? '' : conv.title}</span>
        </header>
        {empty ? <Welcome onSettings={() => setPanel('settings')} /> : <Messages items={conv.items} running={conv.running} />}
        {/* 输入框始终在底部，新对话和对话中位置一样，切换时不跳 */}
        <div className="shrink-0 px-6 pb-3">
          <div className="mx-auto max-w-[46rem]">
            <Composer onSettings={() => setPanel('settings')} />
          </div>
        </div>
        {dragging ? (
          <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/5 text-sm text-primary">
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

function IconButton({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      disabled={disabled}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function modelLabel(id: PresetId, s: PresetSettings): string {
  const name = id === 'custom' ? s.name || '自定义' : MODEL_PRESETS.find((p) => p.id === id)?.label;
  return s.model ? `${name} · ${s.model}` : `${name} · 未选择模型`;
}

// ---------- 左边：对话列表 ----------

function SideRow({ icon: Icon, label, onClick, disabled }: { icon: typeof Clock; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-foreground/80 hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"
      onClick={onClick}
      disabled={disabled}
    >
      <Icon className="h-4 w-4 text-muted-foreground" />
      {label}
    </button>
  );
}

function Sidebar({ onPanel }: { onPanel: (p: Panel) => void }) {
  const conv = useStore(convStore);
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border/70 bg-subtle">
      <div className="space-y-0.5 px-2 pt-2">
        <SideRow icon={SquarePen} label="新对话" onClick={newConversation} disabled={conv.running} />
        <SideRow icon={Clock} label="定时任务" onClick={() => onPanel('schedules')} />
        <SideRow icon={Puzzle} label="扩展" onClick={() => onPanel('extensions')} />
      </div>
      <div className="mt-4 px-[18px] pb-1 text-[11px] font-medium text-muted-foreground">最近</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {conv.list.length === 0 ? <p className="px-2.5 py-2 text-xs text-muted-foreground">还没有对话</p> : null}
        {conv.list.map((m) => (
          <div
            key={m.id}
            title={m.title}
            className={cn(
              'group flex h-8 cursor-pointer items-center gap-1 rounded-lg pl-2.5 pr-1 hover:bg-foreground/5',
              m.id === conv.currentId && 'bg-foreground/[0.07]',
              conv.running && m.id !== conv.currentId && 'cursor-not-allowed opacity-50',
            )}
            onClick={() => void openConversation(m.id)}
          >
            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">{m.title}</span>
            <button
              className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-destructive group-hover:flex"
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
      <div className="border-t border-border/70 p-2">
        <SideRow icon={Settings2} label="设置" onClick={() => onPanel('settings')} />
      </div>
    </aside>
  );
}

// ---------- 新对话 ----------

const SUGGESTIONS = [
  { icon: Monitor, text: '看看这台电脑的配置' },
  // Linux、Mac 没有 C 盘
  { icon: HardDrive, text: navigator.platform.toLowerCase().startsWith('win') ? 'C 盘还剩多少空间' : '磁盘还剩多少空间' },
  { icon: Newspaper, text: '查一下今天的科技新闻' },
  { icon: Download, text: '找到 7-Zip 官网，下载最新版' },
];

function useHotkeys(): [HotkeyStatus | null, (s: HotkeyStatus) => void] {
  const [keys, setKeys] = useState<HotkeyStatus | null>(null);
  useEffect(() => {
    void window.p2d.agentHotkeys().then(setKeys);
  }, []);
  return [keys, setKeys];
}

/** 新对话页：上面是问候、试试这些和能做什么，输入框在页面底部（和对话中一样） */
function Welcome({ onSettings }: { onSettings: () => void }) {
  const model = useStore(modelStore);
  const preset = model.presets[model.active];
  const configured = model.ready && model.hasKey[model.active] && !!preset.model.trim() && !!preset.baseUrl.trim();
  const [keys] = useHotkeys();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6">
      <div className="mx-auto w-full max-w-[46rem] pb-6 pt-[9vh]">
        <h1 className="flex items-center gap-2.5 text-[24px] font-semibold tracking-tight text-foreground/90">
          <Sparkles className="h-6 w-6 text-primary" />
          有什么可以帮你？
        </h1>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          能联网查资料、下载文件，也能执行命令、读写文件、看屏幕、点界面。可以拖入文件、粘贴截图
          {keys?.ask.ok ? `，${keys.ask.label} 随时唤起` : ''}
          {keys?.capture.ok ? `，${keys.capture.label} 框选屏幕提问` : ''}。
        </p>
        {model.ready && !configured ? (
          <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-[13px] text-warning-foreground">
            先填写模型的 API Key 并选择模型，才能开始对话
            <Button size="sm" variant="outline" onClick={onSettings}>
              模型设置
            </Button>
          </div>
        ) : null}
        <div className="mt-6 rounded-2xl border border-border bg-subtle p-3">
          <div className="px-1 pb-2 text-xs text-muted-foreground">试试这些</div>
          <div className="grid grid-cols-2 gap-2">
            {SUGGESTIONS.map(({ icon: Icon, text }) => (
              <button
                key={text}
                disabled={!configured}
                className="flex items-center gap-2.5 rounded-xl border border-border bg-background px-3.5 py-3 text-left text-[13px] text-foreground/80 hover:border-foreground/20 hover:text-foreground disabled:opacity-50"
                onClick={() => void send(text)}
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{text}</span>
              </button>
            ))}
          </div>
        </div>
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
      <div className="mx-auto flex max-w-[46rem] flex-col gap-5 px-6 pb-6 pt-2">
        {items.map((it) => (
          <Item key={it.id} it={it} canEdit={!running && it.id === editable} canRegenerate={!running && it.id === lastAnswer} />
        ))}
        {waiting ? (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
            思考中…
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Attachments({ list }: { list: UiAttachment[] }) {
  return (
    <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
      {list.map((a, i) =>
        a.kind === 'image' && a.thumb ? (
          <img key={i} src={a.thumb} title={a.path ?? a.name} className="h-20 max-w-[200px] rounded-xl border border-border object-cover" alt={a.name} />
        ) : (
          <span key={i} title={a.path} className="flex items-center gap-1.5 rounded-xl border border-border bg-background px-2.5 py-1.5 text-xs">
            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
            {a.name}
          </span>
        ),
      )}
    </div>
  );
}

function ActionButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <ActionButton
      title={done ? '已复制' : '复制'}
      onClick={() => {
        void window.p2d.agent.clipboardWrite(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    </ActionButton>
  );
}

function Item({ it, canEdit, canRegenerate }: { it: UiItem; canEdit: boolean; canRegenerate: boolean }) {
  switch (it.kind) {
    case 'user':
      return (
        <div className="group flex flex-col items-end">
          <div className="flex max-w-[78%] flex-col items-end">
            {it.attachments?.length ? <Attachments list={it.attachments} /> : null}
            {it.text ? (
              <div className="select-text whitespace-pre-wrap break-words rounded-2xl bg-bubble px-4 py-2.5 text-[14.5px] leading-relaxed text-foreground">
                {it.text}
              </div>
            ) : null}
          </div>
          {canEdit ? (
            <div className="invisible mt-0.5 group-hover:visible">
              <ActionButton
                title="编辑后重新发送"
                onClick={() => {
                  const r = editLast();
                  if (r) pushToComposer(r);
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </ActionButton>
            </div>
          ) : null}
        </div>
      );
    case 'assistant':
      return (
        <div className="group flex flex-col gap-2 text-[14.5px]">
          {it.reasoning ? <Reasoning text={it.reasoning} /> : null}
          {it.text ? <Markdown text={it.text} /> : null}
          {it.text ? (
            <div className={cn('-ml-1.5 flex', !canRegenerate && 'invisible group-hover:visible')}>
              <CopyButton text={it.text} />
              {canRegenerate ? (
                <ActionButton title="重新回答" onClick={() => void regenerate()}>
                  <RotateCcw className="h-3.5 w-3.5" />
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
        <div
          className={cn(
            'flex items-start justify-center gap-1.5 text-center text-xs',
            it.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {it.tone === 'error' ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : null}
          <span className="select-text">{it.text}</span>
        </div>
      );
    case 'choice':
      return <Choice it={it} />;
  }
}

/**
 * 执行过的操作（Codex 的样子）：做完后折叠成一行「执行了 N 个操作」，点开看每一步；
 * 正在执行时自动展开，最后一步显示转圈。截图缩略图一直显示。
 */
function Steps({ steps: all, image }: { steps: Step[]; image?: { data: string; mimeType: string } }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  // ask_user 已经显示成选择卡片
  const steps = all.filter((s) => s.name !== 'ask_user');
  if (!steps.length && !image) return null;
  const running = steps.some((s) => s.status === 'running');
  const failed = steps.filter((s) => s.status === 'error').length;
  const expanded = open ?? running;
  const current = steps.find((s) => s.status === 'running');
  return (
    <div className="text-[13px]">
      {steps.length ? (
        <button className="flex max-w-full items-center gap-1.5 text-muted-foreground hover:text-foreground" onClick={() => setOpen(!expanded)}>
          {running ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" /> : <ListChecks className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">
            {running && current
              ? `正在${TOOL_LABEL[current.name] ?? current.name}${current.summary && current.summary !== TOOL_LABEL[current.name] ? `：${current.summary}` : ''}`
              : `执行了 ${steps.length} 个操作`}
          </span>
          {failed && !running ? <span className="shrink-0 text-destructive">（{failed} 个没成功）</span> : null}
          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        </button>
      ) : null}
      {expanded && steps.length ? (
        <div className="ml-[7px] mt-1.5 space-y-0.5 border-l border-border pl-3.5">
          {steps.map((s) => (
            <div key={s.id}>
              <button className="flex w-full min-w-0 items-center gap-2 py-0.5 text-left" onClick={() => setDetail(detail === s.id ? null : s.id)}>
                {s.status === 'running' ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                ) : s.status === 'ok' ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                )}
                <span className="shrink-0 text-foreground/80">{TOOL_LABEL[s.name] ?? s.name}</span>
                <span className={cn('min-w-0 flex-1 truncate text-xs text-muted-foreground', MONO.has(s.name) && 'font-mono')}>
                  {s.summary === (TOOL_LABEL[s.name] ?? s.name) ? '' : s.summary}
                </span>
              </button>
              {detail === s.id && s.result ? (
                <div className={cn('mb-1 select-text whitespace-pre-wrap break-all pl-[22px] text-xs', s.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                  {s.result}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {image ? (
        <>
          <img
            src={`data:${image.mimeType};base64,${image.data}`}
            className="mt-2 max-h-36 cursor-zoom-in rounded-lg border border-border"
            onClick={() => setZoom(true)}
            alt="截图"
          />
          {zoom ? (
            <div className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-6" onClick={() => setZoom(false)}>
              <img src={`data:${image.mimeType};base64,${image.data}`} className="max-h-full max-w-full rounded-lg shadow-lg" alt="截图" />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ---------- 输入框 ----------

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** 点外面或按 Esc 关闭的弹出层（贴着自己的按钮往上弹） */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/** 输入框下面一排的小按钮 */
const chip = 'flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground';
/** 输入框下面一排按钮的弹出层：在按钮正上方，右边和按钮对齐 */
const popover = 'absolute bottom-full right-0 z-30 mb-1.5 rounded-xl border border-border bg-background shadow-lg';

/**
 * 上下文圆环：进度 = 上下文用量 / 上限，超过自动压缩的比例时变红。
 * 点开是 Token 用量卡片（上下文、缓存命中、输出、速度、累计）和「压缩上下文」按钮，和手机端一样。
 */
function ContextMeter() {
  const conv = useStore(convStore);
  const model = useStore(modelStore);
  const { open, setOpen, ref } = usePopover();
  const cur = model.presets[model.active];
  const win = contextWindowOf(cur);
  // 统计来自当前模型时才算（切换模型后旧数字没有意义）
  const s = conv.stats && conv.stats.model === cur.model.trim() ? conv.stats : null;
  const ratio = s ? s.contextTokens / win : 0;
  const warn = ratio > AUTO_COMPRESS_RATIO;
  const hit = s?.promptTokens ? Math.round(((s.cachedTokens ?? 0) / s.promptTokens) * 100) : null;
  const pct = Math.min(100, ratio * 100);
  const row = (label: string, value: string, red?: boolean) => (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('tabular-nums', red && 'text-destructive')}>{value}</span>
    </div>
  );
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        className={cn(chip, 'gap-1.5', open && 'bg-accent text-foreground')}
        title="上下文用量"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="relative h-3.5 w-3.5 rounded-full border-2 border-border">
          {pct > 0 ? (
            <span
              className="absolute inset-[-2px] rounded-full"
              style={{
                background: `conic-gradient(${warn ? 'hsl(var(--destructive))' : 'hsl(var(--primary))'} ${Math.max(pct, 3) * 3.6}deg, transparent 0)`,
                WebkitMask: 'radial-gradient(circle, transparent 3px, #000 3.5px)',
              }}
            />
          ) : null}
        </span>
        {s ? `${Math.round(pct)}%` : null}
      </button>
      {open ? (
        <div className={cn(popover, 'max-h-[calc(100vh-8rem)] w-72 overflow-y-auto p-3 text-[13px]')}>
          <div className="flex items-center justify-between border-b border-border pb-2">
            <span className="font-medium">Token 用量</span>
            <span className="tabular-nums">{conv.totalTokens.toLocaleString('en-US')} tok</span>
          </div>
          <div className="truncate pt-1.5 text-[11px] text-muted-foreground">{cur.model || '未选择模型'}</div>
          <div className="pb-2 pt-1">
            {row('上下文', `${s ? fmtTokens(s.contextTokens) : '—'} / ${formatWindow(win)}`)}
            {s ? (
              <>
                <div className="my-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className={cn('h-full rounded-full', warn ? 'bg-destructive' : 'bg-primary')} style={{ width: `${Math.max(pct, 1)}%` }} />
                </div>
                {row('已用', `${(ratio * 100).toFixed(1)}%`, warn)}
                {hit !== null ? row('缓存命中', `${hit}%`) : null}
                {s.promptTokens !== undefined ? row('未命中', `${(s.promptTokens - (s.cachedTokens ?? 0)).toLocaleString('en-US')} tok`) : null}
                {s.cachedTokens !== undefined ? row('缓存读取', `${s.cachedTokens.toLocaleString('en-US')} tok`) : null}
                {s.completionTokens !== undefined ? row('输出', `${s.completionTokens.toLocaleString('en-US')} tok`) : null}
                {s.ttftMs ? row('首字等待', `${(s.ttftMs / 1000).toFixed(1)} 秒`) : null}
                {s.tokensPerSec != null ? row('速度', `${s.tokensPerSec.toFixed(s.tokensPerSec < 10 ? 1 : 0)}${s.estimated ? '≈' : ''} tok/s`) : null}
              </>
            ) : (
              <div className="py-1 text-xs text-muted-foreground">发送消息后显示本次请求的用量</div>
            )}
          </div>
          <button
            className="h-8 w-full rounded-lg bg-primary text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            disabled={conv.running || conv.history.length === 0}
            onClick={() => {
              setOpen(false);
              void compressNow();
            }}
          >
            压缩上下文
          </button>
          <div className="mt-1.5 text-center text-[11px] text-muted-foreground">超过 {Math.round(AUTO_COMPRESS_RATIO * 100)}% 时自动压缩较早的对话</div>
        </div>
      ) : null}
    </div>
  );
}

/** 输入框下面左边的操作确认模式，和「设置 → 操作确认」是同一个开关 */
function ConfirmPicker() {
  const settings = useStore(settingsStore);
  const { open, setOpen, ref } = usePopover();
  const cur = CONFIRM_MODES.find((m) => m.id === settings.confirm) ?? CONFIRM_MODES[0];
  return (
    <div ref={ref} className="relative min-w-0">
      <button className={cn(chip, settings.confirm === 'off' && 'text-warning-foreground', open && 'bg-accent text-foreground')} title="操作确认" onClick={() => setOpen((v) => !v)}>
        <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{cur.short}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open ? (
        <div className="absolute bottom-full left-0 z-30 mb-1.5 w-72 rounded-xl border border-border bg-background p-1 shadow-lg">
          <div className="px-2.5 pb-1 pt-1.5 text-xs text-muted-foreground">执行操作前要不要先问你</div>
          {CONFIRM_MODES.map((m) => (
            <button
              key={m.id}
              className={cn('flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-accent', m.id === settings.confirm && 'bg-accent')}
              onClick={() => {
                void updateSettings({ confirm: m.id });
                setOpen(false);
              }}
            >
              <Check className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 text-primary', m.id !== settings.confirm && 'invisible')} />
              <span>
                <span className="block text-[13px]">{m.label}</span>
                <span className="block text-[11px] text-muted-foreground">{m.hint}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 输入框下面的思考程度：当前模型能调时显示，点开选档位 */
function EffortPicker() {
  const model = useStore(modelStore);
  const { open, setOpen, ref } = usePopover();
  const cur = model.presets[model.active];
  const options = reasoningOptions(model.active, cur.model);
  const level = reasoningOf(model.active, cur);
  if (!cur.model || level === null) return null;
  const label = options.find((o) => o.id === level)?.label ?? '';
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        className={cn(chip, level !== 'off' && 'text-primary hover:text-primary', open && 'bg-accent')}
        title="思考程度"
        onClick={() => setOpen((v) => !v)}
      >
        <Brain className="h-3.5 w-3.5" />
        {label}
      </button>
      {open ? (
        <div className={cn(popover, 'w-80 p-3 text-[13px]')}>
          <div className="mb-2 flex items-center gap-1.5">
            <span className="font-medium">思考程度</span>
            <span className="text-primary">{label}</span>
          </div>
          <EffortSlider
            options={options}
            value={level}
            onChange={(v) => {
              void setReasoning(v);
              setOpen(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** 输入框里的模型选择：切换已配置的预设，最下面进模型设置 */
function ModelPicker({ onSettings }: { onSettings: () => void }) {
  const model = useStore(modelStore);
  const { open, setOpen, ref } = usePopover();
  const cur = model.presets[model.active];
  return (
    <div ref={ref} className="relative min-w-0 max-w-[260px]">
      <button
        className={cn(chip, 'max-w-full', open && 'bg-accent text-foreground')}
        onClick={() => setOpen((v) => !v)}
        title="选择模型"
      >
        <span className="truncate">{cur.model ? modelLabel(model.active, cur) : '选择模型'}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open ? (
        <div className={cn(popover, 'w-64 p-1')}>
          {MODEL_PRESETS.map((p) => {
            const s = model.presets[p.id];
            const ready = model.hasKey[p.id] && !!s.model;
            return (
              <button
                key={p.id}
                disabled={!ready}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-accent disabled:opacity-45"
                onClick={() => {
                  void setActivePreset(p.id);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block">{p.id === 'custom' ? s.name || '自定义' : p.label}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{ready ? s.model : '还没配置'}</span>
                </span>
                {model.active === p.id ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
              </button>
            );
          })}
          <div className="my-1 border-t border-border" />
          <button
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-accent"
            onClick={() => {
              setOpen(false);
              onSettings();
            }}
          >
            <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
            模型设置…
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Composer({ onSettings }: { onSettings: () => void }) {
  const conv = useStore(convStore);
  const bus = useStore(composerBus);
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<Attachment[]>([]);
  // 热键唤起时，剪贴板里有新复制的文字就提示「引用」
  const [clip, setClip] = useState('');
  const lastClip = useRef('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // 按内容调高度：空的时候固定两行高（提示文字也会被 Chromium 算进 scrollHeight）；窗口宽度变化时重新算
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = el.value ? `${Math.min(Math.max(el.scrollHeight, 48), 240)}px` : '48px';
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
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
  const canSend = (!!text.trim() || atts.length > 0) && !conv.running;
  return (
    <div>
      {conv.progress ? <div className="mb-1.5 px-1 text-xs text-muted-foreground">{conv.progress}</div> : null}
      {clip ? (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-border bg-subtle px-3 py-1.5 text-xs">
          <ClipboardPaste className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-foreground/80">{clip}</span>
          <button
            className="shrink-0 font-medium text-primary hover:underline"
            onClick={() => {
              setText((t) => `${clip}\n\n${t}`);
              lastClip.current = clip;
              setClip('');
              ref.current?.focus();
            }}
          >
            引用剪贴板
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
      <div className="relative rounded-2xl border border-border bg-background shadow-[0_2px_10px_rgba(0,0,0,0.04)] transition-colors focus-within:border-foreground/25">
        {atts.length ? (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {atts.map((a, i) => (
              <div key={i} className="group relative" title={a.path ?? a.name}>
                {a.kind === 'image' && a.thumb ? (
                  <img src={a.thumb} className="h-14 max-w-[120px] rounded-lg border border-border object-cover" alt={a.name} />
                ) : (
                  <span className="flex h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
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
        <textarea
          ref={ref}
          rows={2}
          className="block w-full resize-none bg-transparent px-4 pt-3 text-[14.5px] leading-6 outline-none placeholder:text-muted-foreground/70"
          placeholder="让助手查点什么，或者在电脑上做点什么"
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
                  void imageAttachment(String(r.result), f.name && f.name !== 'image.png' ? f.name : '粘贴的图片.png').then((a) => setAtts((x) => [...x, a]));
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
        <div className="flex items-center gap-0.5 px-2 pb-2 pt-1">
          <IconButton title="添加文件或图片" onClick={() => picker.current?.click()}>
            <Plus className="h-4 w-4" />
          </IconButton>
          <IconButton title="框选屏幕提问" onClick={() => window.p2d.captureRegion()}>
            <Crop className="h-4 w-4" />
          </IconButton>
          <input
            ref={picker}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <div className="flex-1" />
          {conv.running ? (
            <button
              title="停止"
              className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background hover:bg-foreground/80"
              onClick={stop}
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              title="发送（Enter），换行用 Shift+Enter"
              disabled={!canSend}
              className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
              onClick={submit}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      {/* 输入框下面一排：左边操作确认，右边模型、思考程度、上下文（参考 DeepSeek Harness） */}
      <div className="mt-1.5 flex items-center gap-1 px-1">
        <ConfirmPicker />
        <div className="flex-1" />
        <ModelPicker onSettings={onSettings} />
        <EffortPicker />
        <ContextMeter />
      </div>
    </div>
  );
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

function Choice({ it }: { it: ChoiceItem }) {
  const [sel, setSel] = useState<string[]>([]);
  const [custom, setCustom] = useState('');
  const pending = it.status === 'pending';
  const submit = (selected: string[]) => answerChoice(it.id, { selected, custom: custom.trim() || undefined });
  // 答完或作废后收成一行：问题 + 选了什么
  if (!pending) {
    const picked = [...(it.answer?.selected ?? []), ...(it.answer?.custom ? [it.answer.custom] : [])].join('、');
    return (
      <div className="flex min-w-0 items-start gap-2 text-[13px] text-muted-foreground">
        {it.status === 'answered' ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        <span className="min-w-0 select-text whitespace-pre-wrap break-words">
          {it.question.replace(/\n/g, ' ')}
          <span className="ml-1.5 text-foreground/80">{it.status === 'answered' ? `→ ${picked || '没有选择'}` : '→ 已取消'}</span>
        </span>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-border bg-subtle p-4">
      <div className="mb-2.5 select-text text-[14px] font-medium">{it.question}</div>
      <div className="flex flex-col gap-1.5">
        {it.options.map((o) => {
          const chosen = it.answer?.selected.includes(o.label) || sel.includes(o.label);
          return (
            <button
              key={o.label}
              disabled={!pending}
              className={cn(
                'rounded-xl border px-3.5 py-2.5 text-left text-[13px]',
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
      const { ids: list, windows } = await listModelsDetailed({ baseUrl: draft.baseUrl.trim(), apiKey: key.trim() }, ipcFetch);
      patch({ models: list, windows, model: draft.model || list[0] || '' });
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
  const autoWindow = contextWindowOf({ ...draft, contextWindow: undefined });
  const encrypted = useKeyEncrypted();
  const field = 'h-8 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus:border-primary';

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 dark:bg-black/60 p-6">
      <div className="flex max-h-full w-[520px] flex-col rounded-xl border border-border bg-background shadow-xl">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-5">
          <span className="font-semibold">设置</span>
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
          <Field label="API Key" hint={keyStorageHint(encrypted)}>
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
          </div>
          {reasoningOptions(active, draft.model).length ? (
            <Field label="思考程度" hint="输入框里也能随时切换；越强回答越仔细，但更慢、用量更多">
              <EffortSlider
                options={reasoningOptions(active, draft.model)}
                value={reasoningOf(active, draft) ?? 'default'}
                onChange={(v) => patch({ reasoning: v })}
              />
            </Field>
          ) : null}
          <Field
            label="上下文长度"
            hint={`自动：${formatWindow(autoWindow)}（${draft.windows?.[draft.model.trim()] ? '接口提供' : '按模型官方数据'}），一般不用改。用到 ${Math.round(AUTO_COMPRESS_RATIO * 100)}% 时自动压缩较早的对话`}
          >
            <div className="flex items-center gap-2">
              <input
                className={field}
                type="number"
                min={4000}
                value={draft.contextWindow ?? ''}
                placeholder={`自动 ${autoWindow}`}
                onChange={(e) => patch({ contextWindow: e.target.value ? Number(e.target.value) : undefined })}
              />
              {WINDOW_PRESETS.map((w) => (
                <button
                  key={w.label}
                  className={cn('h-8 shrink-0 rounded-md border px-2 text-xs hover:bg-accent', draft.contextWindow === w.value ? 'border-primary text-primary' : 'border-border')}
                  onClick={() => patch({ contextWindow: draft.contextWindow === w.value ? undefined : w.value })}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="系统提示词" hint={`加在内置提示词之后；默认是「电脑管理」，可以改，${draft.systemPrompt?.length ?? 0} / ${MAX_PROMPT} 字`}>
            <textarea
              className={cn(field, 'h-40 resize-y py-1.5 leading-5')}
              value={draft.systemPrompt ?? ''}
              placeholder="例如：回答先给结论再说步骤；改系统设置前先说明风险"
              onChange={(e) => patch({ systemPrompt: e.target.value.slice(0, MAX_PROMPT) })}
            />
            {(draft.systemPrompt ?? '').trim() !== defaultPrompt('desktop').trim() ? (
              <button
                className="mt-1.5 rounded border border-border px-2 py-0.5 text-xs hover:bg-accent"
                onClick={() => {
                  if (draft.systemPrompt?.trim() && !confirm('用默认提示词替换现在填写的内容？')) return;
                  patch({ systemPrompt: defaultPrompt('desktop') });
                }}
              >
                恢复默认
              </button>
            ) : null}
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
const WINDOW_PRESETS = [
  { label: '128K', value: 128_000 },
  { label: '256K', value: 256_000 },
  { label: '1M', value: 1_048_576 },
];

/** 思考程度选择：从「更快」到「更强」的一排档位（参考 DeepSeek Harness 的推理等级滑块） */
function EffortSlider({
  options,
  value,
  onChange,
}: {
  options: ReturnType<typeof reasoningOptions>;
  value: ReasoningLevel;
  onChange: (v: ReasoningLevel) => void;
}) {
  const cur = options.find((o) => o.id === value);
  return (
    <div>
      <div className="flex rounded-lg bg-muted p-1">
        {options.map((o) => (
          <button
            key={o.id}
            title={o.hint}
            className={cn('h-7 flex-1 rounded-md text-[13px]', o.id === value ? 'bg-background font-medium text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between px-1 text-[11px] text-muted-foreground">
        <span>更快</span>
        <span>{cur?.hint}</span>
        <span>更强</span>
      </div>
    </div>
  );
}

const LOCAL_MODELS = [
  { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', key: 'ollama' },
  { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', key: 'lm-studio' },
];

const CONFIRM_MODES: { id: ConfirmMode; label: string; short: string; hint: string }[] = [
  { id: 'risky', label: '高风险操作', short: '高风险操作先问', hint: '管理员命令、删除、格式化、改注册表 / 服务等先问一下' },
  { id: 'all', label: '执行命令和改文件都问', short: '每步都问', hint: '每条命令、写文件、删除、下载前都要你点允许' },
  { id: 'off', label: '不确认', short: '不确认', hint: '助手自己决定（不建议）' },
];

const HOTKEY_ROWS: { id: HotkeyId; label: string; hint: string }[] = [
  { id: 'ask', label: '唤起助手', hint: '切到 AI 助手、光标放进输入框' },
  { id: 'capture', label: '框选屏幕提问', hint: '框一块屏幕交给助手' },
  { id: 'stop', label: '停止助手', hint: '助手运行时才占用这个组合' },
];

const isMac = navigator.platform.toLowerCase().includes('mac');

const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  Escape: 'Escape',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Pause: 'Pause',
  PrintScreen: 'PrintScreen',
};

/** 键盘事件 → Electron 快捷键写法；只按了修饰键时返回 null */
function toAccelerator(e: React.KeyboardEvent): string | null {
  const code = e.nativeEvent.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F[0-9]{1,2}$/.test(code)) key = code;
  else key = KEY_NAMES[code] ?? null;
  if (!key) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push(isMac ? 'Command' : 'Super');
  return [...mods, key].join('+');
}

const accelLabel = (a: string) => a.replace(/Control/g, 'Ctrl').replace('Escape', 'Esc');

/** 点一下后按下新的组合键；单独按 Esc 取消 */
function HotkeyRecorder({ value, onChange }: { value: string; onChange: (accel: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState('');
  return (
    <button
      className={cn(
        'h-7 min-w-[160px] rounded-md border px-2.5 text-left font-mono text-xs',
        recording ? 'border-primary bg-primary/5 text-primary' : 'border-border hover:bg-accent',
      )}
      title="点一下，然后按下新的组合键"
      onClick={() => {
        setRecording(true);
        setHint('');
      }}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (!recording) return;
        e.preventDefault();
        if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
          setRecording(false);
          return;
        }
        const accel = toAccelerator(e);
        if (!accel) return; // 还只按着修饰键
        if (!accel.includes('+') && !/^F[0-9]+$/.test(accel)) {
          setHint('要带上 Ctrl、Alt 或 Shift');
          return;
        }
        setRecording(false);
        onChange(accel);
      }}
    >
      {recording ? hint || '请按下新的组合键…' : accelLabel(value)}
    </button>
  );
}

/** 操作确认和快捷键（改了马上生效，不用点「保存并使用」） */
function OtherSettings() {
  const st = useStore(settingsStore);
  const [keys, setKeys] = useHotkeys();
  const updateKey = (id: HotkeyId, patch: Partial<HotkeyConfig>) => {
    if (!keys) return;
    const next = {} as HotkeySettings;
    for (const r of HOTKEY_ROWS) next[r.id] = { enabled: keys[r.id].enabled, accel: keys[r.id].accel };
    next[id] = { ...next[id], ...patch };
    void window.p2d.setAgentHotkeys(next).then(setKeys);
  };
  const ap = useAppearance();
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <Field label="外观" hint="整个 P2D 共用；标题栏和托盘菜单里也能切换">
        <div className="flex w-60 rounded-lg bg-muted p-1">
          {APPEARANCES.map((a) => (
            <button
              key={a.id}
              className={cn('h-7 flex-1 rounded-md text-[13px]', ap.setting === a.id ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              onClick={() => void setAppearance(a.id)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </Field>
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
      <Field label="全局快捷键" hint="默认关着；打开后在任何程序里都能用，改了马上生效">
        <div className="space-y-2">
          {HOTKEY_ROWS.map((r) => {
            const k = keys?.[r.id];
            return (
              <div key={r.id}>
                <div className="flex items-center gap-2">
                  <label className="flex w-32 shrink-0 cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-primary"
                      checked={!!k?.enabled}
                      disabled={!k}
                      onChange={(e) => updateKey(r.id, { enabled: e.target.checked })}
                    />
                    {r.label}
                  </label>
                  {k ? <HotkeyRecorder value={k.accel} onChange={(accel) => updateKey(r.id, { accel })} /> : null}
                  {k?.enabled ? (
                    k.ok ? (
                      <span className="flex items-center gap-1 text-[11px] text-success-foreground">
                        <Check className="h-3 w-3" />
                        已生效
                      </span>
                    ) : (
                      <span className="text-[11px] text-destructive">{k.error}</span>
                    )
                  ) : null}
                </div>
                <div className="ml-[22px] text-[11px] text-muted-foreground">{r.hint}</div>
              </div>
            );
          })}
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
