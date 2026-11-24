// 同时连接多台电脑：除了「当前电脑」（connection.ts，负责 USB、插拔线切换、虚拟桌面默认画面等），
// 再用 WiFi / Tailscale 加密直连几台配对过的电脑，Agent 在同一个对话里可以一起操作。
// - 在「设备」页的电脑菜单里点「同时连接」；记住选择，下次打开 App（开着自动连接时）自动连上。
// - 权限和当前电脑一样（手机「设置 → 电脑权限」），改了立即同步给每台。
// - 某台被切换成当前电脑、或从设备列表删除时，自动断开它的「同时连接」。

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { McpClient } from '@/protocol/mcpClient';
import type { ConnectionStatus, ToolInfo } from '@/protocol/types';

import { connectionStore, createLanClient, findReachable, getClient, useConnection } from './connection';
import { deviceLabel, devicesStore, getDevice, getPairKey, upsertDevice, useDevices } from './devices';
import { createStore, useStore } from './store';
import { uiStore, useUi } from './ui';

export interface ExtraConn {
  pcId: string;
  status: ConnectionStatus;
  detail?: string;
  /** 实际连的地址 */
  addr: string | null;
  tools: ToolInfo[];
}

export interface MultiState {
  /** 用户选了「同时连接」的电脑（持久保存） */
  wanted: string[];
  conns: Record<string, ExtraConn>;
}

export const multiStore = createStore<MultiState>({ wanted: [], conns: {} });

const WANTED_KEY = 'p2d.extraPcs';
const clients = new Map<string, McpClient>();
/** 每台电脑各自的连接序号：探测地址期间点了断开 / 重新连接时，放弃旧的那次 */
const seqs = new Map<string, number>();

function setConn(pcId: string, patch: Partial<ExtraConn>): void {
  multiStore.set((s) => {
    const old = s.conns[pcId] ?? { pcId, status: 'idle' as ConnectionStatus, addr: null, tools: [] };
    return { conns: { ...s.conns, [pcId]: { ...old, ...patch } } };
  });
}

function setWanted(wanted: string[]): void {
  multiStore.set({ wanted });
  void AsyncStorage.setItem(WANTED_KEY, JSON.stringify(wanted)).catch(() => undefined);
}

/** 同时连接一台电脑（只用 WiFi / Tailscale）。manual：用户手动点的 */
export async function connectExtra(pcId: string, opts: { manual: boolean } = { manual: true }): Promise<void> {
  if (connectionStore.get().pcId === pcId) throw new Error('这台已经是当前电脑');
  const dev = getDevice(pcId);
  if (!dev) throw new Error('没有这台电脑的记录');
  const key = await getPairKey(pcId);
  if (!key) throw new Error('还没有和这台电脑配对：插一次数据线，或在电脑端点「配对新手机」后扫码 / 输入配对码');
  const { wanted } = multiStore.get();
  if (!wanted.includes(pcId)) setWanted([...wanted, pcId]);
  if (clients.get(pcId)?.status === 'connected') return;

  const seq = (seqs.get(pcId) ?? 0) + 1;
  seqs.set(pcId, seq);
  setConn(pcId, { status: 'connecting', detail: '正在查找电脑…' });
  let addr: string;
  try {
    addr = await findReachable([dev.lastAddr ?? '', ...dev.addrs], dev.port, pcId);
  } catch (e) {
    if (seqs.get(pcId) === seq) setConn(pcId, { status: 'idle', detail: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  // 探测期间断开了、又重新点了连接、或者它变成了当前电脑：放弃这次
  if (seqs.get(pcId) !== seq || !multiStore.get().wanted.includes(pcId) || connectionStore.get().pcId === pcId) return;

  const c = createLanClient(dev, key, addr, opts.manual, {
    onConnected: async (mc) => {
      await mc.setPermissions(connectionStore.get().permissions);
      const tools = await mc.listTools();
      if (clients.get(pcId) === mc) setConn(pcId, { tools });
      upsertDevice({ pcId, lastAddr: addr, lastConnectedAt: Date.now(), lastRoute: 'wifi' });
    },
    onLog: __DEV__ ? (m) => console.log(`[multi ${pcId.slice(0, 6)}]`, m) : undefined,
  });
  c.onStatus((status, detail) => {
    if (clients.get(pcId) !== c) return;
    setConn(pcId, { status, detail: status === 'connected' ? undefined : detail });
  });
  clients.get(pcId)?.close();
  clients.set(pcId, c);
  setConn(pcId, { status: 'connecting', detail: undefined, addr, tools: [] });
  c.connect();
}

/** 断开一台同时连接的电脑。forget：不再记住（下次打开 App 不自动连） */
export function disconnectExtra(pcId: string, forget = true): void {
  seqs.set(pcId, (seqs.get(pcId) ?? 0) + 1);
  clients.get(pcId)?.close();
  clients.delete(pcId);
  multiStore.set((s) => {
    const conns = { ...s.conns };
    delete conns[pcId];
    return { conns };
  });
  if (forget) setWanted(multiStore.get().wanted.filter((id) => id !== pcId));
}

/** 已连上的同时连接的电脑的客户端 */
export function getExtraClient(pcId: string): McpClient | null {
  const c = clients.get(pcId);
  return c && c.status === 'connected' ? c : null;
}

/** 已连上的同时连接的电脑（按选择的顺序） */
export function connectedExtras(): ExtraConn[] {
  const { wanted, conns } = multiStore.get();
  return wanted.map((id) => conns[id]).filter((c): c is ExtraConn => !!c && c.status === 'connected' && !!getExtraClient(c.pcId));
}

let initPromise: Promise<void> | null = null;

/** 读取记住的选择；开着自动连接时连上它们。只执行一次 */
export function initMulti(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      let wanted: string[] = [];
      try {
        const raw = await AsyncStorage.getItem(WANTED_KEY);
        const v = raw ? (JSON.parse(raw) as unknown) : [];
        wanted = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        wanted = [];
      }
      multiStore.set({ wanted });
      watch();
      if (!devicesStore.get().autoConnect) return;
      for (const id of wanted) {
        if (id === connectionStore.get().pcId || !getDevice(id)?.paired) continue;
        void connectExtra(id, { manual: false }).catch(() => undefined);
      }
    })();
  }
  return initPromise;
}

/** 跟随当前电脑、权限、设备列表的变化 */
function watch(): void {
  let perms = connectionStore.get().permissions;
  connectionStore.subscribe(() => {
    const cur = connectionStore.get();
    // 切换成当前电脑了：不再同时连接（同一台电脑不连两条）
    if (cur.pcId && clients.has(cur.pcId)) disconnectExtra(cur.pcId);
    if (cur.permissions !== perms) {
      perms = cur.permissions;
      for (const c of clients.values()) {
        if (c.status === 'connected') void c.setPermissions(perms).catch(() => undefined);
      }
    }
  });
  devicesStore.subscribe(() => {
    const ids = new Set(devicesStore.get().devices.map((d) => d.pcId));
    for (const id of multiStore.get().wanted) if (!ids.has(id)) disconnectExtra(id);
  });
}

export function useMulti(): MultiState {
  return useStore(multiStore);
}

// ---- 虚拟桌面 / 实时画面看哪台 ----

/** 同时连接的这台还算连着（含暂时断开、正在重连） */
const alive = (x: ExtraConn | undefined) => !!x && x.status !== 'idle' && x.status !== 'unauthorized';

/** 实际要看的电脑（null 是当前电脑）：选的那台断开了（或变成了当前电脑）时回到当前电脑；当前电脑没连时看第一台同时连接的 */
function resolveView(viewPc: string | null, cur: { pcId: string | null; status: ConnectionStatus }, s: MultiState): string | null {
  if (viewPc && viewPc !== cur.pcId && alive(s.conns[viewPc])) return viewPc;
  if (cur.status === 'idle' || cur.status === 'unauthorized') return s.wanted.find((id) => id !== cur.pcId && alive(s.conns[id])) ?? null;
  return null;
}

/** 虚拟桌面要操作的那台电脑的客户端（不是 Hook，手势回调里随时取） */
export function viewClient(): McpClient | null {
  const pcId = resolveView(uiStore.get().viewPc, connectionStore.get(), multiStore.get());
  return pcId ? getExtraClient(pcId) : getClient();
}

export interface ViewTarget {
  /** null 表示当前电脑 */
  pcId: string | null;
  name: string;
  status: ConnectionStatus;
}

/** 可以看的电脑：当前电脑（没连时只在没有别的可看时列出）+ 还连着的同时连接的电脑 */
export function useViewTargets(): { view: ViewTarget; targets: ViewTarget[] } {
  const ui = useUi();
  const conn = useConnection();
  const multi = useMulti();
  useDevices(); // 改名后刷新
  const extras: ViewTarget[] = multi.wanted
    .filter((id) => id !== conn.pcId && alive(multi.conns[id]))
    .map((id) => ({ pcId: id, name: deviceLabel(getDevice(id)), status: multi.conns[id].status }));
  const cur: ViewTarget = { pcId: null, name: conn.params?.host ?? deviceLabel(getDevice(conn.pcId)), status: conn.status };
  const curOff = conn.status === 'idle' || conn.status === 'unauthorized';
  const targets = curOff && extras.length ? extras : [cur, ...extras];
  const pcId = resolveView(ui.viewPc, conn, multi);
  return { view: targets.find((t) => t.pcId === pcId) ?? targets[0], targets };
}

/** 切到下一台电脑看 */
export function cycleView(targets: ViewTarget[], cur: ViewTarget): void {
  const i = targets.findIndex((t) => t.pcId === cur.pcId);
  uiStore.set({ viewPc: targets[(i + 1) % targets.length]?.pcId ?? null });
}
