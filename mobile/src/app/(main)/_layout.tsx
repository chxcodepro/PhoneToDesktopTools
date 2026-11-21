// 主界面：Agent 页为首页，没有底部标签栏。
// 历史对话、扩展、设置从 Agent 页左侧抽屉进入；虚拟桌面从实时画面小窗的放大按钮进入。

import { Stack } from 'expo-router';

export default function MainLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="remote" />
      <Stack.Screen name="extensions" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="schedules" />
    </Stack>
  );
}
