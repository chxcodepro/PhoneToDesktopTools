// 连着电脑时保持连接（modules/p2d-keepalive，Android 前台服务）：
// 通知栏常驻「已连接电脑」，App 切到后台时系统不会冻结它，和电脑的连接不断；所有电脑都断开时停止。
// Android 12 起只能在 App 处于前台时启动前台服务：在后台连上的，等回到前台再启动。

import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { connectionStore } from '@/state/connection';
import { deviceLabel, getDevice } from '@/state/devices';
import { multiStore } from '@/state/multi';
import { createStore, useStore } from '@/state/store';

interface P2dKeepAliveModule {
  start(title: string, text: string): boolean;
  stop(): boolean;
  isBackgroundAllowed(): boolean;
  requestBackground(): boolean;
  openAppSettings(): boolean;
}

const native = requireOptionalNativeModule<P2dKeepAliveModule>('P2dKeepAlive');

/** 连着的电脑名（当前电脑在前） */
function connectedNames(): { names: string[]; route: string | null } {
  const cur = connectionStore.get();
  const names: string[] = [];
  if (cur.status === 'connected' && cur.pcId) names.push(deviceLabel(getDevice(cur.pcId)) || cur.params?.host || '电脑');
  for (const x of Object.values(multiStore.get().conns)) {
    if (x.status === 'connected' && x.pcId !== cur.pcId) names.push(deviceLabel(getDevice(x.pcId)) || '电脑');
  }
  return { names, route: cur.status === 'connected' ? cur.route : null };
}

let started = false;
let lastText = '';

function sync(): void {
  if (!native) return;
  const { names, route } = connectedNames();
  if (!names.length) {
    if (started) native.stop();
    started = false;
    lastText = '';
    return;
  }
  const title = names.length > 1 ? `已连接 ${names.length} 台电脑` : `已连接「${names[0]}」`;
  const via = route === 'usb' ? 'USB 数据线' : 'WiFi';
  const text = names.length > 1 ? `${names.join('、')} · 切到后台也保持连接` : `${via} · 切到后台也保持连接`;
  const key = `${title}|${text}`;
  if (started && key === lastText) return;
  // 在后台时系统不允许启动：回到前台时再试
  if (!started && AppState.currentState !== 'active') return;
  if (native.start(title, text)) {
    started = true;
    lastText = key;
  }
}

let watching = false;
export function watchKeepAlive(): void {
  if (watching || !native) return;
  watching = true;
  connectionStore.subscribe(sync);
  multiStore.subscribe(sync);
  AppState.addEventListener('change', (s) => {
    if (s === 'active') sync();
  });
  sync();
  watchBackgroundDrops();
}

// ---------- 切到后台后断开过 ----------
// 允许了「忽略电池优化」，ColorOS 仍会在 App 切到后台约 5 秒后关掉它的网络，要在「耗电管理」里选「完全允许后台行为」。
// 系统没有接口能查到这个开关，所以按实际表现判断：
// - 切到后台后不久（BG_CUT_WINDOW 内）断开：手机系统在限制后台，提示去设置。更晚的断开多半是电脑那边（拔线、关程序、休眠），不算。
// - 连着电脑在后台待了 BG_OK_AFTER 以上都没断：后台运行已经放开了，不再提示（「忽略电池优化」没打开也不提示）。
// - 从「应用设置」回来：认为用户已经改好了，先不提示；之后真的又被断开再提示。

const BG_KEY = 'p2d.bgState';
const LEGACY_DROP_KEY = 'p2d.bgDropped';
/** 切到后台后多久内断开算系统限制（ColorOS 约 5 秒） */
const BG_CUT_WINDOW = 45_000;
/** 在后台连着待了这么久没断，就认为后台运行已放开 */
const BG_OK_AFTER = 20_000;

interface BgState {
  /** 切到后台后不久就断开过，还没确认改好 */
  dropped: boolean;
  /** 确认后台运行没问题（后台连着待够了时间，或刚从应用设置回来） */
  ok: boolean;
}

const bgStore = createStore<BgState>({ dropped: false, ok: false });

function setBg(patch: Partial<BgState>): void {
  const cur = bgStore.get();
  if (Object.entries(patch).every(([k, v]) => cur[k as keyof BgState] === v)) return;
  bgStore.set(patch);
  void AsyncStorage.setItem(BG_KEY, JSON.stringify(bgStore.get())).catch(() => undefined);
}

/** 从「应用设置」回来时当作已经改好 */
let visitingSettings = false;

function watchBackgroundDrops(): void {
  void AsyncStorage.multiGet([BG_KEY, LEGACY_DROP_KEY])
    .then(([[, v], [, legacy]]) => {
      if (v) bgStore.set(JSON.parse(v) as BgState);
      else if (legacy === '1') bgStore.set({ dropped: true, ok: false });
    })
    .catch(() => undefined);
  let bgSince = 0;
  let droppedThisTime = false;
  AppState.addEventListener('change', (st) => {
    if (st === 'background') {
      bgSince = connectionStore.get().status === 'connected' ? Date.now() : 0;
      droppedThisTime = false;
    } else if (st === 'active') {
      if (visitingSettings) {
        visitingSettings = false;
        setBg({ dropped: false, ok: true });
      } else if (bgSince && !droppedThisTime && Date.now() - bgSince >= BG_OK_AFTER && connectionStore.get().status === 'connected') {
        setBg({ dropped: false, ok: true });
      }
      bgSince = 0;
    }
  });
  let last = connectionStore.get().status;
  connectionStore.subscribe(() => {
    const cur = connectionStore.get().status;
    if (last === 'connected' && cur !== 'connected' && bgSince && AppState.currentState !== 'active') {
      if (Date.now() - bgSince <= BG_CUT_WINDOW) {
        droppedThisTime = true;
        setBg({ dropped: true, ok: false });
      } else {
        bgSince = 0; // 在后台待了很久才断开，多半是电脑那边，这一轮不再判断
      }
    }
    last = cur;
  });
}

/** OPPO / 一加 / 真我（ColorOS）：要在「耗电管理」里选「完全允许后台行为」 */
export const isColorOS = Platform.OS === 'android' && /oppo|oneplus|realme/i.test(String((Platform.constants as { Manufacturer?: string }).Manufacturer ?? ''));

/** 切到后台后不久就断开过（需要用户去系统设置里放开后台限制） */
export function useBackgroundDropped(): boolean {
  return useStore(bgStore).dropped;
}

/** 已经确认后台运行没问题（这时即使没打开「忽略电池优化」也不提示） */
export function useBackgroundOk(): boolean {
  return useStore(bgStore).ok;
}

// ---------- 允许后台运行 ----------
// ColorOS 等系统在 App 切到后台几秒后会主动关闭它的网络连接（即使有前台服务），用户允许后台运行后才不关。

/** 已允许后台运行（或不需要，如 iOS / 老系统）时为 true */
export function backgroundAllowed(): boolean {
  try {
    return native ? native.isBackgroundAllowed() : true;
  } catch {
    return true;
  }
}

/** 弹出系统的「允许后台运行」授权框 */
export function requestBackground(): void {
  native?.requestBackground();
}

/** 打开本应用的系统设置页（厂商的「耗电管理」在里面）；回来时先当作已经改好 */
export function openAppSettings(): void {
  visitingSettings = true;
  native?.openAppSettings();
}

/** 是否已允许后台运行；从系统设置回来时重新检查 */
export function useBackgroundAllowed(): boolean {
  const [ok, setOk] = useState(backgroundAllowed);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') setOk(backgroundAllowed());
    });
    return () => sub.remove();
  }, []);
  return ok;
}
