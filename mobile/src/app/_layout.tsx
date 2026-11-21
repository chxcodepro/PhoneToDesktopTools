import '../global.css';

import * as Linking from 'expo-linking';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { useColorScheme as useNativewindColorScheme } from 'nativewind';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { parseDraftUrl } from '@/protocol/deepLink';
import { initExtensions } from '@/agent/extensionStore';
import { initScheduler } from '@/agent/scheduler';
import { handleIncomingUrl, initConnection } from '@/state/connection';
import { setDraft } from '@/state/ui';

export default function RootLayout() {
  const scheme = useColorScheme();
  // 界面实际使用的配色（NativeWind），状态栏图标颜色跟它走
  const { colorScheme: uiScheme } = useNativewindColorScheme();
  // 冷启动的初始链接和运行中收到的新链接都会出现在这里
  const url = Linking.useLinkingURL();

  useEffect(() => {
    void initConnection();
    void initScheduler();
    void initExtensions();
    // 默认竖屏；只有虚拟桌面页可以切到横屏（见 remote.tsx）
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!url) return;
    // p2d://?draft= 只填入 Agent 输入框，不发送
    const draft = parseDraftUrl(url);
    if (draft) {
      setDraft(draft);
      return;
    }
    // 先加载本地权限设置，再连接（连接成功后要把权限同步给电脑）
    void initConnection().then(() => handleIncomingUrl(url));
  }, [url]);

  return (
    <KeyboardProvider>
      <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
        {/* 全面屏下状态栏透明：浅色背景用深色的时间、信号图标，深色模式反之（虚拟桌面横屏时另行隐藏） */}
        <StatusBar style={uiScheme === 'dark' ? 'light' : 'dark'} />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(main)" />
          <Stack.Screen name="connect" />
          <Stack.Screen name="pair" />
        </Stack>
      </ThemeProvider>
    </KeyboardProvider>
  );
}
