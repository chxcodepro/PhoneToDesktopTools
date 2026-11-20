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
  serial: string;
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
}

/** 根据会话的序列号找设备名 */
export function deviceNameFor(status: CoreStatus | undefined, serial: string): string {
  if (serial === 'dev') return '调试设备';
  const d = status?.devices?.find((x) => x.serial === serial);
  return d?.model || serial;
}
