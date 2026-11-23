// 打开 App 时连哪台电脑：上次用的那台（用户在「设备」里选过、或最后连上的），而不是列表里固定的某一台。
// 纯函数，不依赖 React Native，方便在 Node 里测试（tests/startup.test.ts）。

export interface StartupDevice {
  pcId: string;
  paired: boolean;
  lastConnectedAt?: number;
}

export interface StartupChoice {
  /** 用上次保存的 USB 令牌连接 */
  useUsb: boolean;
  /** 要显示 / 连接的电脑 */
  pcId: string | null;
}

/**
 * @param lastPcId 上次用的电脑
 * @param usb 上次保存的 USB 连接（令牌 24 小时内有效），没有为 null
 */
export function pickStartup(devices: readonly StartupDevice[], lastPcId: string | null, usb: { pcId?: string } | null): StartupChoice {
  const last = lastPcId ? devices.find((d) => d.pcId === lastPcId) : undefined;
  // USB 令牌属于上次用的那台电脑才用：之后切到别的电脑了，就不要再连回插过线的那台
  if (usb && (!last || !usb.pcId || usb.pcId === last.pcId)) return { useUsb: true, pcId: usb.pcId ?? null };
  if (last) return { useUsb: false, pcId: last.pcId };
  // 没有记录上次用哪台（旧版本升级上来）：最近连接过的
  const recent = [...devices].sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0));
  const pc = recent.find((d) => d.paired) ?? recent[0];
  return { useUsb: false, pcId: pc?.pcId ?? null };
}
