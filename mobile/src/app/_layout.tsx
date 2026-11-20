import '../global.css';

import * as Linking from 'expo-linking';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { handleIncomingUrl, initConnection } from '@/state/connection';

export default function RootLayout() {
  const scheme = useColorScheme();
  // 冷启动的初始链接和运行中收到的新链接都会出现在这里
  const url = Linking.useLinkingURL();

  useEffect(() => {
    void initConnection();
  }, []);

  useEffect(() => {
    if (!url) return;
    // 先加载本地权限设置，再连接（连接成功后要把权限同步给电脑）
    void initConnection().then(() => handleIncomingUrl(url));
  }, [url]);

  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="connect" />
      </Stack>
    </ThemeProvider>
  );
}
