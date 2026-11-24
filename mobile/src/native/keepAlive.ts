// 连着电脑时保持连接（modules/p2d-keepalive，Android 前台服务）：
// 通知栏常驻「已连接电脑」，App 切到后台时系统不会冻结它，和电脑的连接不断；所有电脑都断开时停止。
// Android 12 起只能在 App 处于前台时启动前台服务：在后台连上的，等回到前台再启动。

import { requireOptionalNativeModule } from 'expo';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { connectionStore } from '@/state/connection';
import { deviceLabel, getDevice } from '@/state/devices';
import { multiStore } from '@/state/multi';

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

/** 打开本应用的系统设置页（厂商的「耗电管理」在里面） */
export function openAppSettings(): void {
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
