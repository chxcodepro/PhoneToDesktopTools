// 连接管理：收到 Deep Link 后自动连接电脑，维护连接状态、工具清单、权限和「连过的电脑」。

import * as SecureStore from 'expo-secure-store';

import { buildWsUrl, parseConnectUrl } from '@/protocol/deepLink';
import { McpClient } from '@/protocol/mcpClient';
import {
  DEFAULT_PERMISSIONS,
  type ConnectionStatus,
  type ConnectParams,
  type Permissions,
  type ServerInfo,
  type ToolInfo,
} from '@/protocol/types';

import { loadJson, saveJson, StorageKeys } from './storage';
import { createStore, useStore } from './store';

export interface KnownComputer {
  host: string;
  os: string;
  lastConnectedAt: number;
}

export interface ConnectionState {
  status: ConnectionStatus;
  /** 状态补充说明（如 401 时的提示） */
  detail?: string;
  /** 当前连接参数（来自 Deep Link） */
  params: ConnectParams | null;
  serverInfo: ServerInfo | null;
  tools: ToolInfo[];
  permissions: Permissions;
  knownComputers: KnownComputer[];
  /** 本地数据是否已加载 */
  ready: boolean;
}

export const connectionStore = createStore<ConnectionState>({
  status: 'idle',
  params: null,
  serverInfo: null,
  tools: [],
  permissions: DEFAULT_PERMISSIONS,
  knownComputers: [],
  ready: false,
});

let client: McpClient | null = null;
let initPromise: Promise<void> | null = null;

// 最近一次的连接参数（含令牌）。App 被系统回收或更新后重新打开时，用它自动重连。
// 令牌只在本次插线期间有效，拔线后电脑会拒绝（401），那时就清掉。
const LAST_CONNECT_KEY = 'p2d.lastConnect';
const LAST_CONNECT_MAX_AGE = 24 * 60 * 60 * 1000;

async function saveLastConnect(params: ConnectParams | null): Promise<void> {
  try {
    if (params) await SecureStore.setItemAsync(LAST_CONNECT_KEY, JSON.stringify({ ...params, savedAt: Date.now() }));
    else await SecureStore.deleteItemAsync(LAST_CONNECT_KEY);
  } catch (e) {
    if (__DEV__) console.warn('保存连接参数失败', e);
  }
}

async function loadLastConnect(): Promise<ConnectParams | null> {
  try {
    const raw = await SecureStore.getItemAsync(LAST_CONNECT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as ConnectParams & { savedAt?: number };
    if (!v.token || !v.savedAt || Date.now() - v.savedAt > LAST_CONNECT_MAX_AGE) return null;
    return { token: v.token, host: v.host, os: v.os, port: v.port };
  } catch {
    return null;
  }
}

/** 加载本地保存的权限和连过的电脑（只执行一次） */
export function initConnection(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const [permissions, knownComputers] = await Promise.all([
        loadJson<Permissions>(StorageKeys.permissions, DEFAULT_PERMISSIONS),
        loadJson<KnownComputer[]>(StorageKeys.knownComputers, []),
      ]);
      connectionStore.set({ permissions: { ...DEFAULT_PERMISSIONS, ...permissions }, knownComputers, ready: true });
      // 冷启动且没有收到新的 Deep Link：尝试用上次的令牌重连
      if (!client) {
        const last = await loadLastConnect();
        if (last && !client) connectWith(last);
      }
    })();
  }
  return initPromise;
}

/** 处理任意 URL：是连接 Deep Link 就自动连接 */
export function handleIncomingUrl(url: string | null | undefined): boolean {
  const params = parseConnectUrl(url);
  if (!params) return false;
  connectWith(params);
  return true;
}

/** 用 Deep Link 参数连接电脑（同一令牌重复调用会被忽略） */
export function connectWith(params: ConnectParams): void {
  const cur = connectionStore.get();
  if (client && cur.params?.token === params.token && cur.status !== 'unauthorized') return;

  client?.close();
  connectionStore.set({ params, status: 'connecting', detail: undefined, serverInfo: null, tools: [] });

  const c = new McpClient({
    url: buildWsUrl(params),
    onConnected: async (mc) => {
      // 每次（重新）连接后：先同步权限，再刷新工具清单
      await mc.setPermissions(connectionStore.get().permissions);
      const tools = await mc.listTools();
      connectionStore.set({ serverInfo: mc.serverInfo, tools });
      await rememberComputer(params);
    },
    onLog: __DEV__ ? (m) => console.log('[mcp]', m) : undefined,
  });
  c.onStatus((status, detail) => {
    if (client !== c) return;
    connectionStore.set({ status, detail });
    if (status === 'connected') void saveLastConnect(params);
    if (status === 'unauthorized') void saveLastConnect(null);
  });
  client = c;
  c.connect();
}

/** 用户主动断开 */
export function disconnect(): void {
  client?.close();
  client = null;
  void saveLastConnect(null);
  connectionStore.set({ status: 'idle', detail: undefined, params: null, serverInfo: null, tools: [] });
}

/** 当前 MCP 客户端（已连接时可用） */
export function getClient(): McpClient | null {
  return client && client.status === 'connected' ? client : null;
}

/** 修改权限：持久化，已连接时立即同步到电脑 */
export async function updatePermissions(patch: Partial<Permissions>): Promise<void> {
  const permissions = { ...connectionStore.get().permissions, ...patch };
  connectionStore.set({ permissions });
  await saveJson(StorageKeys.permissions, permissions);
  const c = getClient();
  if (c) {
    try {
      await c.setPermissions(permissions);
    } catch (e) {
      if (__DEV__) console.warn('同步权限失败', e);
    }
  }
}

/** 重新拉取工具清单 */
export async function refreshTools(): Promise<ToolInfo[]> {
  const c = getClient();
  if (!c) return [];
  const tools = await c.listTools();
  connectionStore.set({ tools });
  return tools;
}

async function rememberComputer(params: ConnectParams): Promise<void> {
  const list = connectionStore.get().knownComputers.filter((k) => k.host !== params.host);
  const next = [{ host: params.host, os: params.os, lastConnectedAt: Date.now() }, ...list].slice(0, 20);
  connectionStore.set({ knownComputers: next });
  await saveJson(StorageKeys.knownComputers, next);
}

export function useConnection(): ConnectionState {
  return useStore(connectionStore);
}

/** 系统名显示 */
export function osLabel(os: string): string {
  switch (os) {
    case 'windows':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return os || '未知系统';
  }
}
