// 设置页：设备（进入设备列表）、打开 App 时自动连接、电脑权限（只在手机上设置）、模型预设、关于（版本、检查更新）。

import { router } from 'expo-router';
import type { LucideIcon } from 'lucide-react-native';
import { ChevronRight, FileText, Monitor, MousePointer2, ScanLine, Terminal } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { AppUpdate } from '@/components/app-update';
import { BackgroundCard } from '@/components/devices/background-card';
import { STATUS_LABEL, StatusDot } from '@/components/connection-status';
import { ModelSettings } from '@/components/model-settings';
import { Screen } from '@/components/screen';
import { Card, GroupTitle, Separator } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import type { PermissionLevel, Permissions } from '@/protocol/types';
import { osLabel, updatePermissions, useConnection } from '@/state/connection';
import { setAutoConnect, useDevices } from '@/state/devices';

const LEVELS = [
  { value: 'readonly', label: '只读' },
  { value: 'standard', label: '标准' },
  { value: 'full', label: '完全控制' },
] as const satisfies readonly { value: PermissionLevel; label: string }[];

const SWITCHES: { key: keyof Omit<Permissions, 'level'>; label: string; icon: LucideIcon }[] = [
  { key: 'shell', label: '执行命令', icon: Terminal },
  { key: 'fs', label: '读写文件', icon: FileText },
  { key: 'screen', label: '查看屏幕', icon: ScanLine },
  { key: 'input', label: '鼠标键盘', icon: MousePointer2 },
];

export default function SettingsScreen() {
  const { status, params, permissions } = useConnection();
  const { autoConnect } = useDevices();
  return (
    <Screen title="设置">
      {/* 设备：点一下进入设备列表 */}
      <Pressable onPress={() => router.push('/devices')}>
        <Card className="flex-row items-center gap-3 p-3">
          <View className="h-9 w-9 items-center justify-center rounded-md bg-primary/10">
            <Icon as={Monitor} size={18} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="font-semibold">设备</Text>
            <View className="flex-row items-center gap-1.5">
              <StatusDot status={status} />
              <Text numberOfLines={1} className="flex-shrink text-xs text-muted-foreground">
                {params ? `${params.host} · ${osLabel(params.os)} · ${STATUS_LABEL[status]}` : STATUS_LABEL[status]}
              </Text>
            </View>
          </View>
          <Icon as={ChevronRight} size={18} className="text-muted-foreground" />
        </Card>
      </Pressable>

      <BackgroundCard />

      <Card className="flex-row items-center gap-3 p-3">
        <View className="flex-1">
          <Text className="text-sm">打开 App 时自动连接</Text>
          <Text className="text-xs text-muted-foreground">自动连上次用的电脑：插着数据线用 USB，否则用 WiFi</Text>
        </View>
        <Switch checked={autoConnect} onCheckedChange={setAutoConnect} />
      </Card>

      {/* 电脑权限 */}
      <GroupTitle className="mt-2">电脑权限</GroupTitle>
      <Segmented
        value={permissions.level}
        options={LEVELS}
        onChange={(level) => void updatePermissions({ level })}
      />
      <Card>
        {SWITCHES.map((s, i) => (
          <View key={s.key}>
            {i > 0 ? <Separator /> : null}
            <View className="flex-row items-center gap-3 px-3 py-3">
              <Icon as={s.icon} size={16} className="text-muted-foreground" />
              <Text className="flex-1 text-sm">{s.label}</Text>
              <Switch
                checked={permissions[s.key]}
                onCheckedChange={(v) => void updatePermissions({ [s.key]: v })}
              />
            </View>
          </View>
        ))}
      </Card>

      <ModelSettings />

      <AppUpdate />
    </Screen>
  );
}
