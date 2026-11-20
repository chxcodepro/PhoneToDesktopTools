// Agent 页：M3 实现对话；当前只放占位，开发版附带工具调试面板。

import { Bot } from 'lucide-react-native';

import { ConnectionSubtitle, NotConnectedCard } from '@/components/connection-status';
import { EmptyState } from '@/components/empty-state';
import { Screen } from '@/components/screen';
import { ToolDebugPanel } from '@/components/tool-debug-panel';
import { useConnection } from '@/state/connection';

export default function AgentScreen() {
  const { status } = useConnection();
  const connected = status === 'connected';

  return (
    <Screen title="Agent" subtitle={<ConnectionSubtitle />}>
      {!connected && status !== 'connecting' && status !== 'disconnected' ? <NotConnectedCard /> : null}
      {__DEV__ && connected ? <ToolDebugPanel /> : null}
      {!__DEV__ ? <EmptyState icon={Bot} title="Agent 对话即将上线" /> : null}
    </Screen>
  );
}
