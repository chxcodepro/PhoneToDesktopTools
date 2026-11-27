// 扩展（Skill、MCP）和定时任务的管理面板
import { Clock, Play, Plus, Puzzle, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { parseMcpConfig } from '@agent/extensions';
import type { SkillPackage } from '@agent/extensionTools';
import { describeSchedule, formatDateTime } from '@agent/schedule';
import { Button, Spinner } from '@/components/ui';
import { cn } from '@/lib/utils';
import { openConversation } from './conversation';
import {
  addServers,
  connectServer,
  extStore,
  prepareSkillFromUrl,
  removeServer,
  removeSkill,
  setSecret,
  setServerEnabled,
  setSkillEnabled,
} from './extensions';
import { useStore } from './model';
import { deleteTask, runTask, scheduleStore, updateTask } from './schedules';

export function Dialog({ title, onClose, children, width = 560 }: { title: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-6">
      <div className="flex max-h-full flex-col rounded-xl border border-border bg-background shadow-xl" style={{ width }}>
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-5">
          <span className="font-semibold">{title}</span>
          <button className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-[13px]">{children}</div>
      </div>
    </div>
  );
}

function Switch({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button
      title={title}
      className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', on ? 'bg-primary' : 'bg-border')}
      onClick={() => onChange(!on)}
    >
      <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}

const field = 'w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus:border-primary';

// ---------- 扩展 ----------

export function ExtensionsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'skill' | 'mcp'>('skill');
  return (
    <Dialog title="扩展" onClose={onClose} width={620}>
      <div className="mb-4 flex rounded-lg bg-muted p-1">
        {(['skill', 'mcp'] as const).map((t) => (
          <button
            key={t}
            className={cn('h-7 flex-1 rounded-md', tab === t ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}
            onClick={() => setTab(t)}
          >
            {t === 'skill' ? 'Skill（做事的方法）' : 'MCP（外部工具）'}
          </button>
        ))}
      </div>
      {tab === 'skill' ? <Skills /> : <Mcps />}
      <p className="mt-4 text-xs text-muted-foreground">也可以直接在对话里说「装一下这个 Skill：网址」「把刚才的流程保存成 Skill」，助手会弹出确认卡片。</p>
    </Dialog>
  );
}

function Skills() {
  const ext = useStore(extStore);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pkg, setPkg] = useState<SkillPackage | null>(null);
  const prepare = async () => {
    setBusy(true);
    setError('');
    try {
      setPkg(await prepareSkillFromUrl(url.trim()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      {!ext.ready ? <Spinner className="h-4 w-4" /> : null}
      {ext.skills.map((s) => (
        <div key={s.id} className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
          <Puzzle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{s.name}</span>
              <span className="text-[11px] text-muted-foreground">{s.source}</span>
            </div>
            <div className="line-clamp-2 text-xs text-muted-foreground">{s.description}</div>
          </div>
          <Switch on={s.enabled} onChange={(v) => setSkillEnabled(s.id, v)} title={s.enabled ? '停用' : '启用'} />
          <button
            className="text-muted-foreground hover:text-destructive"
            title="删除"
            onClick={() => confirm(`删除 Skill「${s.name}」？`) && void removeSkill(s.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="pt-2">
        <div className="mb-1.5 font-medium">从网址安装</div>
        <div className="flex gap-2">
          <input
            className={cn(field, 'h-8')}
            placeholder="GitHub 仓库或子目录地址、zip 或 SKILL.md 的地址"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button size="sm" variant="outline" className="shrink-0" disabled={busy || !url.trim()} onClick={() => void prepare()}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            读取
          </Button>
        </div>
        {error ? <div className="mt-1.5 text-xs text-destructive">{error}</div> : null}
        {pkg ? (
          <div className="mt-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <div className="mb-1.5">来源：{pkg.source}，找到 {pkg.skills.length} 个 Skill：</div>
            {pkg.skills.map((s) => (
              <div key={s.name} className="text-xs">
                · <span className="font-medium">{s.name}</span>：{s.description}（{s.files.length} 个文件）
              </div>
            ))}
            <div className="mt-2 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setPkg(null)}>
                取消
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  void pkg.commit().then(() => {
                    setPkg(null);
                    setUrl('');
                  });
                }}
              >
                安装
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SecretInput({ id, name }: { id: string; name: string }) {
  const [v, setV] = useState('');
  return (
    <div className="mt-1.5 flex gap-2">
      <input className={cn(field, 'h-7 font-mono text-xs')} type="password" placeholder={`填写 ${name}`} value={v} onChange={(e) => setV(e.target.value)} />
      <Button size="sm" disabled={!v.trim()} onClick={() => void setSecret(id, name, v.trim()).then(() => connectServer(id))}>
        保存
      </Button>
    </div>
  );
}

function Mcps() {
  const ext = useStore(extStore);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const add = async () => {
    setError('');
    const r = parseMcpConfig(input.trim());
    if (typeof r === 'string') {
      setError(r);
      return;
    }
    await addServers(r, 'user');
    setInput('');
  };
  return (
    <div className="space-y-2">
      {ext.servers.map((s) => {
        const st = ext.status[s.id];
        const missing = st?.state === 'error' && /^需要填写/.test(st.error ?? '') ? (s.secrets ?? []) : [];
        return (
          <div key={s.id} className="rounded-lg border border-border px-3 py-2.5">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{s.name}</span>
                  <span className="text-[11px] text-muted-foreground">{s.kind === 'remote' ? '远程' : '在这台电脑上运行'}</span>
                </div>
                <div className={cn('truncate text-xs', st?.state === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                  {!s.enabled
                    ? '已停用'
                    : st?.state === 'ready'
                      ? `已连接，${st.tools.length} 个工具`
                      : st?.state === 'connecting'
                        ? '正在连接…'
                        : st?.state === 'error'
                          ? st.error
                          : (s.url ?? `${s.command} ${(s.args ?? []).join(' ')}`)}
                </div>
              </div>
              <Switch on={s.enabled} onChange={(v) => setServerEnabled(s.id, v)} />
              <button
                className="text-muted-foreground hover:text-destructive"
                title="删除"
                onClick={() => confirm(`删除 MCP「${s.name}」？`) && void removeServer(s.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {missing.map((n) => (
              <SecretInput key={n} id={s.id} name={n} />
            ))}
          </div>
        );
      })}
      <div className="pt-2">
        <div className="mb-1.5 font-medium">添加 MCP</div>
        <textarea
          className={cn(field, 'h-24 resize-none py-1.5 font-mono text-xs')}
          placeholder={'远程 MCP 的网址，或 mcpServers 配置 JSON，例如：\n{"mcpServers":{"filesystem":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","D:\\\\"]}}}'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        {error ? <div className="mt-1 text-xs text-destructive">{error}</div> : null}
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">令牌、密码类的值会单独加密保存，不进对话记录</span>
          <Button size="sm" disabled={!input.trim()} onClick={() => void add()}>
            添加
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------- 定时任务 ----------

const STATUS: Record<string, string> = { running: '执行中', ok: '成功', error: '失败', missed: '错过' };

export function SchedulesPanel({ onClose }: { onClose: () => void }) {
  const { tasks, ready } = useStore(scheduleStore);
  return (
    <Dialog title="定时任务" onClose={onClose}>
      {!ready ? <Spinner className="h-4 w-4" /> : null}
      {ready && !tasks.length ? (
        <div className="py-6 text-center text-muted-foreground">
          <Clock className="mx-auto mb-2 h-6 w-6" />
          还没有定时任务。在对话里说「每天早上 9 点帮我体检电脑」「每周五下午清理下载目录」，助手会帮你建好。
        </div>
      ) : null}
      <div className="space-y-2">
        {tasks.map((t) => (
          <div key={t.id} className="rounded-lg border border-border px-3 py-2.5">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{t.name}</div>
                <div className="text-xs text-muted-foreground">
                  {describeSchedule(t)} ·{' '}
                  {t.enabled ? (t.nextRunAt ? `下次 ${formatDateTime(t.nextRunAt)}` : '不再执行') : '已停用'}
                  {t.lastRunAt ? ` · 上次 ${formatDateTime(t.lastRunAt)} ${STATUS[t.lastStatus ?? ''] ?? ''}` : ''}
                </div>
              </div>
              <Switch on={t.enabled} onChange={(v) => updateTask(t.id, { enabled: v })} />
              <button className="text-muted-foreground hover:text-primary" title="立即执行" onClick={() => void runTask(t.id)}>
                <Play className="h-3.5 w-3.5" />
              </button>
              <button
                className="text-muted-foreground hover:text-destructive"
                title="删除"
                onClick={() => confirm(`删除定时任务「${t.name}」？`) && deleteTask(t.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-1 line-clamp-2 select-text text-xs text-muted-foreground">指令：{t.prompt}</div>
            {t.lastNote ? <div className="mt-0.5 text-xs text-destructive">{t.lastNote}</div> : null}
            {t.lastConversationId ? (
              <button
                className="mt-1 text-xs text-primary hover:underline"
                onClick={() => {
                  void openConversation(t.lastConversationId!);
                  onClose();
                }}
              >
                查看上次执行的对话
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">P2D 开着（在托盘里就行）才会按时执行；到点时没开着，30 分钟内打开会补执行。自动执行时只做查询和低风险操作。</p>
    </Dialog>
  );
}
