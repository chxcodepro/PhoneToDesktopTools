// 电脑端主窗口：等待连接 → 正在连接 → 已连接
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  Circle,
  ExternalLink,
  FileDown,
  Github,
  Info,
  Minus,
  Monitor,
  OctagonX,
  Plug,
  QrCode,
  RefreshCw,
  Smartphone,
  Trash2,
  Wifi,
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Kbd, Spinner } from '@/components/ui';
import { cn, formatDuration, platformLabel } from '@/lib/utils';
import { deviceNameFor, type AboutInfo, type AppStatus, type CoreDevice, type CoreLan } from '../shared/types';

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
  const [manualCheck, setManualCheck] = useState(false);
  const [aboutView, setAboutView] = useState(false);
  const checkNow = () => {
    setManualCheck(true);
    void window.p2d.checkUpdate();
  };

  let body: JSX.Element;
  if (aboutView) body = <About s={s} onCheck={checkNow} onClose={() => setAboutView(false)} />;
  else if (pairingView && lan?.enabled) body = <Pairing lan={lan} onClose={() => setPairingView(false)} />;
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
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-5">
        <UpdateBanner u={s.update} manual={manualCheck} onClose={() => setManualCheck(false)} />
        {body}
      </div>
      <footer className="flex h-10 shrink-0 items-center justify-between border-t border-border px-3.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Monitor className="h-3 w-3" />
          {st?.hostname ?? '本机'}
        </span>
        {s.autostart?.supported ? (
          <label className="flex cursor-pointer items-center gap-1.5 hover:text-foreground">
            <input
              type="checkbox"
              className="h-3 w-3 accent-primary"
              checked={s.autostart.enabled}
              onChange={(e) => void window.p2d.setAutostart(e.target.checked)}
            />
            开机自启
          </label>
        ) : null}
        <button
          className={cn(
            'flex h-6 items-center gap-1 rounded-md border border-border px-2 text-foreground hover:bg-accent',
            aboutView && 'bg-accent',
          )}
          title={`v${s.update?.current ?? ''} · 检查更新、导出日志、项目主页`}
          onClick={() => setAboutView((v) => !v)}
        >
          <Info className="h-3 w-3" />
          关于
        </button>
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
        <span className="text-[13px] font-semibold">p2d</span>
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

/** 检查更新的结果。有新版本时总是显示；已是最新、检查失败只在手动检查后显示 */
function UpdateBanner({ u, manual, onClose }: { u?: AppStatus['update']; manual: boolean; onClose: () => void }) {
  const [hidden, setHidden] = useState('');
  const [opened, setOpened] = useState(false);
  if (!u) return null;
  const show = u.state === 'available' ? hidden !== u.latest || manual : manual && u.state !== 'idle';
  if (!show) return null;
  const close = () => {
    setHidden(u.latest ?? '');
    onClose();
  };
  let content: JSX.Element;
  if (u.state === 'checking')
    content = (
      <span className="flex items-center gap-1.5">
        <Spinner className="h-3 w-3" />
        正在检查更新…
      </span>
    );
  else if (u.state === 'latest') content = <span>已是最新版本（v{u.current}）</span>;
  else if (u.state === 'error') content = <span className="text-destructive">{u.message}</span>;
  else
    content = (
      <div className="flex flex-col gap-2">
        <span className="font-medium text-foreground">
          发现新版本 v{u.latest}（当前 v{u.current}）
        </span>
        {opened ? <span>已在浏览器中打开下载。{u.hint}</span> : null}
        {!u.url ? <span>没有找到这台电脑对应的安装包，将打开发布页面自行选择。</span> : null}
        <Button
          size="sm"
          className="self-start"
          onClick={() => {
            window.p2d.openUpdate();
            setOpened(true);
          }}
        >
          {u.url ? '下载新版本' : '打开发布页面'}
        </Button>
      </div>
    );
  return (
    <Card className="flex items-start gap-2.5 p-3 text-xs text-muted-foreground">
      <ArrowUpCircle className="mt-px h-3.5 w-3.5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">{content}</div>
      {u.state !== 'checking' ? (
        <button aria-label="关闭" className="text-muted-foreground hover:text-foreground" onClick={close}>
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </Card>
  );
}

/** 关于：版本、检查更新、导出日志、项目主页 */
function About({ s, onCheck, onClose }: { s: AppStatus; onCheck: () => void; onClose: () => void }) {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    void window.p2d.about().then(setInfo);
  }, []);
  const doExport = () => {
    setExporting(true);
    setResult(null);
    void window.p2d
      .exportLogs()
      .then((r) => {
        if (r.ok) setResult({ ok: true, text: `已保存到 ${r.path}` });
        else if (r.message) setResult({ ok: false, text: r.message });
      })
      .finally(() => setExporting(false));
  };
  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="flex flex-col items-center gap-1 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-white">
          <Smartphone className="h-5 w-5" strokeWidth={2.25} />
        </div>
        <div className="text-base font-semibold">p2d 电脑端</div>
        <div className="text-xs text-muted-foreground">
          {info ? `v${info.version} · ${platformLabel(s.status?.os, s.status?.arch)}` : ' '}
        </div>
      </div>
      <Card className="overflow-hidden">
        <Row
          icon={<RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />}
          label="检查更新"
          right={
            <Button size="sm" variant="outline" disabled={s.update?.state === 'checking'} onClick={onCheck}>
              {s.update?.state === 'checking' ? <Spinner className="h-3 w-3" /> : null}
              检查
            </Button>
          }
        />
        {sep}
        <Row
          icon={<FileDown className="h-3.5 w-3.5 text-muted-foreground" />}
          label="导出日志"
          right={
            <Button size="sm" variant="outline" disabled={exporting} onClick={doExport}>
              {exporting ? <Spinner className="h-3 w-3" /> : null}
              导出
            </Button>
          }
        />
        {result ? (
          <div className={cn('break-all px-3 pb-2.5 text-[11px]', result.ok ? 'text-muted-foreground' : 'text-destructive')}>{result.text}</div>
        ) : null}
        {sep}
        <button className="block w-full text-left hover:bg-accent" title={info?.repoUrl} onClick={() => window.p2d.openRepo()}>
          <Row
            icon={<Github className="h-3.5 w-3.5 text-muted-foreground" />}
            label="项目主页"
            right={
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                GitHub
                <ExternalLink className="h-3 w-3" />
              </span>
            }
          />
        </button>
      </Card>
      <div className="px-1 text-[11px] leading-relaxed text-muted-foreground">
        出了问题时导出日志，连同问题描述发到项目主页的 Issues。日志不含配对令牌和配对码。
      </div>
      <Button variant="outline" className="mt-auto w-full" onClick={onClose}>
        返回
      </Button>
    </div>
  );
}

/** 需要管理员权限的一键修复：执行中、失败原因 */
function useFix(run: () => Promise<{ ok: boolean; message?: string }>, failed: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = () => {
    setBusy(true);
    setError('');
    void run()
      .then((r) => setError(r.ok ? '' : (r.message ?? failed)))
      .finally(() => setBusy(false));
  };
  return { busy, error, start };
}

/** 插上了手机，但 ADB 接口还没有驱动（Win7 常见）：一键安装 */
function DriverMissing({ names }: { names: string[] }) {
  const { busy: installing, error, start: install } = useFix(() => window.p2d.installDriver(), '驱动安装失败');
  return (
    <div className="pb-2.5">
      <Row icon={warn} label="Android 驱动" right={<Badge variant="warning">缺少驱动</Badge>} />
      <div className="flex flex-col gap-2 px-3 pl-9 text-xs text-muted-foreground">
        <span>
          已插上手机{names[0] ? `「${names[0]}」` : ''}，需要安装 USB 驱动才能用数据线连接。
        </span>
        {installing ? (
          <span className="flex items-start gap-1.5 text-foreground">
            <Spinner className="mt-0.5 h-3 w-3 shrink-0" />
            <span>正在安装：请在弹出的窗口中点「是」；提示无法验证发布者时，点「始终安装此驱动程序软件」</span>
          </span>
        ) : (
          <Button size="sm" className="self-start" onClick={install}>
            安装驱动
          </Button>
        )}
        {error ? <span className="text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}

/** 银河麒麟的防火墙默认拒绝所有入站连接，手机无法通过 WiFi 连接：一键放行 */
function LanBlocked({ addr }: { addr?: string }) {
  const { busy, error, start } = useFix(() => window.p2d.allowFirewall(), '放行失败');
  return (
    <div className="pb-2.5">
      <Row icon={warn} label="WiFi 直连" right={<Badge variant="warning">被防火墙拦截</Badge>} />
      <div className="flex flex-col gap-2 px-3 pl-9 text-xs text-muted-foreground">
        <span>系统防火墙会挡住手机通过 WiFi 连接{addr ? `（${addr}）` : ''}，数据线连接不受影响。</span>
        {busy ? (
          <span className="flex items-start gap-1.5 text-foreground">
            <Spinner className="mt-0.5 h-3 w-3 shrink-0" />
            <span>请在弹出的窗口中输入当前用户的密码</span>
          </span>
        ) : (
          <Button size="sm" className="self-start" onClick={start}>
            放行
          </Button>
        )}
        {error ? <span className="text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}

/** 插着一台没开 USB 调试的手机（Linux）：点一下免调试连接，以后这台手机插上就自动连 */
function AoaCandidate({ device }: { device: CoreDevice }) {
  const { busy, error, start } = useFix(() => window.p2d.aoaConnect(device.id || device.serial), '连接失败');
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2.5 text-[13px]">
        <Smartphone className="h-3.5 w-3.5 text-primary" />
        <span className="flex-1 truncate font-medium">{device.model || '安卓手机'}</span>
        <Badge variant="muted">未开 USB 调试</Badge>
      </div>
      {device.message ? <span className="pl-6 text-xs text-muted-foreground">{device.message}</span> : null}
      <Button size="sm" className="ml-6 self-start" disabled={busy} onClick={start}>
        {busy ? <Spinner className="h-3 w-3" /> : <Plug className="h-3.5 w-3.5" />}
        免调试连接
      </Button>
      {error ? <span className="pl-6 text-xs text-destructive">{error}</span> : null}
    </Card>
  );
}

function Waiting({ s, onPair }: { s: AppStatus; onPair: () => void }) {
  const adb = s.status?.adbAvailable;
  const lan = s.status?.lan;
  const aoa = s.status?.aoa;
  const candidates = s.status?.devices?.filter((d) => d.transport === 'aoa' && d.stage === 'available') ?? [];
  const [showPaired, setShowPaired] = useState(false);
  const paired = lan?.paired ?? [];
  return (
    <>
      <Hero animated />
      <div className="text-center text-lg font-bold">{s.coreOnline ? '等待手机连接' : '正在启动服务…'}</div>
      {!s.coreOnline && s.coreError && <div className="text-center text-xs text-destructive">{s.coreError}</div>}
      {candidates.map((d) => (
        <AoaCandidate key={d.serial} device={d} />
      ))}
      <Card className="mt-auto">
        {s.status?.driverMissing?.length ? (
          <DriverMissing names={s.status.driverMissing.map((d) => d.name)} />
        ) : (
          <Row
            icon={adb ? ok : warn}
            label="Android 驱动"
            right={adb ? <Badge variant="success">就绪</Badge> : <Badge variant="warning">未就绪</Badge>}
          />
        )}
        {!adb && s.status?.adbError ? (
          <div className="line-clamp-3 break-all px-3 pb-2.5 pl-9 text-xs text-warning-foreground">{s.status.adbError.replace(/（adb .*$/, '')}</div>
        ) : null}
        {aoa?.enabled ? (
          <>
            {sep}
            <Row
              icon={aoa.problem ? warn : ok}
              label="免调试连接"
              right={aoa.problem ? <Badge variant="warning">不可用</Badge> : <Badge variant="success">就绪</Badge>}
            />
          </>
        ) : null}
        {sep}
        <Row icon={warn} label="iPhone 驱动" right={<Badge variant="muted">暂不支持</Badge>} />
        {sep}
        {lan?.enabled && s.status?.lanBlocked ? (
          <LanBlocked addr={lan.addrs?.[0]} />
        ) : (
          <Row
            icon={lan?.enabled ? ok : warn}
            label="WiFi 直连"
            right={lan?.enabled ? (lan.addrs?.find((a) => a !== lan.tailscale) ?? lan.addrs?.[0] ?? '无局域网地址') : <Badge variant="warning">未开启</Badge>}
          />
        )}
        {lan?.enabled && lan.tailscale ? (
          <>
            {sep}
            <Row icon={ok} label="Tailscale 远程" right={lan.tailscale} />
          </>
        ) : null}
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

/** 免调试连接：电脑没法给手机装 App、也没法拉起它，要用户在手机上点确认打开 */
function ConnectingAoa({ device }: { device: CoreDevice }) {
  const stage = device.stage;
  const opened = stage === 'ready';
  return (
    <>
      <Hero animated />
      <div className="text-center text-lg font-bold">正在连接 {device.model || '手机'}</div>
      <Card className="mt-auto">
        <Row icon={ok} label="检测到手机（免调试连接）" />
        {sep}
        <Row icon={opened ? ok : stage === 'starting' ? <Spinner /> : pending} label="在手机上打开 App" />
        {stage === 'starting' && device.message ? (
          <div className="px-3 pb-2.5 pl-9 text-xs text-muted-foreground">{device.message}</div>
        ) : null}
        {sep}
        <Row icon={opened ? <Spinner /> : pending} label="启动并连接" muted={!opened} />
      </Card>
      {stage === 'error' && device.message && <div className="text-center text-xs text-destructive">{device.message}</div>}
    </>
  );
}

function Connecting({ device }: { device: CoreDevice }) {
  if (device.transport === 'aoa') return <ConnectingAoa device={device} />;
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
      <div className="text-sm font-semibold">用 p2d 手机端扫码配对</div>
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
