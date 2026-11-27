// 电脑端 Core 状态接口（GET /api/status）的数据结构，与 desktop/core/internal/server、internal/adb 保持一致。

export type DeviceStage =
  /** 免调试连接：插着一台没开 USB 调试的手机，点「免调试连接」后连接 */
  | 'available'
  | 'unauthorized'
  | 'offline'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'suppressed'
  | 'error'
  | '';

export interface CoreDevice {
  /** USB 序列号（和 adb devices 相同）；经 adb 服务的 WiFi 通道是 ip:port；免调试连接是 aoa:<USB 插口> */
  serial: string;
  /** 手机硬件序列号，USB 和 WiFi 通道相同；会话的 serial 就是它 */
  id?: string;
  /** aoa：免调试连接（Android 配件模式，不需要 USB 调试，仅 Linux）；usbmux：iPhone 数据线（经系统的 usbmuxd） */
  transport?: 'usb' | 'wifi' | 'aoa' | 'usbmux';
  /** ios：iPhone / iPad */
  platform?: 'ios';
  model: string;
  state: string;
  stage: DeviceStage;
  message?: string;
}

export interface CorePermissions {
  level: 'readonly' | 'standard' | 'full';
  shell: boolean;
  fs: boolean;
  screen: boolean;
  input: boolean;
}

export interface CoreSession {
  id: number;
  serial: string;
  client: string;
  connectedAt: string;
  permissions: CorePermissions;
  /** usb：数据线（adb 隧道）；wifi：局域网直连 */
  route?: 'usb' | 'wifi';
  /** 手机名（局域网直连时来自配对记录） */
  name?: string;
}

export interface CorePairing {
  active: boolean;
  /** waiting：等手机连接；code：显示配对码；done：刚配对成功 */
  state?: 'waiting' | 'code' | 'done' | '';
  code?: string;
  phoneName?: string;
  expiresAt?: string;
  /** 二维码内容（p2d://pair?...） */
  qr?: string;
}

export interface CorePairedPhone {
  id: string;
  name: string;
  pairedAt: string;
  lastSeen?: string;
}

export interface CoreLan {
  enabled: boolean;
  port?: number;
  addrs?: string[];
  /** Tailscale 虚拟局域网的地址（100.64.0.0/10），装了 Tailscale 才有 */
  tailscale?: string;
  pcId?: string;
  pairing?: CorePairing;
  paired?: CorePairedPhone[];
}

export interface CoreStatus {
  version: string;
  hostname: string;
  os: string;
  arch: string;
  uptime: number;
  sessions: CoreSession[];
  adbAvailable?: boolean;
  /** 不能经数据线连接开了 USB 调试的手机的原因（如读不到 USB 设备） */
  adbError?: string;
  /** 免调试连接（Linux）：开启时有；problem 是读不到 USB 设备的原因 */
  aoa?: { enabled: boolean; problem?: string };
  /** iPhone 数据线连接：开启时有；problem 是不能连接的原因（如 Windows 没装「Apple 设备」、Linux 没装 usbmuxd） */
  iphone?: { enabled: boolean; problem?: string };
  /** 已插上但还没装 USB 驱动的手机（Windows） */
  driverMissing?: { name: string; instanceId: string }[];
  /** 系统防火墙会挡住手机通过 WiFi 连接（银河麒麟） */
  lanBlocked?: boolean;
  devices?: CoreDevice[];
  lan?: CoreLan;
  /** 锁屏远程支持（Windows）：系统服务登记了没有、在不在运行、电脑端连没连上锁屏助手 */
  secureDesktop?: { supported: boolean; installed: boolean; running: boolean; connected: boolean; problem?: string };
}

/** 主进程推送给渲染进程的状态 */
export interface AppStatus {
  /** Core 是否可达 */
  coreOnline: boolean;
  /** Core 启动失败等错误 */
  coreError?: string;
  status?: CoreStatus;
  /** 正在控制电脑的设备名（无会话时为空） */
  controllerName?: string;
  /** 实际注册成功的断开热键，例如 ["Ctrl","Alt","Q"]；全部被占用时为空 */
  hotkey?: string[];
  /** 开机自动启动：是否支持（开发模式不支持）、是否开启 */
  autostart?: { supported: boolean; enabled: boolean };
  update?: UpdateInfo;
  /** Mac：P2D 有没有「辅助功能」（键鼠控制）和「屏幕录制」（截图、远程桌面）权限；其他系统没有这项 */
  macPermissions?: { accessibility: boolean; screen: boolean };
}

/** 检查更新的结果 */
export interface UpdateInfo {
  /** idle：还没检查；latest：已是最新；available：有新版本 */
  state: 'idle' | 'checking' | 'latest' | 'available' | 'error';
  /** 当前版本 */
  current: string;
  latest?: string;
  /** 本机对应安装包的下载地址（找不到时为空，只能打开发布页） */
  url?: string;
  file?: string;
  /** 发布页 */
  page?: string;
  /** 下载后怎么安装 */
  hint?: string;
  message?: string;
}

/** 「关于」页面显示的信息 */
export interface AboutInfo {
  version: string;
  platform: string;
  arch: string;
  osRelease: string;
  electron: string;
  /** 项目主页（GitHub） */
  repoUrl: string;
}

/** preload 暴露给页面的接口 */
export interface P2DApi {
  getStatus(): Promise<AppStatus>;
  onStatus(cb: (s: AppStatus) => void): () => void;
  disconnect(): Promise<void>;
  minimize(): void;
  hide(): void;
  /** 主窗口按内容调高（页面内容的总高度，CSS 像素） */
  fitHeight(height: number): void;
  setOverlayInteractive(interactive: boolean): void;
  /** 打开「配对新手机」窗口（3 分钟） */
  startPairing(): Promise<void>;
  cancelPairing(): Promise<void>;
  /** 取消与某部手机的配对 */
  removePaired(id: string): Promise<void>;
  /** 安装手机 USB 驱动（会弹出管理员确认），装完返回结果 */
  installDriver(): Promise<{ ok: boolean; message?: string }>;
  /** 放行防火墙（会弹出系统的密码框），完成后返回结果 */
  allowFirewall(): Promise<{ ok: boolean; message?: string }>;
  /** 开启 / 关闭锁屏远程支持（会弹出管理员确认），完成后返回结果 */
  setSecureDesktop(on: boolean): Promise<{ ok: boolean; message?: string }>;
  /** 免调试连接一台手机（记住它，以后插上自动连） */
  aoaConnect(id: string): Promise<{ ok: boolean; message?: string }>;
  /** 开启 / 关闭开机自动启动 */
  setAutostart(on: boolean): Promise<void>;
  /** 立即检查更新 */
  checkUpdate(): Promise<UpdateInfo>;
  /** 用浏览器下载新版本（没有本机对应的安装包时打开发布页） */
  openUpdate(): void;
  /** 版本、系统、项目主页 */
  about(): Promise<AboutInfo>;
  /** 用浏览器打开项目主页（GitHub） */
  openRepo(): void;
  /** 选择保存位置后导出日志；用户取消时 ok=false 且没有 message */
  exportLogs(): Promise<{ ok: boolean; path?: string; message?: string }>;
  /** Mac：打开「系统设置 → 隐私与安全性」里对应的权限页面 */
  openMacPrivacy(kind: 'accessibility' | 'screen'): void;
  /** 窗口模式：phone 连接手机，agent 电脑上的 AI 助手 */
  getMode(): Promise<WindowMode>;
  setMode(mode: WindowMode): void;
  /** 助手模式下最大化 / 还原 */
  toggleMaximize(): void;
  agent: AgentBridge;
  /** 电脑端助手的快捷键：设置和生效情况（默认都关着） */
  agentHotkeys(): Promise<HotkeyStatus>;
  /** 保存快捷键设置并重新注册，返回生效情况 */
  setAgentHotkeys(s: HotkeySettings): Promise<HotkeyStatus>;
  /** 助手运行状态：running 运行中（注册停止热键），operating 正在动键鼠（显示紫色边框提示） */
  agentActive(running: boolean, operating: boolean): void;
  /** 停止助手（被控提示上的「停止」按钮） */
  stopAgent(): void;
  /** 框选屏幕提问 */
  captureRegion(): void;
  onAgentEvent(cb: (e: AgentEvent) => void): () => void;
  /** 框选截图窗口：收到截图、返回框选结果（取消为 null） */
  onCaptureImage(cb: (dataUrl: string) => void): () => void;
  captureDone(dataUrl: string | null): void;
}

/** 快捷键：ask 唤起助手，capture 框选屏幕提问，stop 停止助手（只在助手运行时注册） */
export type HotkeyId = 'ask' | 'capture' | 'stop';

export interface HotkeyConfig {
  enabled: boolean;
  /** Electron 快捷键写法，如 Alt+Shift+Space */
  accel: string;
}

export type HotkeySettings = Record<HotkeyId, HotkeyConfig>;

export interface HotkeyState extends HotkeyConfig {
  /** 显示用的写法，如 Ctrl+Alt+X */
  label: string;
  /** 开着且注册成功（停止键：能注册） */
  ok: boolean;
  /** 开着但注册不上的原因 */
  error?: string;
}

export type HotkeyStatus = Record<HotkeyId, HotkeyState>;

export type AgentEvent = { type: 'focus' } | { type: 'image'; dataUrl: string } | { type: 'stop' };

export type WindowMode = 'phone' | 'agent';

/** 网络请求的流式响应（主进程 → 页面） */
export type HttpEvent =
  | { type: 'head'; status: number; headers?: Record<string, string> }
  | { type: 'data'; data: Uint8Array }
  | { type: 'end' }
  | { type: 'error'; message: string; abort?: boolean };

export interface HttpInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Core 的工具列表（GET /api/agent/tools） */
export interface AgentToolsInfo {
  tools: { name: string; description?: string; inputSchema?: unknown }[];
  host: string;
  os: string;
  downloadDir: string;
}

export interface DownloadedFile {
  path: string;
  size: number;
  sha256: string;
  sha1: string;
  signature?: string;
}

/** 电脑端 AI 助手用的主进程接口（见 electron/agent.ts） */
export interface AgentBridge {
  httpStart(id: string, url: string, init: HttpInit): void;
  onHttp(cb: (id: string, e: HttpEvent) => void): () => void;
  /** 取消进行中的网络请求、工具调用或下载 */
  cancel(id: string): void;
  tools(): Promise<AgentToolsInfo>;
  call(id: string, name: string, args: Record<string, unknown>): Promise<unknown>;
  download(id: string, url: string, name: string, dir: string): Promise<DownloadedFile>;
  onDownloadProgress(cb: (id: string, received: number, total: number) => void): () => void;
  config(): Promise<unknown>;
  saveConfig(v: unknown): Promise<void>;
  key(preset: string): Promise<string>;
  setKey(preset: string, key: string): Promise<void>;
  convList(): Promise<unknown[]>;
  convLoad(id: string): Promise<unknown>;
  convSave(id: string, data: unknown, list: unknown[]): Promise<void>;
  convRemove(id: string, list: unknown[]): Promise<void>;
  /** agent/<name>.json：extensions、schedules、settings */
  storeLoad(name: string): Promise<unknown>;
  storeSave(name: string, v: unknown): Promise<void>;
  /** 扩展的令牌（系统加密存储） */
  secretGet(key: string): Promise<string>;
  secretSet(key: string, value: string): Promise<void>;
  /** Skill 文件：写入整个目录（返回目录路径）、读一个文件、删除、取目录路径 */
  skillWrite(id: string, files: { path: string; data: Uint8Array }[]): Promise<string>;
  skillRead(id: string, path: string): Promise<Uint8Array>;
  skillRemove(id: string): Promise<void>;
  skillDir(id: string): Promise<string>;
  /** 电脑上的 stdio MCP（经 Core） */
  mcp(op: 'start' | 'call' | 'stop', payload: Record<string, unknown>, id?: string): Promise<unknown>;
  clipboardRead(): Promise<{ text: string; image?: string }>;
  clipboardWrite(text: string): Promise<void>;
}

/** 会话所在手机当前在线的通道（同一台手机可能同时有 USB 和 WiFi 两条，USB 优先） */
export function deviceFor(status: CoreStatus | undefined, serial: string): CoreDevice | undefined {
  const list = (status?.devices ?? []).filter((x) => x.id === serial || x.serial === serial);
  return list.find((x) => x.state === 'device' && x.transport !== 'wifi') ?? list.find((x) => x.state === 'device') ?? list[0];
}

/** 根据会话的序列号找设备名 */
export function deviceNameFor(status: CoreStatus | undefined, serial: string): string {
  if (serial === 'dev') return '调试设备';
  const named = status?.sessions?.find((s) => s.serial === serial)?.name;
  if (named) return named;
  if (serial.startsWith('lan:')) return status?.lan?.paired?.find((p) => `lan:${p.id}` === serial)?.name || '手机';
  return deviceFor(status, serial)?.model || serial;
}
