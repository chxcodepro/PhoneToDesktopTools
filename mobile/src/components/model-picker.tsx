// 模型很多时的选择框：从底部弹出，顶部搜索，默认隐藏向量 / 语音 / 绘图等不能对话的模型。

import { Check, Search, X } from 'lucide-react-native';
import { useState } from 'react';
import { FlatList, Modal, Pressable, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { filterModels } from '@/agent/modelList';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

export function ModelPicker({
  visible,
  models,
  selected,
  onSelect,
  onClose,
}: {
  visible: boolean;
  models: string[];
  selected: string;
  onSelect: (model: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const { items, hidden } = filterModels(models, query, { hideNonChat: !showAll, selected });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="h-[12%] bg-black/40" onPress={onClose} />
      <SafeAreaView edges={['bottom']} className="flex-1 rounded-t-3xl bg-background">
        <View className="flex-row items-center gap-2 px-4 pb-2 pt-4">
          <Text className="flex-1 text-base font-semibold">{`选择模型（共 ${models.length} 个）`}</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="关闭">
            <Icon as={X} size={18} className="text-muted-foreground" />
          </Pressable>
        </View>

        <View className="mx-4 h-11 flex-row items-center gap-2 rounded-full bg-muted px-4">
          <Icon as={Search} size={16} className="text-muted-foreground" />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索模型，如 gpt-4o、mini"
            placeholderTextColor="#94a3b8"
            autoCapitalize="none"
            autoCorrect={false}
            textAlignVertical="center"
            className="h-11 flex-1 py-0 text-sm text-foreground"
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <Icon as={X} size={14} className="text-muted-foreground" />
            </Pressable>
          ) : null}
        </View>

        <View className="flex-row items-center gap-2 px-5 py-2.5">
          <Text className="flex-1 text-xs text-muted-foreground">
            {showAll ? '显示全部模型' : hidden ? `已隐藏 ${hidden} 个不能对话的模型（向量、语音、绘图等）` : '只显示对话模型'}
          </Text>
          <Text className="text-xs text-muted-foreground">显示全部</Text>
          <Switch checked={showAll} onCheckedChange={setShowAll} />
        </View>

        <FlatList
          data={items}
          keyExtractor={(m) => m}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={30}
          contentContainerClassName="px-2 pb-4"
          ListEmptyComponent={<Text className="py-10 text-center text-sm text-muted-foreground">没有匹配的模型</Text>}
          renderItem={({ item }) => {
            const on = item === selected;
            return (
              <Pressable
                onPress={() => {
                  onSelect(item);
                  onClose();
                }}
                className={cn('flex-row items-center gap-3 rounded-xl px-3 py-3 active:bg-muted', on && 'bg-primary/10')}
              >
                <Text numberOfLines={1} className={cn('flex-1 text-sm', on && 'font-medium text-primary')}>
                  {item}
                </Text>
                {on ? <Icon as={Check} size={16} className="text-primary" /> : null}
              </Pressable>
            );
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}
