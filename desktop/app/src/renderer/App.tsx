// 电脑端主窗口：等待连接 → 正在连接 → 已连接
import { AlertTriangle, CheckCircle2, Circle, Minus, Monitor, OctagonX, Plug, QrCode, Smartphone, Trash2, Wifi, X } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Kbd, Spinner } from '@/components/ui';
import { cn, formatDuration, platformLabel } from '@/lib/utils';
import { deviceNameFor, type AppStatus, type CoreDevice, type CoreLan } from '../shared/types';

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
  const [pairingView, setPairingView] = useState(false);
  const lan = st?.lan;

  let body: JSX.Element;
  if (pairingView && lan?.enabled) body = <Pairing lan={lan} onClose={() => setPairingView(false)} />;
  else if (session)
    body = (
      <Connected
        name={deviceNameFor(st, session.serial)}
        wifi={session.route === 'wifi'}
        since={session.connectedAt}
        hotkey={s.hotkey}
      />
    );
  else if (connecting) body = <Connecting device={connecting} />;
  else body = <Waiting s={s} onPair={() => setPairingView(true)} />;

  return (
    <div className="flex h-full flex-col overflow-hidden border border-border bg-background">
      <TitleBar />
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-5">{body}</div>
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

function Waiting({ s, onPair }: { s: AppStatus; onPair: () => void }) {
  const adb = s.status?.adbAvailable;
  const lan = s.status?.lan;
  const [showPaired, setShowPaired] = useState(false);
  const paired = lan?.paired ?? [];
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
        {!adb && s.status?.adbError ? (
          <div className="line-clamp-3 break-all px-3 pb-2.5 pl-9 text-xs text-warning-foreground">{s.status.adbError.replace(/（adb .*$/, '')}</div>
        ) : null}
        {sep}
        <Row icon={warn} label="iPhone 驱动" right={<Badge variant="muted">暂不支持</Badge>} />
        {sep}
        <Row
          icon={lan?.enabled ? ok : warn}
          label="WiFi 直连"
          right={lan?.enabled ? (lan.addrs?.[0] ?? '无局域网地址') : <Badge variant="warning">未开启</Badge>}
        />
        {paired.length ? (
          <>
            {sep}
            <button className="w-full text-left" onClick={() => setShowPaired((v) => !v)}>
              <Row icon={<Smartphone className="h-3.5 w-3.5" />} label="已配对的手机" right={`${paired.length} 部`} />
            </button>
            {showPaired
              ? paired.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 px-3 pb-2 pl-9 text-xs text-muted-foreground">
                    <span className="flex-1 truncate">{p.name}</span>
                    <button
                      aria-label={`取消与 ${p.name} 的配对`}
                      className="rounded p-1 hover:bg-accent hover:text-destructive"
                      onClick={() => void window.p2d.removePaired(p.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))
              : null}
          </>
        ) : null}
      </Card>
      {lan?.enabled && s.coreOnline ? (
        <Button
          variant="outline"
          className="w-full"
          onClick={() => {
            onPair();
            void window.p2d.startPairing();
          }}
        >
          <QrCode className="h-4 w-4" />
          配对新手机（WiFi）
        </Button>
      ) : null}
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

function Connected({ name, wifi, since, hotkey }: { name: string; wifi: boolean; since: string; hotkey?: string[] }) {
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
          {wifi ? <Wifi className="h-3 w-3" /> : <Plug className="h-3 w-3" />}
          {wifi ? 'WiFi' : 'USB'}
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

function useQr(text?: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!text) return;
    let alive = true;
    void QRCode.toDataURL(text, { margin: 1, width: 300, errorCorrectionLevel: 'M' }).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [text]);
  return text ? url : null;
}

/** 配对新手机：扫码，或在手机上输入 IP 后核对配对码 */
function Pairing({ lan, onClose }: { lan: CoreLan; onClose: () => void }) {
  const p = lan.pairing;
  const now = useNow();
  const qr = useQr(p?.active ? p.qr : undefined);
  const left = p?.expiresAt ? Math.max(0, Math.round((new Date(p.expiresAt).getTime() - now) / 1000)) : 0;
  const close = () => {
    void window.p2d.cancelPairing();
    onClose();
  };

  if (p?.state === 'done') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <CheckCircle2 className="h-12 w-12 text-success-foreground" />
        <div className="text-lg font-bold">已配对 {p.phoneName}</div>
        <div className="text-xs text-muted-foreground">以后在同一局域网内，手机上选这台电脑就能直接连接，不用插线。</div>
        <Button className="mt-2 w-full" onClick={onClose}>
          完成
        </Button>
      </div>
    );
  }
  if (!p?.active) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div className="text-sm text-muted-foreground">配对已结束</div>
        <div className="flex w-full gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            返回
          </Button>
          <Button className="flex-1" onClick={() => void window.p2d.startPairing()}>
            重新配对
          </Button>
        </div>
      </div>
    );
  }
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  if (p.state === 'code' && p.code) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div className="text-sm">「{p.phoneName}」请求配对</div>
        <div className="font-mono text-4xl font-bold tracking-[0.2em]">
          {p.code.slice(0, 3)} {p.code.slice(3)}
        </div>
        <div className="text-xs text-muted-foreground">在手机上输入这 6 位数字完成配对</div>
        <div className="text-[11px] text-muted-foreground">剩余 {mmss}</div>
        <Button variant="outline" className="mt-auto w-full" onClick={close}>
          取消
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center gap-2.5 text-center">
      <div className="text-sm font-semibold">用 PhoneToDesktop 扫码配对</div>
      <div className="flex h-[150px] w-[150px] items-center justify-center rounded-lg border border-border bg-white p-1.5">
        {qr ? <img src={qr} alt="配对二维码" className="h-full w-full" /> : <Spinner />}
      </div>
      <div className="text-xs text-muted-foreground">或在手机「设备 → 添加电脑」里输入：</div>
      <div className="flex flex-wrap justify-center gap-1.5">
        {(lan.addrs ?? []).slice(0, 3).map((a) => (
          <Kbd key={a}>{a}</Kbd>
        ))}
      </div>
      <div className="text-[11px] text-muted-foreground">手机和电脑需要在同一个 WiFi / 局域网 · 剩余 {mmss}</div>
      <Button variant="outline" className="mt-auto w-full" onClick={close}>
        取消
      </Button>
    </div>
  );
}
