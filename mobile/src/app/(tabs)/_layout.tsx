import { NativeTabs } from 'expo-router/native-tabs';

/** 底部 4 个标签：Agent / 远程桌面 / 扩展 / 设置 */
export default function TabsLayout() {
  return (
    <NativeTabs>
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
