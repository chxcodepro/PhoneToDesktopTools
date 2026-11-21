// 「设备」：记住连过的电脑（名称、系统、局域网地址、最近通道），配对密钥存在手机安全存储里。
// 插数据线连上时自动配对；也可以扫码或输入 IP + 配对码配对，之后在同一局域网内直接连接。

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { fromBase64, toBase64, toHex } from '@/protocol/secure';

import { createStore, useStore } from './store';

export type Route = 'usb' | 'wifi';

export interface PcDevice {
  pcId: string;
  /** 电脑名（电脑端告知） */
  name: string;
  /** 用户起的名字，优先显示 */
  alias?: string;
  os: string;
  /** 电脑的局域网地址（电脑端告知，真实网卡在前） */
  addrs: string[];
  /** 局域网直连端口 */
  port: number;
  /** 上次连通的地址 */
  lastAddr?: string;
  lastConnectedAt?: number;
  lastRoute?: Route;
  /** 是否有配对密钥（能 WiFi 直连） */
  paired: boolean;
  pairedAt?: number;
}

export interface DevicesState {
  devices: PcDevice[];
  /** 本机标识（配对、电脑端区分手机用） */
  phoneId: string;
  phoneName: string;
  /** 插上数据线时自动从 WiFi 切到 USB */
  preferUsb: boolean;
  ready: boolean;
}

const LIST_KEY = 'p2d.devices.v1';
const PHONE_ID_KEY = 'p2d.phoneId';
const PREFER_USB_KEY = 'p2d.preferUsb';
const keyName = (pcId: string) => `p2d.pc.${pcId.replace(/[^A-Za-z0-9._-]/g, '_')}`;

function defaultPhoneName(): string {
  const c = (Platform.constants ?? {}) as { Brand?: string; Model?: string; Manufacturer?: string };
  const brand = c.Brand ?? c.Manufacturer ?? '';
  const model = c.Model ?? '';
  const name = `${brand && !model.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ` : ''}${model}`.trim();
  return name || (Platform.OS === 'ios' ? 'iPhone' : '安卓手机');
}

export const devicesStore = createStore<DevicesState>({
  devices: [],
  phoneId: '',
  phoneName: defaultPhoneName(),
  preferUsb: true,
  ready: false,
});

export function useDevices(): DevicesState {
  return useStore(devicesStore);
}

export const randomBytes = (n: number): Uint8Array => getRandomBytes(n);

async function persist(): Promise<void> {
  await AsyncStorage.setItem(LIST_KEY, JSON.stringify(devicesStore.get().devices)).catch(() => undefined);
}

let initPromise: Promise<void> | null = null;

export function initDevices(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const [list, id, prefer] = await Promise.all([
        AsyncStorage.getItem(LIST_KEY).catch(() => null),
        AsyncStorage.getItem(PHONE_ID_KEY).catch(() => null),
        AsyncStorage.getItem(PREFER_USB_KEY).catch(() => null),
      ]);
      let phoneId = id ?? '';
      if (!/^[0-9a-f]{16,64}$/.test(phoneId)) {
        phoneId = toHex(randomBytes(12));
        await AsyncStorage.setItem(PHONE_ID_KEY, phoneId).catch(() => undefined);
      }
      let devices: PcDevice[] = [];
      try {
        devices = list ? (JSON.parse(list) as PcDevice[]).filter((d) => d && d.pcId) : [];
      } catch {
        devices = [];
      }
      devicesStore.set({ devices, phoneId, preferUsb: prefer !== '0', ready: true });
    })();
  }
  return initPromise;
}

export function getDevice(pcId: string | null | undefined): PcDevice | undefined {
  return pcId ? devicesStore.get().devices.find((d) => d.pcId === pcId) : undefined;
}

/** 新增或更新一台电脑（按最近连接排序） */
export function upsertDevice(patch: Partial<PcDevice> & { pcId: string }): PcDevice {
  const list = devicesStore.get().devices;
  const old = list.find((d) => d.pcId === patch.pcId);
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<PcDevice>;
  const next: PcDevice = { name: '电脑', os: 'unknown', addrs: [], port: 0, paired: false, ...old, ...clean, pcId: patch.pcId };
  const rest = list.filter((d) => d.pcId !== patch.pcId);
  const devices = [next, ...rest].sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0));
  devicesStore.set({ devices });
  void persist();
  return next;
}

export async function setPairKey(pcId: string, key: Uint8Array): Promise<void> {
  await SecureStore.setItemAsync(keyName(pcId), toBase64(key));
  upsertDevice({ pcId, paired: true, pairedAt: Date.now() });
}

export async function getPairKey(pcId: string): Promise<Uint8Array | null> {
  const v = await SecureStore.getItemAsync(keyName(pcId)).catch(() => null);
  const k = v ? fromBase64(v) : null;
  return k && k.length === 32 ? k : null;
}

/** 电脑端已取消配对：删掉密钥，保留记录 */
export async function forgetPairKey(pcId: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyName(pcId)).catch(() => undefined);
  if (getDevice(pcId)) upsertDevice({ pcId, paired: false });
}

export async function removeDevice(pcId: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyName(pcId)).catch(() => undefined);
  devicesStore.set((s) => ({ devices: s.devices.filter((d) => d.pcId !== pcId) }));
  await persist();
}

export function renameDevice(pcId: string, alias: string): void {
  upsertDevice({ pcId, alias: alias.trim() });
}

/** 显示名：用户起的名字优先 */
export function deviceLabel(d: Pick<PcDevice, 'name' | 'alias'> | undefined): string {
  return d?.alias || d?.name || '电脑';
}

export function setPreferUsb(v: boolean): void {
  devicesStore.set({ preferUsb: v });
  void AsyncStorage.setItem(PREFER_USB_KEY, v ? '1' : '0').catch(() => undefined);
}
