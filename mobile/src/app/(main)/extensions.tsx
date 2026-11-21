// 扩展页（MCP / Skill）：M7 实现，当前为占位。

import { Puzzle } from 'lucide-react-native';

import { EmptyState } from '@/components/empty-state';
import { Screen } from '@/components/screen';

export default function ExtensionsScreen() {
  return (
    <Screen title="扩展" scroll={false}>
      <EmptyState icon={Puzzle} title="MCP / Skill 即将上线" />
    </Screen>
  );
}
