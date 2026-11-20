// 设置页：已连接电脑、电脑权限（只在手机上设置）、模型预设。

import { router } from 'expo-router';
import type { LucideIcon } from 'lucide-react-native';
import { FileText, Monitor, MousePointer2, ScanLine, Terminal } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { STATUS_LABEL, StatusDot } from '@/components/connection-status';
import { Screen } from '@/components/screen';
import { Button } from '@/components/ui/button';
import { Card, GroupTitle, Separator } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { MODEL_PRESETS, type PresetId } from '@/agent/presets';
import type { PermissionLevel, Permissions } from '@/protocol/types';
import { disconnect, osLabel, updatePermissions, useConnection } from '@/state/connection';

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

const PRESET_OPTIONS = MODEL_PRESETS.map((p) => ({ value: p.id, label: p.label }));

export default function SettingsScreen() {
  const { status, params, permissions } = useConnection();
  // 模型设置：M1 只有界面，M3 接入 Agent 时再持久化（API Key 存安全存储）
  const [preset, setPreset] = useState<PresetId>('openai');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [customUrl, setCustomUrl] = useState('');

  return (
    <Screen title="设置">
      {/* 已连接电脑 */}
      <Card className="flex-row items-center gap-3 p-3">
        <View className="h-9 w-9 items-center justify-center rounded-md bg-primary/10">
          <Icon as={Monitor} size={18} className="text-primary" />
        </View>
        <View className="flex-1">
          <Text className="font-semibold">{params ? params.host : '未连接'}</Text>
          <View className="flex-row items-center gap-1.5">
            <StatusDot status={status} />
            <Text className="text-xs text-muted-foreground">
              {params ? `${osLabel(params.os)} · ${STATUS_LABEL[status]}` : STATUS_LABEL[status]}
            </Text>
          </View>
        </View>
        {params ? (
          <Button variant="outline" size="sm" onPress={disconnect}>
            <Text>断开</Text>
          </Button>
        ) : (
          <Button size="sm" onPress={() => router.push('/connect')}>
            <Text>连接</Text>
          </Button>
        )}
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

      {/* 模型 */}
      <GroupTitle className="mt-2">模型</GroupTitle>
      <Segmented value={preset} options={PRESET_OPTIONS} onChange={setPreset} />
      <View className="gap-3">
        {preset === 'custom' ? (
          <Field label="接口地址">
            <Input
              value={customUrl}
              onChangeText={setCustomUrl}
              placeholder="<YOUR_LLM_BASE_URL>"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
        ) : null}
        <Field label="API Key">
          <Input
            value={apiKey}
            onChangeText={setApiKey}
            placeholder="<YOUR_API_KEY>"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
        <Field label="模型">
          <Input
            value={model}
            onChangeText={setModel}
            placeholder="<YOUR_MODEL_NAME>"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
      </View>
    </Screen>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="text-xs font-medium">{label}</Text>
      {children}
    </View>
  );
}
