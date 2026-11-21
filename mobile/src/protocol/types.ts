// 协议相关类型，对应 docs/PROTOCOL.md。本文件不依赖 React Native，可在 Node 中使用。

/** 默认端口（adb reverse 的端口） */
export const DEFAULT_PORT = 39271;

/** MCP 协议版本 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** 连接状态 */
export type ConnectionStatus =
  | 'idle' // 尚未开始连接
  | 'connecting' // 正在建立 WebSocket / 握手
  | 'connected' // 握手完成，可以调用工具
  | 'disconnected' // 已断开（会自动重连，除非是用户主动断开）
  | 'unauthorized'; // 令牌无效（HTTP 401），需要重新插拔数据线

/** 权限级别（第 3 节） */
export type PermissionLevel = 'readonly' | 'standard' | 'full';

/** p2d/setPermissions 的参数 */
export interface Permissions {
  level: PermissionLevel;
  shell: boolean;
  fs: boolean;
  screen: boolean;
  input: boolean;
}

export const DEFAULT_PERMISSIONS: Permissions = {
  level: 'standard',
  shell: true,
  fs: true,
  screen: true,
  input: true,
};

/** tools/list 返回的工具信息 */
export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** tools/call 返回的内容块 */
export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/** tools/call 的结果 */
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/** initialize 返回的服务端信息 */
export interface ServerInfo {
  name: string;
  version?: string;
}

/** JSON-RPC 2.0 消息 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

/** 从 Deep Link 解析出的连接参数 */
export interface ConnectParams {
  token: string;
  host: string;
  os: string;
  port: number;
  /** 电脑标识（用来关联「设备」里的记录，局域网直连也用它） */
  pcId?: string;
}

/** 局域网直连的端口（电脑端默认） */
export const DEFAULT_LAN_PORT = 39272;
