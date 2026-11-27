// 外观（跟随系统 / 浅色 / 深色）：设置在主进程（nativeTheme.themeSource），页面只读和改。
// 颜色本身由 styles.css 按 prefers-color-scheme 切换，这里只给设置界面用。
import { useEffect, useSyncExternalStore } from 'react';
import type { Appearance, AppearanceState } from '../../shared/types';

let state: AppearanceState = { setting: 'system', dark: false };
const subs = new Set<() => void>();
let started = false;

function set(s: AppearanceState) {
  state = s;
  for (const f of subs) f();
}

function start() {
  if (started) return;
  started = true;
  void window.p2d.appearance().then(set);
  window.p2d.onAppearance(set);
}

export function useAppearance(): AppearanceState {
  useEffect(start, []);
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}

export async function setAppearance(v: Appearance): Promise<void> {
  set(await window.p2d.setAppearance(v));
}

export const APPEARANCES: { id: Appearance; label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
];
