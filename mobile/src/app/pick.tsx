// 「选择电脑」页：打开 App 时先显示（记过电脑才显示，每次启动一次）。
// 列出记住的电脑和它们的地址，同时探测哪些现在能连上；点一台就连（有 USB 令牌先用 USB，否则 WiFi）。
// 开着「自动连接」（设置里，默认开）时，上次用的电脑会自动连，连上后自动进入 App；右上角「跳过」直接进入。

import { router } from 'expo-router';
import { Check, Monitor, Plug, Plus, RefreshCw, Wifi } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { connectPicked, findReachable, hasUsbFor, osLabel, useConnection } from '@/state/connection';
import { deviceLabel, devicesStore, useDevices, type PcDevice } from '@/state/devices';

type Probe = { state: 'checking' } | { state: 'online'; addr: string } | { state: 'offline' };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 能探测 WiFi 的电脑：配对过、知道端口 */
const probeable = (list: PcDevice[]) => list.filter((d) => d.paired && d.port);
const checking = (list: PcDevice[]): Record<string, Probe> => Object.fromEntries(probeable(list).map((d) => [d.pcId, { state: 'checking' }]));

function leave() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

export default function PickScreen() {
  const { devices, autoConnect } = useDevices();
  const { status, pcId, route, addr } = useConnection();
  const [probes, setProbes] = useState<Record<string, Probe>>(() => checking(devices));
  const [error, setError] = useState<string | null>(null);
  const probeSeq = useRef(0);
  const current = devices.find((d) => d.pcId === pcId);

  // 探测每台配对过的电脑现在能不能 WiFi 连上（同时探测，互不等待）。
  // 只在打开页面和点「刷新」时探测，设备信息更新（如连上后刷新地址）不重新探测
  const runProbe = useCallback((list: PcDevice[]) => {
    const seq = ++probeSeq.current;
    for (const d of probeable(list)) {
      findReachable([d.lastAddr ?? '', ...d.addrs], d.port, d.pcId)
        .then((a) => seq === probeSeq.current && setProbes((p) => ({ ...p, [d.pcId]: { state: 'online', addr: a } })))
        .catch(() => seq === probeSeq.current && setProbes((p) => ({ ...p, [d.pcId]: { state: 'offline' } })));
    }
  }, []);
  useEffect(() => {
    runProbe(devicesStore.get().devices);
  }, [runProbe]);
  const probe = () => {
    setProbes(checking(devices));
    runProbe(devices);
  };

  // 连上后稍等一下（让用户看到「已连接」）自动进入 App
  useEffect(() => {
    if (status !== 'connected') return;
    const t = setTimeout(leave, 900);
    return () => clearTimeout(t);
  }, [status, pcId]);

  const pick = (d: PcDevice) => {
    setError(null);
    if (!d.paired && !hasUsbFor(d.pcId)) {
      setError(`「${deviceLabel(d)}」还没有配对：插一次数据线会自动配对，或者在电脑端窗口点「配对新手机」后到「设备」里添加。`);
      return;
    }
    void connectPicked(d.pcId).catch((e) => setError(errText(e)));
  };

  return (
    <SafeAreaView edges={['top', 'bottom']} className="flex-1 bg-background">
      <View className="flex-row items-center gap-2 px-5 pb-2 pt-3">
        <View className="flex-1">
          <Text className="text-xl font-bold">选择电脑</Text>
          <Text className="text-xs text-muted-foreground">
            {status === 'connected'
              ? `已连接「${deviceLabel(current)}」，马上进入`
              : status === 'connecting' || status === 'disconnected'
                ? `正在连接「${deviceLabel(current)}」…也可以点别的电脑`
                : '点一台电脑连接'}
          </Text>
        </View>
        <Pressable onPress={probe} hitSlop={8} className="h-9 w-9 items-center justify-center" accessibilityLabel="重新检测">
          <Icon as={RefreshCw} size={17} className="text-muted-foreground" />
        </Pressable>
        <Pressable onPress={leave} hitSlop={8} className="h-9 items-center justify-center px-2" accessibilityLabel="跳过">
          <Text className="text-[15px] text-primary">跳过</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="gap-3 px-4 pb-6 pt-2">
        {devices.map((d) => (
          <DeviceItem
            key={d.pcId}
            d={d}
            probe={probes[d.pcId]}
            current={d.pcId === pcId}
            status={d.pcId === pcId ? status : 'idle'}
            route={d.pcId === pcId ? route : null}
            addr={d.pcId === pcId ? addr : null}
            onPress={() => pick(d)}
          />
        ))}

        {error ? <Text className="px-1 text-xs leading-5 text-destructive">{error}</Text> : null}

        <Pressable
          onPress={() => router.replace('/devices')}
          className="flex-row items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-3 active:bg-muted"
        >
          <Icon as={Plus} size={15} className="text-muted-foreground" />
          <Text className="text-sm text-muted-foreground">添加 / 管理电脑</Text>
        </Pressable>

        <Text className="px-1 text-xs leading-5 text-muted-foreground">
          {autoConnect
            ? '自动连接已开启：打开 App 时自动连上次用的电脑，插着数据线时用 USB，否则用 WiFi。可以在「设置」里关闭。'
            : '自动连接已关闭，可以在「设置」里打开。插上数据线时电脑端仍会自动连接。'}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function DeviceItem({
  d,
  probe,
  current,
  status,
  route,
  addr,
  onPress,
}: {
  d: PcDevice;
  probe?: Probe;
  current: boolean;
  status: string;
  route: string | null;
  addr: string | null;
  onPress: () => void;
}) {
  const usb = hasUsbFor(d.pcId);
  const connected = status === 'connected';
  const connecting = status === 'connecting' || status === 'disconnected';
  // 地址：连着的用实际地址，其次探测到的，再次记住的
  const ip = (connected && route === 'wifi' && addr) || (probe?.state === 'online' ? probe.addr : '') || d.lastAddr || d.addrs[0] || '';
  const reach = connected
    ? `已连接 · ${route === 'usb' ? 'USB 数据线' : 'WiFi'}`
    : connecting
      ? '正在连接…'
      : !d.paired
        ? '未配对'
        : probe?.state === 'online'
          ? '在线'
          : probe?.state === 'offline'
            ? '没找到（不在同一网络或电脑端没打开）'
            : probe?.state === 'checking'
              ? '检测中…'
              : '';
  return (
    <Pressable onPress={onPress} disabled={connecting && current}>
      <Card className={cn('gap-2 p-3.5', current && (connected || connecting) && 'border-primary/50')}>
        <View className="flex-row items-center gap-3">
          <View className={cn('h-10 w-10 items-center justify-center rounded-full', current ? 'bg-primary/10' : 'bg-muted')}>
            <Icon as={Monitor} size={18} className={current ? 'text-primary' : 'text-foreground'} />
          </View>
          <View className="flex-1 gap-0.5">
            <Text numberOfLines={1} className="font-semibold">
              {deviceLabel(d)}
            </Text>
            <Text numberOfLines={1} className="text-xs text-muted-foreground">
              {[osLabel(d.os), ip].filter(Boolean).join(' · ')}
            </Text>
          </View>
          {connected ? (
            <View className="h-7 w-7 items-center justify-center rounded-full bg-success/15">
              <Icon as={Check} size={15} className="text-success-foreground" />
            </View>
          ) : connecting && current ? (
            <ActivityIndicator size="small" color="#2563eb" />
          ) : null}
        </View>
        <View className="flex-row items-center gap-2">
          {usb ? <Tag icon={Plug} label="USB" /> : null}
          {d.paired ? <Tag icon={Wifi} label="WiFi" /> : null}
          <Text
            numberOfLines={1}
            className={cn(
              'flex-1 text-xs',
              connected || probe?.state === 'online' ? 'text-success-foreground' : 'text-muted-foreground',
            )}
          >
            {reach}
          </Text>
        </View>
      </Card>
    </Pressable>
  );
}

function Tag({ icon, label }: { icon: typeof Wifi; label: string }) {
  return (
    <View className="flex-row items-center gap-1 rounded-md bg-muted px-1.5 py-0.5">
      <Icon as={icon} size={11} className="text-muted-foreground" />
      <Text className="text-[11px] text-muted-foreground">{label}</Text>
    </View>
  );
}
