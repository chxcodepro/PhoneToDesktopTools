import { router } from 'expo-router';
import { Monitor, Plug } from 'lucide-react-native';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import type { ConnectionStatus } from '@/protocol/types';
import { useConnection } from '@/state/connection';

export const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: '未连接',
  connecting: '正在连接',
  connected: '已连接',
  disconnected: '连接中断，正在重连',
  unauthorized: '请重新插拔数据线',
};

/** 状态圆点 */
export function StatusDot({ status, className }: { status: ConnectionStatus; className?: string }) {
  return (
    <View
      className={cn(
        'h-2 w-2 rounded-full',
        status === 'connected' && 'bg-success',
        (status === 'connecting' || status === 'disconnected') && 'bg-warning',
        (status === 'idle' || status === 'unauthorized') && 'bg-muted-foreground',
        className,
      )}
    />
  );
}

/** 标题下方的一行连接状态：● DESKTOP-01 */
export function ConnectionSubtitle() {
  const { status, params } = useConnection();
  return (
    <View className="flex-row items-center gap-1.5">
      <StatusDot status={status} />
      <Text className="text-xs text-muted-foreground">
        {params && status === 'connected' ? params.host : STATUS_LABEL[status]}
      </Text>
    </View>
  );
}

/** 未连接时的提示卡片 */
export function NotConnectedCard() {
  return (
    <Card>
      <CardContent className="items-center gap-3 py-6">
        <View className="h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <Icon as={Monitor} size={24} className="text-primary" />
        </View>
        <Text className="font-semibold">未连接电脑</Text>
        <Button onPress={() => router.push('/connect')}>
          <Icon as={Plug} size={16} className="text-primary-foreground" />
          <Text>连接电脑</Text>
        </Button>
      </CardContent>
    </Card>
  );
}
