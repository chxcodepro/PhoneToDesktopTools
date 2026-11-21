// 电脑端 Core 状态接口（GET /api/status）的数据结构，与 desktop/core/internal/server、internal/adb 保持一致。

export type DeviceStage =
  | 'unauthorized'
  | 'offline'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'suppressed'
  | 'error'
  | '';

export interface CoreDevice {
  /** adb 序列号；WiFi 通道是 ip:port */
  serial: string;
  /** 手机硬件序列号，USB 和 WiFi 通道相同；会话的 serial 就是它 */
  id?: string;
  transport?: 'usb' | 'wifi';
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
  devices?: CoreDevice[];
  lan?: CoreLan;
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
}

/** preload 暴露给页面的接口 */
export interface P2DApi {
  getStatus(): Promise<AppStatus>;
  onStatus(cb: (s: AppStatus) => void): () => void;
  disconnect(): Promise<void>;
  minimize(): void;
  hide(): void;
  setOverlayInteractive(interactive: boolean): void;
  /** 打开「配对新手机」窗口（3 分钟） */
  startPairing(): Promise<void>;
  cancelPairing(): Promise<void>;
  /** 取消与某部手机的配对 */
  removePaired(id: string): Promise<void>;
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
