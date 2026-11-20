import { NativeTabs } from 'expo-router/native-tabs';
import { useColorScheme } from 'react-native';

// 与 global.css 中 shadcn「Blue」主题一致。不设置时 Android 会使用系统动态取色（如 MIUI 的粉色）。
const TAB_COLORS = {
  light: {
    background: '#ffffff',
    active: '#2563eb',
    inactive: '#64748b',
    indicator: '#dbeafe',
    ripple: 'rgba(37, 99, 235, 0.12)',
  },
  dark: {
    background: '#020817',
    active: '#3b82f6',
    inactive: '#94a3b8',
    indicator: '#1e293b',
    ripple: 'rgba(59, 130, 246, 0.16)',
  },
} as const;

/** 底部 4 个标签：Agent / 远程桌面 / 扩展 / 设置 */
export default function TabsLayout() {
  const c = TAB_COLORS[useColorScheme() === 'dark' ? 'dark' : 'light'];
  return (
    <NativeTabs
      backgroundColor={c.background}
      tintColor={c.active}
      iconColor={{ default: c.inactive, selected: c.active }}
      labelStyle={{ default: { color: c.inactive }, selected: { color: c.active } }}
      indicatorColor={c.indicator}
      rippleColor={c.ripple}
      labelVisibilityMode="labeled"
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Agent</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="sparkles" md="smart_toy" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="remote">
        <NativeTabs.Trigger.Label>远程桌面</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="display" md="desktop_windows" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="extensions">
        <NativeTabs.Trigger.Label>扩展</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="puzzlepiece.extension" md="extension" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>设置</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
