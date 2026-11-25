// 免调试连接（modules/p2d-accessory，Android 配件模式）：
// 电脑端（Linux）把没开 USB 调试的手机切换成配件，手机上点「用 p2d 打开」后，原生模块经数据线和电脑握手，
// 拿到连接参数（令牌等）后拼成 p2d://connect?… 交给这里，之后和 adb 插线拉起 App 走同一套连接逻辑。

import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

interface P2dAccessoryModule {
  takePending(): string | null;
  isOpen(): boolean;
  setAppVersion(v: string): void;
  addListener(event: 'onConnect', cb: (e: { url: string }) => void): { remove(): void };
}

const native = Platform.OS === 'android' ? requireOptionalNativeModule<P2dAccessoryModule>('P2dAccessory') : null;

let started = false;

/** 开始接收电脑端经配件发来的连接链接（只执行一次） */
export function watchAccessory(onUrl: (url: string) => void, appVersion: string): void {
  if (!native || started) return;
  started = true;
  native.setAppVersion(appVersion);
  native.addListener('onConnect', (e) => {
    native.takePending(); // 已经处理了，免得之后重复取到
    if (e?.url) onUrl(e.url);
  });
  const pending = native.takePending();
  if (pending) onUrl(pending);
}
