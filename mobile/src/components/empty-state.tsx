import type { LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';

/** 占位页的空状态 */
export function EmptyState({ icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-3 py-16">
      <View className="h-14 w-14 items-center justify-center rounded-2xl bg-muted">
        <Icon as={icon} size={26} className="text-muted-foreground" />
      </View>
      <Text className="text-sm text-muted-foreground">{title}</Text>
    </View>
  );
}
