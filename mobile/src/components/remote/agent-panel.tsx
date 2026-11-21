// 虚拟桌面页下方的 Agent 消息面板：使用应用主题色，实时显示和 Agent 的对话、执行的步骤。

import { Bot, Check, Loader, X } from 'lucide-react-native';
import { useRef } from 'react';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance } from 'react-native';

import type { LiveAction, Step, UiItem } from '@/agent/conversations';
import { ChoiceCard } from '@/components/agent/choice-card';
import { liveText } from '@/components/agent/live-label';
import { Markdown } from '@/components/markdown';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** 面板只显示最近这么多条，避免长对话卡顿 */
const MAX_ITEMS = 40;

function StepLine({ s }: { s: Step }) {
  return (
    <View className="flex-row items-center gap-1.5">
      {s.status === 'running' ? (
        <Icon as={Loader} size={11} className="text-primary" />
      ) : s.status === 'error' ? (
        <Icon as={X} size={11} className="text-destructive" />
      ) : (
        <Icon as={Check} size={11} className="text-success-foreground" />
      )}
      <Text className="font-mono text-[10px]">{s.name}</Text>
      <Text numberOfLines={1} className={cn('flex-1 text-[11px]', s.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
        {s.status === 'error' && s.result ? s.result : s.summary}
      </Text>
    </View>
  );
}

function PanelItem({ item }: { item: UiItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <View className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-primary px-3 py-2">
          <Text selectable className="text-sm text-primary-foreground">
            {item.text || (item.attachments?.length ? `[${item.attachments.length} 个附件]` : '')}
          </Text>
        </View>
      );
    case 'assistant':
      return item.text ? (
        <View className="max-w-[92%] self-start rounded-2xl rounded-bl-md bg-muted px-3 py-2">
          <Markdown text={item.text} />
        </View>
      ) : null;
    case 'steps':
      return (
        <View className="gap-1 self-stretch rounded-xl border border-border bg-card px-3 py-2">
          {item.steps.slice(-6).map((s) => (
            <StepLine key={s.id} s={s} />
          ))}
          {item.steps.length > 6 ? <Text className="text-[10px] text-muted-foreground">{`共 ${item.steps.length} 步`}</Text> : null}
        </View>
      );
    case 'choice':
      return <ChoiceCard item={item} compact />;
    case 'notice':
      return (
        <Text
          className={cn('self-center px-2 text-center text-[11px]', item.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}
        >
          {item.text}
        </Text>
      );
  }
}

export function AgentPanel({ items, running, live }: { items: UiItem[]; running: boolean; live: LiveAction | null }) {
  const scrollRef = useRef<ScrollViewInstance>(null);
  const follow = useRef(true);
  const dragging = useRef(false);
  const settle = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    follow.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
  };
  const shown = items.slice(-MAX_ITEMS);
  const status = running ? liveText(live, true) : '';

  return (
    <View className="flex-1 overflow-hidden rounded-2xl border border-border bg-background">
      <ScrollView
        ref={scrollRef}
        contentContainerClassName="gap-2 p-3"
        // 和 Agent 页一样：手指按着或往上翻看时不自动滚到底，回到底部后恢复跟随
        onScrollBeginDrag={() => {
          follow.current = false;
          dragging.current = true;
        }}
        onScrollEndDrag={(e) => {
          dragging.current = false;
          settle(e);
        }}
        onMomentumScrollEnd={settle}
        onContentSizeChange={() => {
          if (follow.current && !dragging.current) scrollRef.current?.scrollToEnd({ animated: false });
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {shown.length === 0 ? (
          <View className="flex-row items-center gap-2 self-stretch rounded-xl bg-muted px-3 py-2">
            <Icon as={Bot} size={14} className="text-primary" />
            <Text className="flex-1 text-[13px] text-muted-foreground">在下面告诉 Agent 要做什么，这里会实时显示它的操作</Text>
          </View>
        ) : (
          shown.map((it) => (
            <Animated.View key={it.id} entering={FadeInDown.duration(200)}>
              <PanelItem item={it} />
            </Animated.View>
          ))
        )}
      </ScrollView>

      {status ? (
        <View className="flex-row items-center gap-1.5 border-t border-border bg-muted px-3 py-1.5">
          <Icon as={Bot} size={12} className="text-primary" />
          <Text numberOfLines={1} className="flex-1 text-[11px] text-muted-foreground">
            {status}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
