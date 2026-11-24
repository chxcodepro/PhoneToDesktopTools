// 自动发现局域网里的电脑：扫描手机所在网段（/24）每个地址的 39272 端口，电脑端的 /p2d/ping 会回应。
// 只用于发现；连接仍走配对过的加密通道，没配对过的要先配对。
// Tailscale 的 100.x 网段太大不能扫描，在界面上提示用户手动输入地址。

import { getIpAddressAsync, getNetworkStateAsync, NetworkStateType } from 'expo-network';

import { parsePing, subnetHosts, type FoundPc } from './discover';
import { createStore, useStore } from './store';

export type { FoundPc };

export const LAN_PORT = 39272;

export interface DiscoveryState {
  scanning: boolean;
  /** 已扫描的比例 0–1 */
  progress: number;
  found: FoundPc[];
  /** 扫描的网段，如 192.168.31.x */
  subnet: string | null;
  error: string | null;
  finishedAt: number;
}

export const discoveryStore = createStore<DiscoveryState>({ scanning: false, progress: 0, found: [], subnet: null, error: null, finishedAt: 0 });

export function useDiscovery(): DiscoveryState {
  return useStore(discoveryStore);
}

async function probe(host: string, port: number, ms: number): Promise<FoundPc | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`http://${host}:${port}/p2d/ping`, { signal: ctl.signal });
    if (!r.ok) return null;
    return parsePing(host, port, await r.json());
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** 同时探测多少个地址、每个地址等多久 */
const CONCURRENCY = 48;
const TIMEOUT_MS = 1500;

/** 扫描手机所在的网段；发现一台就加进列表 */
export async function scanLan(): Promise<void> {
  if (discoveryStore.get().scanning) return;
  discoveryStore.set({ scanning: true, progress: 0, found: [], error: null });
  try {
    const net = await getNetworkStateAsync().catch(() => null);
    if (net && net.type !== NetworkStateType.WIFI && net.type !== NetworkStateType.ETHERNET) {
      discoveryStore.set({ error: '手机没连 WiFi：连上和电脑同一个 WiFi 后再扫描' });
      return;
    }
    const ip = await getIpAddressAsync().catch(() => '');
    const hosts = subnetHosts(ip);
    if (!hosts.length) {
      discoveryStore.set({ error: '读不到手机的局域网地址：确认已连上 WiFi' });
      return;
    }
    discoveryStore.set({ subnet: `${hosts[0].split('.').slice(0, 3).join('.')}.x` });
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < hosts.length) {
        const host = hosts[next++];
        const pc = await probe(host, LAN_PORT, TIMEOUT_MS);
        done++;
        const s = discoveryStore.get();
        // 同一台电脑有多个地址时只保留一个
        const found = pc && !s.found.some((f) => f.pcId === pc.pcId) ? [...s.found, pc] : s.found;
        if (found !== s.found || done % 16 === 0 || done === hosts.length) discoveryStore.set({ found, progress: done / hosts.length });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    discoveryStore.set({ scanning: false, progress: 1, finishedAt: Date.now() });
  }
}
