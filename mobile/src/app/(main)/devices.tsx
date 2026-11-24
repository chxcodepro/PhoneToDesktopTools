// 设备页：记住的电脑排成圆角方块，点一下连接。
// - 还没连电脑时，点的那台作为当前电脑；已经连着一台时，点别的电脑就「同时连接」（Agent 可以一起操作）。
// - 方块上：系统图标（Win11 / Win10 / Win7 / 银河麒麟 / Linux 等）、名称、IP，下面是 WiFi / USB 标签（当前电脑点标签切换线路）。
// - 「⋯」或长按：设为当前电脑、断开、重命名、删除。
// - 附近的电脑：扫描手机所在网段，发现电脑端后点一下连接或添加；不在同一个 WiFi 时提示用 Tailscale。
// 每台电脑有各自的对话：切换当前电脑后，Agent 页显示那台电脑的对话。

import { router } from 'expo-router';
import { Check, Layers, Monitor, MoreHorizontal, Pencil, Plus, Radar, RefreshCw, Star, Trash2, Unlink } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, View } from 'react-native';

import { conversationStore, stop } from '@/agent/conversations';
import { ActionSheet, askConfirm } from '@/components/action-sheet';
import { AddPcSheet } from '@/components/devices/add-pc-sheet';
import { BackgroundCard } from '@/components/devices/background-card';
import { OsIcon } from '@/components/devices/os-icon';
import { Screen } from '@/components/screen';
import { FieldLabel, Sheet } from '@/components/sheet';
import { Button } from '@/components/ui/button';
import { Card, GroupTitle } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import {
  canUseUsb,
  connectDevice,
  connectPicked,
  disconnect,
  hasUsbFor,
  switchRoute,
  useConnection,
  type ConnectionState,
} from '@/state/connection';
import { deviceLabel, removeDevice, renameDevice, setPreferUsb, useDevices, type PcDevice } from '@/state/devices';
import { scanLan, useDiscovery, type FoundPc } from '@/state/discovery';
import { connectExtra, disconnectExtra, useMulti, type ExtraConn } from '@/state/multi';
import { osInfo } from '@/state/osInfo';
import { pendingPairStore } from '@/state/pairing';
import { useStore } from '@/state/store';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Agent 正在执行时切换当前电脑要先停止 */
function confirmSwitch(action: () => void): void {
  if (!conversationStore.get().running) return action();
  askConfirm({ title: 'Agent 正在执行任务', message: '切换电脑会停止当前任务。', confirmText: '停止并切换', icon: Monitor }, () => {
    stop();
    action();
  });
}

/** 方块左上角的状态 */
type TileState = { text: string; tone: 'ok' | 'busy' | 'extra' | 'none' };

function tileState(d: PcDevice, conn: ConnectionState, extra: ExtraConn | undefined, wanted: boolean): TileState {
  if (d.pcId === conn.pcId && conn.status !== 'idle') {
    if (conn.status === 'connected') return { text: '当前', tone: 'ok' };
    return { text: '连接中', tone: 'busy' };
  }
  if (wanted) {
    if (extra?.status === 'connected') return { text: '同时连接', tone: 'extra' };
    if (extra && extra.status !== 'idle' && extra.status !== 'unauthorized') return { text: '连接中', tone: 'busy' };
    return { text: '没连上', tone: 'none' };
  }
  return { text: '', tone: 'none' };
}

/** WiFi / USB 圆角标签：亮起表示正在用这条线路，灰色表示不可用 */
function RouteChip({ label, on, available, onPress }: { label: string; on: boolean; available: boolean; onPress?: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress || on || !available}
      hitSlop={4}
      className={cn(
        'rounded-full border px-2 py-0.5',
        on ? 'border-primary bg-primary/10' : 'border-border bg-background',
        !available && !on && 'opacity-40',
      )}
    >
      <Text className={cn('text-[10px]', on ? 'font-medium text-primary' : 'text-muted-foreground')}>{label}</Text>
    </Pressable>
  );
}

function DeviceTile({
  d,
  state,
  ip,
  route,
  isCurrent,
  onPress,
  onMore,
  onRoute,
}: {
  d: PcDevice;
  state: TileState;
  ip: string;
  /** 当前电脑正在用的线路 */
  route: 'usb' | 'wifi' | null;
  isCurrent: boolean;
  onPress: () => void;
  onMore: () => void;
  onRoute: (r: 'usb' | 'wifi') => void;
}) {
  const os = osInfo(d.os, d.osName);
  const usb = isCurrent ? canUseUsb(d.pcId) : hasUsbFor(d.pcId);
  return (
    <Pressable onPress={onPress} onLongPress={onMore} style={{ width: '48.5%' }}>
      <View
        className={cn(
          'aspect-square items-center justify-center gap-1 rounded-3xl border bg-card px-2',
          state.tone === 'ok' ? 'border-primary' : state.tone === 'extra' ? 'border-primary/50' : 'border-border',
        )}
      >
        {state.text ? (
          <View
            className={cn(
              'absolute left-2.5 top-2.5 flex-row items-center gap-1 rounded-full px-2 py-0.5',
              state.tone === 'ok' ? 'bg-success/15' : state.tone === 'extra' ? 'bg-primary/10' : 'bg-muted',
            )}
          >
            {state.tone === 'busy' ? <ActivityIndicator size={10} color="#2563eb" /> : null}
            {state.tone === 'ok' ? <Icon as={Check} size={10} className="text-success-foreground" /> : null}
            {state.tone === 'extra' ? <Icon as={Layers} size={10} className="text-primary" /> : null}
            <Text
              className={cn(
                'text-[10px]',
                state.tone === 'ok' ? 'text-success-foreground' : state.tone === 'extra' ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              {state.text}
            </Text>
          </View>
        ) : null}
        <Pressable onPress={onMore} hitSlop={10} className="absolute right-2 top-2 h-7 w-7 items-center justify-center" accessibilityLabel="更多">
          <Icon as={MoreHorizontal} size={16} className="text-muted-foreground" />
        </Pressable>

        <OsIcon family={os.family} size={40} />
        <Text className="text-[10px] text-muted-foreground">{os.label}</Text>
        <Text numberOfLines={1} className="max-w-full text-[15px] font-semibold">
          {deviceLabel(d)}
        </Text>
        <Text numberOfLines={1} className="text-[11px] text-muted-foreground">
          {ip || (d.paired ? '—' : '未配对')}
        </Text>
        <View className="mt-0.5 flex-row gap-1.5">
          <RouteChip
            label="WiFi"
            on={isCurrent && route === 'wifi'}
            available={d.paired}
            onPress={isCurrent ? () => onRoute('wifi') : undefined}
          />
          <RouteChip label="USB" on={isCurrent && route === 'usb'} available={usb} onPress={isCurrent ? () => onRoute('usb') : undefined} />
        </View>
      </View>
    </Pressable>
  );
}

/** 附近发现的一台电脑 */
function FoundRow({ f, known, onPress }: { f: FoundPc; known: PcDevice | undefined; onPress: () => void }) {
  const os = osInfo(f.os, f.osName);
  const action = known?.paired ? '连接' : '添加';
  return (
    <Card className="flex-row items-center gap-3 p-3">
      <OsIcon family={os.family} size={30} />
      <View className="flex-1">
        <Text numberOfLines={1} className="font-medium">
          {known ? deviceLabel(known) : f.name}
        </Text>
        <Text numberOfLines={1} className="text-xs text-muted-foreground">
          {[os.label, f.host, known?.paired ? '已配对' : '未配对'].join(' · ')}
        </Text>
      </View>
      <Button size="sm" variant={known?.paired ? 'outline' : 'default'} onPress={onPress}>
        <Text>{action}</Text>
      </Button>
    </Card>
  );
}

export default function DevicesScreen() {
  const { devices, preferUsb } = useDevices();
  const conn = useConnection();
  const { pcId, status, route, addr } = conn;
  const multi = useMulti();
  const scan = useDiscovery();
  const pending = useStore(pendingPairStore).link;
  const [adding, setAdding] = useState(false);
  const [addHost, setAddHost] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<PcDevice | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 菜单关闭后保留 menuFor：面板淡出时内容不变
  const [menuFor, setMenuFor] = useState<PcDevice | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // 进入页面时扫描一次附近的电脑（一分钟内扫过就不再扫）
  useEffect(() => {
    if (Date.now() - scan.finishedAt > 60_000) void scanLan();
    // 只在进入页面时
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasCurrent = !!pcId && status !== 'idle';
  const fail = (e: unknown) => setError(errText(e));

  const openMenu = (d: PcDevice) => {
    setMenuFor(d);
    setMenuOpen(true);
  };

  /** 设为当前电脑（原来同时连接着的先断开那条） */
  const makeCurrent = (d: PcDevice) =>
    confirmSwitch(() => {
      if (multi.wanted.includes(d.pcId)) disconnectExtra(d.pcId);
      void connectDevice(d.pcId).catch(fail);
    });

  const onTile = (d: PcDevice) => {
    setError(null);
    // 已经连着的：打开菜单（断开、设为当前电脑等）
    if ((d.pcId === pcId && hasCurrent) || multi.wanted.includes(d.pcId)) return openMenu(d);
    if (!d.paired && !hasUsbFor(d.pcId)) {
      Alert.alert('还没有配对', '插一次数据线会自动配对；或者在电脑端窗口点「配对新手机」，再点右上角「添加」扫码 / 输入 IP。');
      return;
    }
    if (hasCurrent) {
      // 已经连着一台：同时连接，Agent 可以一起操作
      if (!d.paired) {
        Alert.alert('还没有配对', '同时连接走 WiFi，要先配对：在电脑端窗口点「配对新手机」，再点右上角「添加」。');
        return;
      }
      void connectExtra(d.pcId).catch(fail);
      return;
    }
    void connectPicked(d.pcId).catch(fail);
  };

  /** 附近的电脑：配对过的直接连，没配对过的打开添加（自动带上 IP） */
  const onFound = (f: FoundPc) => {
    const known = devices.find((d) => d.pcId === f.pcId);
    if (known?.paired) return onTile(known);
    setAddHost(f.host);
    setAdding(true);
  };

  const ipOf = (d: PcDevice) => (d.pcId === pcId && route === 'wifi' && addr ? addr : d.lastAddr || d.addrs[0] || '');

  return (
    <Screen
      title="设备"
      right={
        <Pressable
          onPress={() => {
            setAddHost(null);
            setAdding(true);
          }}
          hitSlop={8}
          className="flex-row items-center gap-1"
          accessibilityLabel="添加电脑"
        >
          <Icon as={Plus} size={16} className="text-primary" />
          <Text className="text-sm text-primary">添加</Text>
        </Pressable>
      }
    >
      <BackgroundCard />
      {error ? (
        <Pressable onPress={() => setError(null)}>
          <Text className="px-1 text-xs text-destructive">{error}</Text>
        </Pressable>
      ) : null}

      <GroupTitle>{hasCurrent ? '我的电脑 · 点别的电脑同时连接' : '我的电脑 · 点一下连接'}</GroupTitle>
      {devices.length ? (
        <View className="flex-row flex-wrap justify-between gap-y-3">
          {devices.map((d) => (
            <DeviceTile
              key={d.pcId}
              d={d}
              state={tileState(d, conn, multi.conns[d.pcId], multi.wanted.includes(d.pcId))}
              ip={ipOf(d)}
              route={d.pcId === pcId && status === 'connected' ? route : null}
              isCurrent={d.pcId === pcId && hasCurrent}
              onPress={() => onTile(d)}
              onMore={() => openMenu(d)}
              onRoute={(r) => void switchRoute(r).catch(fail)}
            />
          ))}
        </View>
      ) : (
        <Text className="px-1 py-4 text-center text-sm text-muted-foreground">还没有记录。用数据线连一次电脑，或点下面发现的电脑、右上角「添加」。</Text>
      )}

      {/* 附近的电脑 */}
      <View className="mt-2 flex-row items-center">
        <GroupTitle className="flex-1">{scan.subnet ? `附近的电脑 · ${scan.subnet}` : '附近的电脑'}</GroupTitle>
        <Pressable
          onPress={() => void scanLan()}
          disabled={scan.scanning}
          hitSlop={8}
          className="flex-row items-center gap-1 px-1"
          accessibilityLabel="重新扫描"
        >
          {scan.scanning ? <ActivityIndicator size="small" color="#2563eb" /> : <Icon as={RefreshCw} size={14} className="text-primary" />}
          <Text className="text-xs text-primary">{scan.scanning ? `扫描中 ${Math.round(scan.progress * 100)}%` : '扫描'}</Text>
        </Pressable>
      </View>
      {scan.found.map((f) => (
        <FoundRow key={f.pcId} f={f} known={devices.find((d) => d.pcId === f.pcId)} onPress={() => onFound(f)} />
      ))}
      {!scan.scanning && !scan.found.length ? (
        <Card className="flex-row items-center gap-3 p-3">
          <Icon as={Radar} size={18} className="text-muted-foreground" />
          <Text className="flex-1 text-xs leading-5 text-muted-foreground">
            {scan.error ?? (scan.finishedAt ? '没有发现电脑：确认电脑端开着，并且和手机在同一个 WiFi。' : '正在准备扫描…')}
          </Text>
        </Card>
      ) : null}
      <Text className="px-1 text-xs leading-5 text-muted-foreground">
        不在同一个 WiFi（如在公司连家里的电脑）？电脑和手机都装上 Tailscale 并登录同一个账号，再点右上角「添加 → 输入电脑 IP」，填电脑在 Tailscale 里 100 开头的地址。
      </Text>

      <Card className="mt-2 flex-row items-center gap-3 p-3">
        <View className="flex-1">
          <Text className="text-sm">插上数据线时自动切到 USB</Text>
          <Text className="text-xs text-muted-foreground">USB 更稳定、延迟更低；关闭后插线也继续用 WiFi</Text>
        </View>
        <Switch checked={preferUsb} onCheckedChange={setPreferUsb} />
      </Card>
      <Button variant="ghost" size="sm" onPress={() => router.push('/remote')}>
        <Text className="text-primary">打开虚拟桌面</Text>
      </Button>

      <AddPcSheet
        visible={adding || !!pending}
        initialLink={pending}
        initialHost={pending ? null : addHost}
        onClose={() => {
          setAdding(false);
          setAddHost(null);
          pendingPairStore.set({ link: null });
          // 刚添加的电脑在「附近的电脑」里显示为已配对
          void scanLan();
        }}
      />
      <ActionSheet
        visible={menuOpen}
        icon={Monitor}
        title={deviceLabel(menuFor ?? undefined)}
        subtitle={menuFor ? [osInfo(menuFor.os, menuFor.osName).label, menuFor.addrs.slice(0, 3).join('、')].filter(Boolean).join(' · ') : undefined}
        onClose={() => setMenuOpen(false)}
        actions={
          menuFor
            ? [
                ...(menuFor.pcId === pcId && hasCurrent
                  ? [{ label: '断开', icon: Unlink, onPress: disconnect }]
                  : [
                      ...(menuFor.paired || hasUsbFor(menuFor.pcId)
                        ? [{ label: hasCurrent ? '设为当前电脑（切换过去）' : '连接', icon: Star, onPress: () => makeCurrent(menuFor) }]
                        : []),
                      ...(hasCurrent && menuFor.paired
                        ? [
                            multi.wanted.includes(menuFor.pcId)
                              ? { label: '断开同时连接', icon: Unlink, onPress: () => disconnectExtra(menuFor.pcId) }
                              : {
                                  label: '同时连接（Agent 可一起操作）',
                                  icon: Layers,
                                  onPress: () => void connectExtra(menuFor.pcId).catch(fail),
                                },
                          ]
                        : []),
                    ]),
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
                    if (multi.wanted.includes(menuFor.pcId)) disconnectExtra(menuFor.pcId);
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
