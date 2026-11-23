// 连接管理：USB（电脑经 adb 下发 Deep Link）和 WiFi（局域网直连，加密）两种通道。
// - 插数据线：电脑端自动拉起 App 并下发令牌 → 经 adb 隧道连接；连上后自动和这台电脑配对（拿到 WiFi 直连密钥）。
// - WiFi：手机直接连电脑的局域网地址（「设备」里选电脑、扫码或输入 IP 配对后）。
// - 拔掉数据线：自动切到 WiFi（这台电脑配对过时）；插回数据线：自动切回 USB（可在设置里关掉）。
// - 维护连接状态、工具清单、权限，以及当前连的是哪台电脑（每台电脑各自的对话按它区分）。

import * as Linking from 'expo-linking';
import * as SecureStore from 'expo-secure-store';

import { buildWsUrl, parseConnectUrl } from '@/protocol/deepLink';
import { McpClient } from '@/protocol/mcpClient';
import { fromBase64, SecureSocket, type RawSocket } from '@/protocol/secure';
import {
  DEFAULT_PERMISSIONS,
  type ConnectionStatus,
  type ConnectParams,
  type Permissions,
  type ServerInfo,
  type ToolInfo,
} from '@/protocol/types';

import {
  deviceLabel,
  devicesStore,
  forgetPairKey,
  getDevice,
  getPairKey,
  initDevices,
  randomBytes,
  setPairKey,
  upsertDevice,
  type Route,
} from './devices';
import { loadJson, saveJson, StorageKeys } from './storage';
import { createStore, useStore } from './store';

export interface ConnectionState {
  status: ConnectionStatus;
  /** 状态补充说明（如 401 时的提示） */
  detail?: string;
  /** 当前连接参数（USB 来自 Deep Link；WiFi 时 token 为空） */
  params: ConnectParams | null;
  /** 当前通道 */
  route: Route | null;
  /** 当前（或正在连接的）电脑 */
  pcId: string | null;
  /** WiFi 直连时实际连的地址 */
  addr: string | null;
  serverInfo: ServerInfo | null;
  tools: ToolInfo[];
  permissions: Permissions;
  /** 本地数据是否已加载 */
  ready: boolean;
}

export const connectionStore = createStore<ConnectionState>({
  status: 'idle',
  params: null,
  route: null,
  pcId: null,
  addr: null,
  serverInfo: null,
  tools: [],
  permissions: DEFAULT_PERMISSIONS,
  ready: false,
});

let client: McpClient | null = null;
let initPromise: Promise<void> | null = null;
/** 最近一次 USB 的连接参数（含令牌），用于手动切回 USB */
let lastUsb: ConnectParams | null = null;
/** 用户点了「断开」：不自动重连 / 切换 */
let userStopped = false;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
/** 每次发起连接 / 断开加一：WiFi 连接要先探测地址（异步），等它回来时如果已有更新的操作就放弃，免得把新连接顶掉 */
let connectSeq = 0;

// 最近一次 USB 的连接参数（含令牌）。App 被系统回收或更新后重新打开时，用它自动重连。
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
    return { token: v.token, host: v.host, os: v.os, port: v.port, pcId: v.pcId };
  } catch {
    return null;
  }
}

function clientInfo(): { name: string; version: string; deviceId: string; device: string } {
  const d = devicesStore.get();
  return { name: 'p2d-mobile', version: '0.1.0', deviceId: d.phoneId, device: d.phoneName };
}

/** 加载本地保存的权限、设备记录，并自动连接（只执行一次） */
export function initConnection(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const [permissions] = await Promise.all([loadJson<Permissions>(StorageKeys.permissions, DEFAULT_PERMISSIONS), initDevices()]);
      connectionStore.set({ permissions: { ...DEFAULT_PERMISSIONS, ...permissions }, ready: true });
      if (client) return; // 已经收到新的 Deep Link
      // 是电脑端插线拉起的（带新令牌）：交给 Deep Link 处理，不要先用旧令牌连
      const initial = await Linking.getInitialURL().catch(() => null);
      if (parseConnectUrl(initial)) return;
      // 冷启动：先试上次的 USB 令牌（失败会自动切 WiFi），没有就自动连上次用过的电脑
      const last = await loadLastConnect();
      if (client) return;
      if (last) {
        connectWith(last);
        return;
      }
      const recent = devicesStore.get().devices.find((d) => d.paired);
      if (recent) void connectLan(recent.pcId, { manual: false }).catch(() => undefined);
    })();
  }
  return initPromise;
}

/** 处理任意 URL：是连接 Deep Link 就自动连接 */
export function handleIncomingUrl(url: string | null | undefined): boolean {
  const params = parseConnectUrl(url);
  if (!params) return false;
  void initDevices().then(() => connectWith(params));
  return true;
}

function clearFallback(): void {
  if (fallbackTimer) clearTimeout(fallbackTimer);
  fallbackTimer = null;
}

/** 换掉当前客户端 */
function replaceClient(next: McpClient | null): void {
  clearFallback();
  const old = client;
  client = next;
  old?.close();
}

/** USB 断开（拔线 / 令牌失效）后切到 WiFi：只在这台电脑配对过、用户没点断开时 */
function scheduleFallback(c: McpClient, pcId: string | undefined, delayMs: number): void {
  if (!pcId || userStopped || fallbackTimer) return;
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null;
    if (client !== c || userStopped || connectionStore.get().status === 'connected') return;
    if (!getDevice(pcId)?.paired) return;
    void connectLan(pcId, { manual: false }).catch((e) => {
      if (client === c) connectionStore.set({ detail: `数据线已断开，WiFi 也没连上：${e instanceof Error ? e.message : String(e)}` });
    });
  }, delayMs);
}

/** 用 Deep Link 参数经 USB 连接电脑（同一令牌重复调用会被忽略） */
export function connectWith(params: ConnectParams): void {
  lastUsb = params;
  const cur = connectionStore.get();
  if (client && cur.route === 'usb' && cur.params?.token === params.token && cur.status !== 'unauthorized') return;
  // 正在用 WiFi 连同一台电脑、且设置了不自动切 USB：只记下令牌，不切换
  if (client && cur.route === 'wifi' && cur.status === 'connected' && cur.pcId && cur.pcId === params.pcId && !devicesStore.get().preferUsb)
    return;
  userStopped = false;
  connectSeq++;

  connectionStore.set({
    params,
    route: 'usb',
    pcId: params.pcId ?? null,
    addr: null,
    status: 'connecting',
    detail: undefined,
    serverInfo: null,
    tools: [],
  });
  const c = new McpClient({
    url: buildWsUrl(params),
    clientInfo: clientInfo(),
    onConnected: async (mc) => {
      // 每次（重新）连接后：先同步权限，再刷新工具清单，再同步电脑信息 / 自动配对
      await mc.setPermissions(connectionStore.get().permissions);
      const tools = await mc.listTools();
      connectionStore.set({ serverInfo: mc.serverInfo, tools });
      await syncPcOverUsb(mc, params);
    },
    onLog: __DEV__ ? (m) => console.log('[mcp]', m) : undefined,
  });
  // 这条 USB 连接是否连上过：刚被电脑端拉起时（如刚装完 / 更新完 App）头几次连接可能失败，多等一会儿再切 WiFi
  let everConnected = false;
  c.onStatus((status, detail) => {
    if (client !== c) return;
    connectionStore.set({ status, detail });
    if (status === 'connected') {
      everConnected = true;
      clearFallback();
      void saveLastConnect(params);
    }
    if (status === 'unauthorized') {
      void saveLastConnect(null);
      scheduleFallback(c, connectionStore.get().pcId ?? params.pcId, 300);
    }
    if (status === 'disconnected') scheduleFallback(c, connectionStore.get().pcId ?? params.pcId, everConnected ? 3000 : 12_000);
  });
  replaceClient(c);
  c.connect();
}

/** USB 连上后：记下电脑信息（含局域网地址），没配对过就自动配对 */
async function syncPcOverUsb(mc: McpClient, params: ConnectParams): Promise<void> {
  const d = devicesStore.get();
  try {
    const info = (await mc.request('p2d/pc.info', { phone: d.phoneId }, 10_000)) as {
      pc: string;
      mid?: string;
      name: string;
      os: string;
      addrs?: string[];
      port?: number;
      paired?: boolean;
    };
    if (!info?.pc) return;
    upsertDevice({
      pcId: info.pc,
      mid: typeof info.mid === 'string' && info.mid ? info.mid : undefined,
      name: info.name,
      os: info.os,
      addrs: info.addrs ?? [],
      port: info.port || 0,
      lastConnectedAt: Date.now(),
      lastRoute: 'usb',
    });
    if (lastUsb === params) lastUsb = { ...params, pcId: info.pc };
    if (client && connectionStore.get().route === 'usb') connectionStore.set({ pcId: info.pc });
    const haveKey = !!(await getPairKey(info.pc));
    if (!info.paired || !haveKey) {
      const r = (await mc.request('p2d/pair.issue', { phone: d.phoneId, name: d.phoneName }, 10_000)) as { key?: string };
      if (r?.key) await setPairKey(info.pc, fromBase64(r.key));
    }
  } catch (e) {
    // 旧版电脑端没有这些方法，或没开局域网直连：不影响 USB 使用
    if (__DEV__) console.log('同步电脑信息失败', e);
  }
}

/** Tailscale 虚拟局域网的地址（100.64.0.0/10）：可能经中继服务器转发，第一次握手比局域网慢 */
export function isTailscaleAddr(a: string): boolean {
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(a);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/** 探测哪个地址能连上（同时试，先通先用）；返回地址。Tailscale 地址多等一会 */
export async function findReachable(addrs: string[], port: number, pcId: string, timeoutMs = 2500): Promise<string> {
  const list = [...new Set(addrs.filter(Boolean))];
  if (!list.length) throw new Error('不知道这台电脑的局域网地址，请插一次数据线或重新配对');
  return new Promise<string>((resolve, reject) => {
    let left = list.length;
    let done = false;
    const ctls: AbortController[] = [];
    const finish = (addr: string | null) => {
      if (done) return;
      if (addr) {
        done = true;
        ctls.forEach((c) => c.abort());
        resolve(addr);
      } else if (--left === 0) {
        done = true;
        reject(
          new Error(
            '连不上电脑：请确认电脑端已打开、手机和电脑在同一个 WiFi / 局域网（或者都连着同一个 Tailscale），并且电脑防火墙允许了 PhoneToDesktop。' +
              '手机开着 VPN / 代理（如 NekoBox、Clash）时，要在其中打开「绕过局域网」，或把 PhoneToDesktop 设为不走代理。',
          ),
        );
      }
    };
    for (const a of list) {
      const ctl = new AbortController();
      ctls.push(ctl);
      const timer = setTimeout(() => ctl.abort(), isTailscaleAddr(a) ? Math.max(timeoutMs, 6000) : timeoutMs);
      const host = a.includes(':') ? `[${a}]` : a;
      fetch(`http://${host}:${port}/p2d/ping`, { signal: ctl.signal })
        .then((r) => r.json() as Promise<{ app?: string; pc?: string }>)
        .then((j) => finish(j?.app === 'p2d' && (!pcId || j.pc === pcId) ? a : null))
        .catch(() => finish(null))
        .finally(() => clearTimeout(timer));
    }
  });
}

/** WiFi 直连一台配对过的电脑。manual：用户手动点的（电脑端点过「断开」后只接受手动连接） */
export async function connectLan(pcId: string, opts: { manual: boolean; addrs?: string[] }): Promise<void> {
  await initDevices();
  const dev = getDevice(pcId);
  if (!dev) throw new Error('没有这台电脑的记录');
  const key = await getPairKey(pcId);
  if (!key) throw new Error('还没有和这台电脑配对：插一次数据线，或在电脑端点「配对新手机」后扫码 / 输入配对码');
  if (opts.manual) userStopped = false;
  const cur = connectionStore.get();
  if (client && cur.route === 'wifi' && cur.pcId === pcId && cur.status === 'connected') return;
  const seq = ++connectSeq;
  if (!client || cur.status !== 'connected') connectionStore.set({ pcId, status: 'connecting', detail: '正在通过 WiFi 连接…' });

  const addr = await findReachable([...(opts.addrs ?? []), dev.lastAddr ?? '', ...dev.addrs], dev.port, pcId);
  // 探测期间用户点了断开，或者插线 / 切换了别的连接：放弃这次
  if (seq !== connectSeq || (userStopped && !opts.manual)) return;
  const host = addr.includes(':') ? `[${addr}]` : addr;
  const params: ConnectParams = { token: '', host: deviceLabel(dev), os: dev.os, port: dev.port, pcId };
  let manual = opts.manual;
  const c = new McpClient({
    url: `ws://${host}:${dev.port}/p2d/secure`,
    clientInfo: clientInfo(),
    // 第一次连接带上「手动」标记，之后的自动重连不带
    createSocket: (url) => {
      const s = new SecureSocket({
        url,
        phoneId: devicesStore.get().phoneId,
        key,
        manual,
        random: randomBytes,
        createRaw: (u) => new WebSocket(u) as unknown as RawSocket,
        onHello: (h) => upsertDevice({ pcId, mid: h.mid, name: h.name || dev.name, os: h.os || dev.os }),
        onReject: (code) => {
          if (code === 'unpaired') void forgetPairKey(pcId);
        },
      });
      manual = false;
      return s;
    },
    onConnected: async (mc) => {
      await mc.setPermissions(connectionStore.get().permissions);
      const tools = await mc.listTools();
      connectionStore.set({ serverInfo: mc.serverInfo, tools });
      upsertDevice({ pcId, lastAddr: addr, lastConnectedAt: Date.now(), lastRoute: 'wifi' });
      // 顺便刷新电脑的地址列表（换了网络 / DHCP 重新分配后）
      try {
        const info = (await mc.request('p2d/pc.info', { phone: devicesStore.get().phoneId }, 10_000)) as {
          addrs?: string[];
          port?: number;
        };
        if (info?.addrs?.length) upsertDevice({ pcId, addrs: info.addrs, port: info.port || dev.port });
      } catch {
        // 忽略
      }
    },
    onLog: __DEV__ ? (m) => console.log('[lan]', m) : undefined,
  });
  c.onStatus((status, detail) => {
    if (client !== c) return;
    connectionStore.set({ status, detail: status === 'connected' ? undefined : detail });
  });
  connectionStore.set({ params, route: 'wifi', pcId, addr, status: 'connecting', detail: undefined, serverInfo: null, tools: [] });
  replaceClient(c);
  c.connect();
}

/** 手动切换当前电脑的通道 */
export async function switchRoute(route: Route): Promise<void> {
  const cur = connectionStore.get();
  if (route === 'wifi') {
    const pcId = cur.pcId ?? lastUsb?.pcId;
    if (!pcId) throw new Error('当前没有连接电脑');
    await connectLan(pcId, { manual: true });
    return;
  }
  if (!lastUsb || (cur.pcId && lastUsb.pcId && lastUsb.pcId !== cur.pcId)) throw new Error('请先用数据线连接这台电脑');
  userStopped = false;
  const params = lastUsb;
  lastUsb = null; // 让 connectWith 不因「同一令牌」而跳过
  connectWith(params);
}

/** 是否可以切到 USB（这次打开 App 后插过线） */
export function canUseUsb(pcId: string | null): boolean {
  return !!lastUsb && (!pcId || !lastUsb.pcId || lastUsb.pcId === pcId);
}

/** 切换到另一台电脑（WiFi 直连） */
export async function connectDevice(pcId: string): Promise<void> {
  if (canUseUsb(pcId) && connectionStore.get().route === 'usb' && connectionStore.get().pcId === pcId) return;
  await connectLan(pcId, { manual: true });
}

/** 用户主动断开 */
export function disconnect(): void {
  userStopped = true;
  connectSeq++;
  replaceClient(null);
  void saveLastConnect(null);
  connectionStore.set({ status: 'idle', detail: undefined, params: null, route: null, addr: null, serverInfo: null, tools: [] });
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
