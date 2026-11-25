// 插线自动连接页。电脑端通过 adb 下发 p2d://connect?token=..&host=.. 时，
// expo-router 会打开本页并带上参数；无需配对，拿到令牌后自动连接。

import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { Check, Monitor, Smartphone, Wifi, X } from 'lucide-react-native';
import { useEffect, useMemo } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Card, Separator } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { parseConnectQuery } from '@/protocol/deepLink';
import { PC_CLOSED_TEXT } from '@/protocol/types';
import { connectWith, initConnection, useConnection } from '@/state/connection';

type StepState = 'pending' | 'active' | 'done' | 'error';

export default function ConnectScreen() {
  const query = useLocalSearchParams();
  const linkParams = useMemo(() => parseConnectQuery(query), [query]);
  const { status, detail, params } = useConnection();
  // 渲染期间不能调用 router.canGoBack()（冷启动通过 Deep Link 直接打开本页时路由尚未就绪）
  const navigation = useNavigation();
  const canGoBack = navigation.canGoBack();

  // 带令牌打开本页时自动连接（与根布局里的链接处理是幂等的）
  useEffect(() => {
    if (!linkParams) return;
    void initConnection().then(() => connectWith(linkParams));
    // 只在令牌变化时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkParams?.token]);

  // 连接成功后回到 Agent 页
  useEffect(() => {
    if (status !== 'connected') return;
    const t = setTimeout(() => {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }, 800);
    return () => clearTimeout(t);
  }, [status]);

  const hasLink = !!params;
  // 用户在电脑上点了「断开」：不是出错，重新插拔数据线就能再连
  const pcClosed = status === 'idle' && !!detail?.startsWith(PC_CLOSED_TEXT);
  const host = params?.host ?? '电脑';
  const lastStep: StepState =
    status === 'connected'
      ? 'done'
      : status === 'unauthorized' || pcClosed
        ? 'error'
        : hasLink
          ? 'active'
          : 'pending';

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 gap-4 px-5 pt-8">
        {/* 手机 —— USB —— 电脑 */}
        <View className="flex-row items-center justify-center gap-3 py-4">
          <View className="h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
            <Icon as={Smartphone} size={28} className="text-primary" />
          </View>
          <View className="items-center">
            <Text className="text-[10px] font-semibold text-primary">USB</Text>
            <View className={cn('h-0.5 w-12', status === 'connected' ? 'bg-success' : 'bg-primary/60')} />
          </View>
          <View className="h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
            <Icon as={Monitor} size={28} className="text-primary" />
          </View>
        </View>

        <Text className="text-center text-xl font-bold">
          {status === 'connected' ? `已连接 ${host}` : pcClosed ? PC_CLOSED_TEXT : hasLink ? '正在连接电脑' : '连接电脑'}
        </Text>

        <Card className="px-3">
          <Step state={hasLink ? 'done' : 'pending'} label="数据线已连接" />
          <Separator />
          <Step state={hasLink ? 'done' : 'pending'} label="USB 调试已允许" />
          <Separator />
          <Step state={lastStep} label={hasLink ? `连接 ${host}` : '自动连接'} />
        </Card>

        {pcClosed ? (
          <Text className="text-center text-sm text-muted-foreground">在电脑上点了「断开」。重新插拔数据线就能再次连接</Text>
        ) : null}
        {status === 'unauthorized' ? (
          <Text className="text-center text-sm text-destructive">{detail ?? '令牌无效，请重新插拔数据线'}</Text>
        ) : null}
        {!hasLink ? (
          <Text className="text-center text-sm text-muted-foreground">
            用数据线连接电脑，并在手机上允许 USB 调试。连上一次后会自动配对，之后在同一 WiFi 下拔掉数据线也能继续用
          </Text>
        ) : null}

        <View className="flex-1" />

        <Button variant="outline" className="mb-2" onPress={() => router.replace('/devices')}>
          <Icon as={Wifi} size={16} className="text-foreground" />
          <Text>选择电脑 / WiFi 连接</Text>
        </Button>

        {canGoBack ? (
          <Button variant="ghost" className="mb-4" onPress={() => router.back()}>
            <Text>返回</Text>
          </Button>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function Step({ state, label }: { state: StepState; label: string }) {
  return (
    <View className="flex-row items-center gap-3 py-3">
      {state === 'active' ? (
        <ActivityIndicator size="small" color="#2563eb" />
      ) : (
        <View
          className={cn(
            'h-5 w-5 items-center justify-center rounded-full',
            state === 'done' && 'bg-success/15',
            state === 'error' && 'bg-destructive/15',
            state === 'pending' && 'border border-border',
          )}>
          {state === 'done' ? <Icon as={Check} size={12} className="text-success-foreground" /> : null}
          {state === 'error' ? <Icon as={X} size={12} className="text-destructive" /> : null}
        </View>
      )}
      <Text className={cn('flex-1 text-sm', state === 'active' && 'font-semibold', state === 'pending' && 'text-muted-foreground')}>
        {label}
      </Text>
    </View>
  );
}
