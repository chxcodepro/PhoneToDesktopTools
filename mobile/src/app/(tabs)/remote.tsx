// 远程桌面页：M5 实现，当前为占位。

import { MonitorPlay } from 'lucide-react-native';

import { ConnectionSubtitle } from '@/components/connection-status';
import { EmptyState } from '@/components/empty-state';
import { Screen } from '@/components/screen';

export default function RemoteScreen() {
  return (
    <Screen title="远程桌面" subtitle={<ConnectionSubtitle />} scroll={false}>
      <EmptyState icon={MonitorPlay} title="远程桌面即将上线" />
    </Screen>
  );
}
