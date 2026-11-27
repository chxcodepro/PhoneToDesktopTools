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
