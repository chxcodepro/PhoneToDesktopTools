// 设备页：当前连接（USB / WiFi 切换、断开）、记住的电脑（点一下直接连、重命名、删除）、添加电脑（扫码 / 输入 IP）。
// 每台电脑有各自的对话：切换电脑后，Agent 页显示那台电脑的对话。

import { router } from 'expo-router';
import { Monitor, MoreHorizontal, Pencil, Plug, Plus, Trash2, Wifi } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, View } from 'react-native';

import { conversationStore, stop } from '@/agent/conversations';
import { formatDateTime } from '@/agent/schedule';
import { ActionSheet, askConfirm } from '@/components/action-sheet';
import { AddPcSheet } from '@/components/devices/add-pc-sheet';
import { Screen } from '@/components/screen';
import { FieldLabel, Sheet } from '@/components/sheet';
import { Button } from '@/components/ui/button';
import { Card, GroupTitle } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { canUseUsb, connectDevice, disconnect, osLabel, switchRoute, useConnection } from '@/state/connection';
import { deviceLabel, removeDevice, renameDevice, setPreferUsb, useDevices, type PcDevice } from '@/state/devices';
import { pendingPairStore } from '@/state/pairing';
import { useStore } from '@/state/store';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Agent 正在执行时切换电脑要先停止 */
function confirmSwitch(action: () => void): void {
  if (!conversationStore.get().running) return action();
  askConfirm({ title: 'Agent 正在执行任务', message: '切换电脑会停止当前任务。', confirmText: '停止并切换', icon: Monitor }, () => {
    stop();
    action();
  });
}

function RouteButton({
  icon,
  label,
  active,
  disabled,
  onPress,
}: {
  icon: typeof Wifi;
  label: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={disabled || active}
      onPress={onPress}
      className={cn(
        'h-10 flex-1 flex-row items-center justify-center gap-1.5 rounded-lg border',
        active ? 'border-primary bg-primary/10' : 'border-border bg-background',
        disabled && !active && 'opacity-40',
      )}
    >
      <Icon as={icon} size={15} className={active ? 'text-primary' : 'text-foreground'} />
      <Text className={cn('text-sm', active ? 'font-medium text-primary' : 'text-foreground')}>{label}</Text>
    </Pressable>
  );
}

function CurrentCard({ onError }: { onError: (m: string) => void }) {
  const { status, route, pcId, addr, detail } = useConnection();
  const { devices } = useDevices();
  const dev = devices.find((d) => d.pcId === pcId);
  // 没连接、也没有这台电脑的记录（如刚删除）时不显示
  if (status === 'idle' && !dev) return null;
  const busy = status === 'connecting';
  const statusText =
    status === 'connected'
      ? `已连接 · ${route === 'wifi' ? `WiFi${addr ? ` · ${addr}` : ''}` : 'USB 数据线'}`
      : status === 'connecting'
        ? detail || '正在连接…'
        : status === 'disconnected'
          ? '连接已断开，正在重连…'
          : (detail ?? '未连接');
  return (
    <Card className="gap-3 p-4">
      <View className="flex-row items-center gap-3">
        <View className="h-11 w-11 items-center justify-center rounded-full bg-primary/10">
          <Icon as={Monitor} size={20} className="text-primary" />
        </View>
        <View className="flex-1">
          <Text numberOfLines={1} className="text-base font-semibold">
            {deviceLabel(dev) || '电脑'}
          </Text>
          <View className="flex-row items-center gap-1.5">
            {busy ? <ActivityIndicator size="small" color="#2563eb" /> : null}
            <Text
              numberOfLines={2}
              className={cn('flex-shrink text-xs', status === 'connected' ? 'text-success-foreground' : 'text-muted-foreground')}
            >
              {statusText}
            </Text>
          </View>
        </View>
      </View>
      <View className="flex-row gap-2">
        <RouteButton
          icon={Plug}
          label="USB"
          active={route === 'usb' && status === 'connected'}
          disabled={!canUseUsb(pcId)}
          onPress={() => void switchRoute('usb').catch((e) => onError(errText(e)))}
        />
        <RouteButton
          icon={Wifi}
          label="WiFi"
          active={route === 'wifi' && status === 'connected'}
          disabled={!dev?.paired}
          onPress={() => void switchRoute('wifi').catch((e) => onError(errText(e)))}
        />
      </View>
      {!dev?.paired && pcId ? (
        <Text className="text-xs text-muted-foreground">这台电脑还没配对，插一次数据线就会自动配对，之后可以用 WiFi 连接。</Text>
      ) : null}
      {status !== 'idle' ? (
        <Button variant="outline" size="sm" onPress={disconnect}>
          <Text>断开</Text>
        </Button>
      ) : null}
    </Card>
  );
}

function DeviceRow({ d, current, onMore, onError }: { d: PcDevice; current: boolean; onMore: () => void; onError: (m: string) => void }) {
  const { status } = useConnection();
  const connect = () => {
    if (!d.paired) {
      Alert.alert('还没有配对', '插一次数据线会自动配对；或者在电脑端窗口点「配对新手机」，再点右上角「添加」扫码 / 输入 IP。');
      return;
    }
    confirmSwitch(() => void connectDevice(d.pcId).catch((e) => onError(errText(e))));
  };
  return (
    <Pressable onPress={connect} onLongPress={onMore}>
      <Card className={cn('flex-row items-center gap-3 p-3', current && 'border-primary/40')}>
        <View className={cn('h-9 w-9 items-center justify-center rounded-full', current ? 'bg-primary/10' : 'bg-muted')}>
          <Icon as={Monitor} size={17} className={current ? 'text-primary' : 'text-foreground'} />
        </View>
        <View className="flex-1 gap-0.5">
          <View className="flex-row items-center gap-1.5">
            <Text numberOfLines={1} className="flex-shrink font-medium">
              {deviceLabel(d)}
            </Text>
            {current && status === 'connected' ? <Text className="text-[11px] text-success-foreground">当前</Text> : null}
          </View>
          <Text numberOfLines={1} className="text-xs text-muted-foreground">
            {[osLabel(d.os), d.paired ? '可 WiFi 直连' : '未配对', d.lastConnectedAt ? `上次 ${formatDateTime(d.lastConnectedAt)}` : '']
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
        <Pressable onPress={onMore} hitSlop={10} className="h-8 w-8 items-center justify-center" accessibilityLabel="更多">
          <Icon as={MoreHorizontal} size={18} className="text-muted-foreground" />
        </Pressable>
      </Card>
    </Pressable>
  );
}

export default function DevicesScreen() {
  const { devices, preferUsb, phoneName } = useDevices();
  const { pcId } = useConnection();
  const pending = useStore(pendingPairStore).link;
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<PcDevice | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 菜单关闭后保留 menuFor：面板淡出时内容不变
  const [menuFor, setMenuFor] = useState<PcDevice | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <Screen
      title="设备"
      right={
        <Pressable onPress={() => setAdding(true)} hitSlop={8} className="flex-row items-center gap-1" accessibilityLabel="添加电脑">
          <Icon as={Plus} size={16} className="text-primary" />
          <Text className="text-sm text-primary">添加</Text>
        </Pressable>
      }
    >
      <CurrentCard onError={setError} />
      {error ? (
        <Pressable onPress={() => setError(null)}>
          <Text className="px-1 text-xs text-destructive">{error}</Text>
        </Pressable>
      ) : null}

      <GroupTitle>我的电脑</GroupTitle>
      {devices.length ? (
        devices.map((d) => (
          <DeviceRow
            key={d.pcId}
            d={d}
            current={d.pcId === pcId}
            onMore={() => {
              setMenuFor(d);
              setMenuOpen(true);
            }}
            onError={setError}
          />
        ))
      ) : (
        <Text className="px-1 py-4 text-center text-sm text-muted-foreground">还没有记录。用数据线连一次电脑，或点右上角「添加」。</Text>
      )}

      <Card className="flex-row items-center gap-3 p-3">
        <View className="flex-1">
          <Text className="text-sm">插上数据线时自动切到 USB</Text>
          <Text className="text-xs text-muted-foreground">USB 更稳定、延迟更低；关闭后插线也继续用 WiFi</Text>
        </View>
        <Switch checked={preferUsb} onCheckedChange={setPreferUsb} />
      </Card>

      <Text className="px-1 text-xs leading-5 text-muted-foreground">
        {`WiFi 连接是手机直接连电脑的局域网 IP（端口 39272），全程加密，只有配对过的手机能连。拔掉数据线时会自动切到 WiFi。本机名称：${phoneName}。`}
      </Text>
      <Button variant="ghost" size="sm" onPress={() => router.push('/remote')}>
        <Text className="text-primary">打开虚拟桌面</Text>
      </Button>

      <AddPcSheet
        visible={adding || !!pending}
        initialLink={pending}
        onClose={() => {
          setAdding(false);
          pendingPairStore.set({ link: null });
        }}
      />
      <ActionSheet
        visible={menuOpen}
        icon={Monitor}
        title={deviceLabel(menuFor ?? undefined)}
        subtitle={menuFor ? [osLabel(menuFor.os), menuFor.addrs.slice(0, 3).join('、')].filter(Boolean).join(' · ') : undefined}
        onClose={() => setMenuOpen(false)}
        actions={
          menuFor
            ? [
                {
                  label: '重命名',
                  icon: Pencil,
                  onPress: () => {
                    setName(deviceLabel(menuFor));
                    setRenaming(menuFor);
                  },
                },
                {
                  label: '删除',
                  icon: Trash2,
                  destructive: true,
                  confirm: {
                    title: `删除「${deviceLabel(menuFor)}」？`,
                    message: `删除后需要重新配对才能 WiFi 连接。${menuFor.pcId === pcId ? '当前连接会断开。' : ''}`,
                  },
                  onPress: () => {
                    if (menuFor.pcId === pcId) disconnect();
                    void removeDevice(menuFor.pcId);
                  },
                },
              ]
            : []
        }
      />
      <Sheet visible={!!renaming} title="重命名" onClose={() => setRenaming(null)}>
        <FieldLabel>名称</FieldLabel>
        <Input value={name} onChangeText={setName} placeholder={renaming?.name} autoFocus />
        <Button
          onPress={() => {
            if (renaming) renameDevice(renaming.pcId, name);
            setRenaming(null);
          }}
        >
          <Text>保存</Text>
        </Button>
      </Sheet>
    </Screen>
  );
}
