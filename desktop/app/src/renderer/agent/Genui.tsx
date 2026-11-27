// 回答里的 ```p2d-ui 卡片（组件定义和解析在手机端共用的 mobile/src/agent/genui.ts）
import { AlertCircle, AlertTriangle, CheckCircle2, Circle, Info, Loader2, XCircle } from 'lucide-react';
import type { GenuiNode, GenuiSpec, Tone } from '@agent/genui';
import { cn } from '@/lib/utils';
import { convStore, send } from './conversation';

const TONE: Record<Tone, { box: string; text: string; Icon: typeof Info }> = {
  info: { box: 'border-primary/30 bg-primary/5', text: 'text-primary', Icon: Info },
  success: { box: 'border-success/30 bg-success/5', text: 'text-success-foreground', Icon: CheckCircle2 },
  warning: { box: 'border-warning/40 bg-warning/10', text: 'text-warning-foreground', Icon: AlertTriangle },
  error: { box: 'border-destructive/30 bg-destructive/5', text: 'text-destructive', Icon: AlertCircle },
};

function Node({ n }: { n: GenuiNode }) {
  switch (n.type) {
    case 'callout': {
      const t = TONE[n.tone];
      return (
        <div className={cn('flex gap-2.5 rounded-lg border px-3.5 py-2.5', t.box)}>
          <t.Icon className={cn('mt-0.5 h-4 w-4 shrink-0', t.text)} />
          <div className="min-w-0">
            {n.title ? <div className={cn('font-medium', t.text)}>{n.title}</div> : null}
            <div className="whitespace-pre-wrap text-[13px]">{n.text}</div>
          </div>
        </div>
      );
    }
    case 'stats':
      return (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${n.items.length}, minmax(0, 1fr))` }}>
          {n.items.map((i, k) => (
            <div key={k} className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
              <div className="text-xs text-muted-foreground">{i.label}</div>
              <div className={cn('mt-0.5 text-lg font-semibold', i.tone && TONE[i.tone].text)}>{i.value}</div>
              {i.hint ? <div className="text-[11px] text-muted-foreground">{i.hint}</div> : null}
            </div>
          ))}
        </div>
      );
    case 'progress': {
      const bar = n.value >= 90 ? 'bg-destructive' : n.value >= 75 ? 'bg-warning' : 'bg-primary';
      return (
        <div>
          <div className="mb-1 flex justify-between text-[13px]">
            <span>{n.label}</span>
            <span className="text-muted-foreground">
              {Math.round(n.value)}%{n.hint ? ` · ${n.hint}` : ''}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className={cn('h-full rounded-full', bar)} style={{ width: `${n.value}%` }} />
          </div>
        </div>
      );
    }
    case 'steps':
      return (
        <div className="space-y-1.5 rounded-lg border border-border px-3.5 py-2.5">
          {n.items.map((i, k) => (
            <div key={k} className="flex gap-2 text-[13px]">
              {i.status === 'done' ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              ) : i.status === 'current' ? (
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              ) : i.status === 'error' ? (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              ) : (
                <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <div className={cn(i.status === 'todo' && 'text-muted-foreground')}>{i.title}</div>
                {i.detail ? <div className="text-xs text-muted-foreground">{i.detail}</div> : null}
              </div>
            </div>
          ))}
        </div>
      );
    case 'kv':
      return (
        <div className="rounded-lg border border-border px-3.5 py-2.5">
          {n.title ? <div className="mb-1.5 font-medium">{n.title}</div> : null}
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            {n.items.map((i, k) => (
              <div key={k} className="contents">
                <span className="text-muted-foreground">{i.label}</span>
                <span className="select-text break-words">{i.value}</span>
              </div>
            ))}
          </div>
        </div>
      );
    case 'buttons':
      return (
        <div className="flex flex-wrap gap-2">
          {n.items.map((i, k) => (
            <button
              key={k}
              className="rounded-full border border-primary/40 px-3.5 py-1 text-[13px] text-primary hover:bg-primary/10"
              title={i.send}
              onClick={() => !convStore.get().running && void send(i.send)}
            >
              {i.label}
            </button>
          ))}
        </div>
      );
  }
}

export function Genui({ spec }: { spec: GenuiSpec }) {
  return (
    <div className="my-2 flex flex-col gap-2 font-sans">
      {spec.title ? <div className="font-medium">{spec.title}</div> : null}
      {spec.nodes.map((n, i) => (
        <Node key={i} n={n} />
      ))}
    </div>
  );
}
