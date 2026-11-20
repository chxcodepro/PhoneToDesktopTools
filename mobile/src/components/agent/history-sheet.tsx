// 历史对话列表（底部弹出）。

import { MessageSquare, Trash2, X } from 'lucide-react-native';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { deleteConversation, openConversation, useConversation } from '@/agent/conversations';
import { cn } from '@/lib/utils';

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function HistorySheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { list, currentId } = useConversation();
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/40" onPress={onClose} />
      <SafeAreaView edges={['bottom']} className="max-h-[70%] rounded-t-2xl bg-background">
        <View className="flex-row items-center justify-between px-4 py-3">
          <Text className="text-base font-bold">历史对话</Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <Icon as={X} size={18} className="text-muted-foreground" />
          </Pressable>
        </View>
        <ScrollView contentContainerClassName="px-2 pb-4">
          {list.length === 0 ? <Text className="py-8 text-center text-sm text-muted-foreground">暂无历史对话</Text> : null}
          {list.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => {
                void openConversation(c.id);
                onClose();
              }}
              className={cn('flex-row items-center gap-3 rounded-lg px-3 py-3 active:bg-accent', c.id === currentId && 'bg-accent')}
            >
              <Icon as={MessageSquare} size={16} className="text-muted-foreground" />
              <View className="flex-1">
                <Text numberOfLines={1} className="text-sm">
                  {c.title}
                </Text>
                <Text className="text-xs text-muted-foreground">{timeLabel(c.updatedAt)}</Text>
              </View>
              <Pressable onPress={() => void deleteConversation(c.id)} hitSlop={10}>
                <Icon as={Trash2} size={16} className="text-muted-foreground" />
              </Pressable>
            </Pressable>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
