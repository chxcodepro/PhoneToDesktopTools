// 用系统相机扫电脑端「配对新手机」的二维码（p2d://pair?...）会打开本页：交给「设备」页完成配对。

import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { parsePairUrl } from '@/protocol/deepLink';
import { pendingPairStore } from '@/state/pairing';

export default function PairLinkScreen() {
  const q = useLocalSearchParams<{ h?: string; p?: string; id?: string; n?: string; s?: string }>();
  useEffect(() => {
    const qs = Object.entries(q)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(Array.isArray(v) ? v[0] : (v ?? '')))}`)
      .join('&');
    const link = parsePairUrl(`p2d://pair?${qs}`);
    if (link) pendingPairStore.set({ link });
    router.replace('/devices');
  }, [q]);
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-background">
      <ActivityIndicator color="#2563eb" />
      <Text className="text-sm text-muted-foreground">正在打开配对…</Text>
    </View>
  );
}
