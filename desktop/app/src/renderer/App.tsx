// 电脑端主窗口：等待连接 → 正在连接 → 已连接
import { AlertTriangle, CheckCircle2, Circle, Minus, Monitor, OctagonX, Plug, Smartphone, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Kbd, Spinner } from '@/components/ui';
import { cn, formatDuration, platformLabel } from '@/lib/utils';
import { deviceNameFor, type AppStatus, type CoreDevice } from '../shared/types';

function useAppStatus(): AppStatus {
  const [s, setS] = useState<AppStatus>({ coreOnline: false });
  useEffect(() => {
    void window.p2d.getStatus().then(setS);
    return window.p2d.onStatus(setS);
  }, []);
  return s;
}

function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const CONNECTING_STAGES = ['unauthorized', 'installing', 'starting', 'ready', 'error'];

export function App() {
  const s = useAppStatus();
  const st = s.status;
  const session = st?.sessions?.[0];
  const connecting = st?.devices?.find((d) => CONNECTING_STAGES.includes(d.stage));

  let body: JSX.Element;
  if (session) body = <Connected name={deviceNameFor(st, session.serial)} since={session.connectedAt} hotkey={s.hotkey} />;
  else if (connecting) body = <Connecting device={connecting} />;
  else body = <Waiting s={s} />;

  return (
    <div className="flex h-full flex-col overflow-hidden border border-border bg-background">
      <TitleBar />
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 p-5">{body}</div>
      <footer className="flex h-10 shrink-0 items-center justify-between border-t border-border px-3.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Monitor className="h-3 w-3" />
          {st?.hostname ?? '本机'}
        </span>
        <span>{platformLabel(st?.os, st?.arch)}</span>
      </footer>
    </div>
  );
}

function TitleBar() {
  return (
    <header className="drag flex h-9 shrink-0 items-center justify-between border-b border-border pl-3">
      <div className="flex items-center gap-2">
        <div className="flex h-5 w-5 items-center justify-center rounded-md bg-primary text-white">
          <Smartphone className="h-3 w-3" strokeWidth={2.5} />
        </div>
        <span className="text-[13px] font-semibold">PhoneToDesktop</span>
      </div>
      <div className="no-drag flex h-full">
        <button
          aria-label="最小化"
          className="flex w-10 items-center justify-center text-muted-foreground hover:bg-accent"
          onClick={() => window.p2d.minimize()}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          aria-label="关闭到托盘"
          className="flex w-10 items-center justify-center text-muted-foreground hover:bg-[#e81123] hover:text-white"
          onClick={() => window.p2d.hide()}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}

function Hero({ ok, animated }: { ok?: boolean; animated?: boolean }) {
  const node = cn(
    'flex h-[60px] w-[60px] items-center justify-center rounded-[18px]',
    ok ? 'bg-success/10 text-success-foreground' : 'bg-primary/10 text-primary',
  );
  return (
    <div className="flex items-center justify-center gap-2.5 pt-3.5">
      <div className={node}>
        <Smartphone className="h-7 w-7" />
      </div>
      <div className={cn('h-0.5 w-[52px]', ok ? 'bg-success' : 'wire', animated && 'animate-flow')} />
      <div className={node}>
        <Monitor className="h-7 w-7" />
      </div>
    </div>
  );
}

function Row({ icon, label, right, muted }: { icon: JSX.Element; label: string; right?: JSX.Element | string; muted?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2.5 px-3 py-2.5 text-[13px]', muted && 'text-muted-foreground')}>
      {icon}
      <span className="flex-1">{label}</span>
      {typeof right === 'string' ? <span className="text-xs text-muted-foreground">{right}</span> : right}
    </div>
  );
}

const sep = <div className="h-px bg-border" />;
const ok = <CheckCircle2 className="h-3.5 w-3.5 text-success-foreground" />;
const warn = <AlertTriangle className="h-3.5 w-3.5 text-warning-foreground" />;
const pending = <Circle className="h-3.5 w-3.5" />;

function Waiting({ s }: { s: AppStatus }) {
  const adb = s.status?.adbAvailable;
  return (
    <>
      <Hero animated />
      <div className="text-center text-lg font-bold">{s.coreOnline ? '等待手机连接' : '正在启动服务…'}</div>
      {!s.coreOnline && s.coreError && <div className="text-center text-xs text-destructive">{s.coreError}</div>}
      <Card className="mt-auto">
        <Row
          icon={adb ? ok : warn}
          label="Android 驱动"
          right={adb ? <Badge variant="success">就绪</Badge> : <Badge variant="warning">未就绪</Badge>}
        />
        {sep}
        <Row icon={warn} label="iPhone 驱动" right={<Badge variant="muted">暂不支持</Badge>} />
      </Card>
    </>
  );
}

function Connecting({ device }: { device: CoreDevice }) {
  const name = device.model || device.serial;
  const stage = device.stage;
  const installDone = stage === 'starting' || stage === 'ready';
  return (
    <>
      <Hero animated />
      <div className="text-center text-lg font-bold">正在连接 {name}</div>
      <Card className="mt-auto">
        {stage === 'unauthorized' ? (
          <Row icon={<Spinner />} label="请在手机上允许 USB 调试" />
        ) : (
          <Row icon={ok} label="检测到手机" />
        )}
        {sep}
        <Row
          icon={stage === 'installing' ? <Spinner /> : installDone ? ok : pending}
          label="安装手机端"
          muted={!installDone && stage !== 'installing'}
        />
        {sep}
        <Row
          icon={installDone ? <Spinner /> : pending}
          label="启动并连接"
          muted={!installDone}
        />
      </Card>
      {stage === 'error' && device.message && <div className="text-center text-xs text-destructive">{device.message}</div>}
    </>
  );
}

function Connected({ name, since, hotkey }: { name: string; since: string; hotkey?: string[] }) {
  const now = useNow();
  const seconds = (now - new Date(since).getTime()) / 1000;
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Hero ok />
      <div className="text-center">
        <div className="flex items-center justify-center gap-2">
          <span className="h-2 w-2 rounded-full bg-success shadow-[0_0_0_3px_hsl(var(--success)/0.2)]" />
          <span className="text-lg font-bold">已连接 {name}</span>
        </div>
        <div className="mt-1.5 font-mono text-xl font-semibold">{formatDuration(seconds)}</div>
      </div>
      <div className="flex justify-center gap-1.5">
        <Badge variant="primary">
          <Plug className="h-3 w-3" />
          USB
        </Badge>
        <Badge variant="destructive">正在被控制</Badge>
      </div>
      <div className="mt-auto flex flex-col gap-2">
        <Button
          variant="destructive"
          size="lg"
          className="w-full"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void window.p2d.disconnect().finally(() => setBusy(false));
          }}
        >
          <OctagonX className="h-4 w-4" />
          断开连接
        </Button>
        {hotkey?.length ? (
          <div className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
            {hotkey.map((k, i) => (
              <span key={k} className="flex items-center gap-1">
                {i > 0 ? '+' : null}
                <Kbd>{k}</Kbd>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
