// 自动发现电脑：扫描手机所在网段（/24）每个地址的 39272 端口，电脑端的 /p2d/ping 会回应。
// 手机连着多个网络时（WiFi、热点、Tailscale 等）列出各个网段，默认都扫，可以只选其中几个。
// 多个网段一起扫时，同时在途的探测请求总数不变（CONCURRENCY），只是总时间变长，不会更耗性能。
// Tailscale 的 100.64/10 网段太大不能扫描：只探测记住的电脑在 Tailscale 里的地址。
// 只用于发现；连接仍走配对过的加密通道，没配对过的要先配对。

import { requireOptionalNativeModule } from 'expo';
import { getIpAddressAsync, getNetworkStateAsync, NetworkStateType } from 'expo-network';

import { devicesStore } from './devices';
import { isTailscaleIp, parsePing, scanNets, subnetHosts, type FoundPc, type LocalNet, type ScanNet } from './discover';
import { createStore, useStore } from './store';

export type { FoundPc, ScanNet };

export const LAN_PORT = 39272;

export interface DiscoveryState {
  scanning: boolean;
  /** 已扫描的比例 0–1 */
  progress: number;
  found: FoundPc[];
  /** 手机现在能扫的网段 */
  nets: ScanNet[];
  /** 用户取消勾选的网段（id）；其余都扫 */
  skipped: string[];
  error: string | null;
  finishedAt: number;
}

export const discoveryStore = createStore<DiscoveryState>({
  scanning: false,
  progress: 0,
  found: [],
  nets: [],
  skipped: [],
  error: null,
  finishedAt: 0,
});

export function useDiscovery(): DiscoveryState {
  return useStore(discoveryStore);
}

const native = requireOptionalNativeModule<{ localNetworks(): LocalNet[] }>('P2dKeepAlive');

/** 手机现在的网段：Android 读所有网卡；读不到时用 expo-network 的 WiFi 地址 */
async function readNets(): Promise<ScanNet[]> {
  try {
    const list = native?.localNetworks();
    if (list?.length) return scanNets(list);
  } catch {
    // 用下面的办法
  }
  const net = await getNetworkStateAsync().catch(() => null);
  if (net && net.type !== NetworkStateType.WIFI && net.type !== NetworkStateType.ETHERNET) return [];
  const ip = await getIpAddressAsync().catch(() => '');
  return ip ? scanNets([{ name: 'wlan0', ip, prefix: 24 }]) : [];
}

async function probe(host: string, port: number, ms: number): Promise<FoundPc | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/p2d/ping`, { signal: ctl.signal });
    if (!r.ok) return null;
    return parsePing(host, port, await r.json());
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** 同时在途的探测请求数、每个地址等多久（Tailscale 走中继时慢，多等一会） */
const CONCURRENCY = 48;
const TIMEOUT_MS = 1500;
const TAILSCALE_TIMEOUT_MS = 6000;

let generation = 0;

/** 勾选 / 取消一个网段，然后重新扫描 */
export function toggleNet(id: string): void {
  const s = discoveryStore.get();
  discoveryStore.set({ skipped: s.skipped.includes(id) ? s.skipped.filter((x) => x !== id) : [...s.skipped, id] });
  void scanLan();
}

/** 扫描勾选的网段；正在扫时重新开始。发现一台就加进列表 */
export async function scanLan(): Promise<void> {
  const gen = ++generation;
  discoveryStore.set({ scanning: true, progress: 0, found: [], error: null });
  try {
    const nets = await readNets();
    if (gen !== generation) return;
    const skipped = discoveryStore.get().skipped;
    discoveryStore.set({ nets });
    const chosen = nets.filter((n) => !skipped.includes(n.id));
    if (!nets.length) {
      discoveryStore.set({ error: '手机没连 WiFi：连上和电脑同一个 WiFi，或者打开 Tailscale 后再扫描' });
      return;
    }
    if (!chosen.length) {
      discoveryStore.set({ error: '没有选择要扫描的网段' });
      return;
    }
    // 要探测的地址：局域网整段扫；Tailscale 只探测记住的电脑的 100.x 地址
    const targets: { host: string; ms: number }[] = [];
    for (const n of chosen) {
      if (n.kind === 'tailscale') {
        const addrs = new Set(devicesStore.get().devices.flatMap((d) => d.addrs.filter(isTailscaleIp)));
        for (const a of addrs) targets.push({ host: a, ms: TAILSCALE_TIMEOUT_MS });
      } else {
        for (const h of subnetHosts(n.ip)) targets.push({ host: h, ms: TIMEOUT_MS });
      }
    }
    if (!targets.length) {
      discoveryStore.set({ error: '还没有记住在 Tailscale 里的电脑：先在「添加 → 输入电脑 IP」里填一次 100 开头的地址' });
      return;
    }
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < targets.length && gen === generation) {
        const t = targets[next++];
        const pc = await probe(t.host, LAN_PORT, t.ms);
        done++;
        if (gen !== generation) return;
        const s = discoveryStore.get();
        // 同一台电脑有多个地址（如局域网和 Tailscale）时只保留先发现的
        const found = pc && !s.found.some((f) => f.pcId === pc.pcId) ? [...s.found, pc] : s.found;
        if (found !== s.found || done % 16 === 0 || done === targets.length) discoveryStore.set({ found, progress: done / targets.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  } finally {
    if (gen === generation) discoveryStore.set({ scanning: false, progress: 1, finishedAt: Date.now() });
  }
}
