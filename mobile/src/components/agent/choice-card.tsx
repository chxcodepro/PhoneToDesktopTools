// Agent 用 ask_user 弹出的选择卡片：单选点一下就提交，多选勾好后点「确定」，也可以选「其他」自己输入。
// 选完后卡片保留在对话里，显示用户的选择。

import { Check, CircleHelp, PenLine, Send } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { answerChoice, isChoiceWaiting, type ChoiceItem } from '@/agent/conversations';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

export function ChoiceCard({ item, compact }: { item: ChoiceItem; compact?: boolean }) {
  const waiting = item.status === 'pending' && isChoiceWaiting(item.id);
  const [picked, setPicked] = useState<string[]>([]);
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState('');

  const chosen = item.answer?.selected ?? [];
  const toggle = (label: string) => {
    if (!waiting) return;
    if (!item.multiple) {
      answerChoice(item.id, { selected: [label] });
      return;
    }
    setPicked((cur) => (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]));
  };
  const submit = () => {
    const c = custom.trim();
    if (!picked.length && !c) return;
    answerChoice(item.id, { selected: picked, custom: c || undefined });
  };

  const statusText =
    item.status === 'answered'
      ? '已选择'
      : item.status === 'cancelled'
        ? '已取消'
        : waiting
          ? item.multiple
            ? '可多选'
            : '请选择'
          : '已失效';

  return (
    <View className={cn('gap-2 self-stretch rounded-2xl border bg-card p-3', waiting ? 'border-primary/40' : 'border-border')}>
      <View className="flex-row items-start gap-2">
        <Icon as={CircleHelp} size={16} className={cn('mt-0.5', waiting ? 'text-primary' : 'text-muted-foreground')} />
        <Text className={cn('flex-1 font-medium', compact ? 'text-[13px]' : 'text-sm')}>{item.question}</Text>
        <Text className={cn('text-[11px]', waiting ? 'text-primary' : 'text-muted-foreground')}>{statusText}</Text>
      </View>

      {item.options.map((o) => {
        const on = waiting ? picked.includes(o.label) : chosen.includes(o.label);
        return (
          <Pressable
            key={o.label}
            onPress={() => toggle(o.label)}
            disabled={!waiting}
            className={cn(
              'flex-row items-center gap-2.5 rounded-xl border px-3 py-2.5',
              on ? 'border-primary bg-primary/10' : 'border-border bg-background',
              waiting && 'active:bg-muted',
              !waiting && !on && 'opacity-50',
            )}
          >
            {item.multiple ? (
              <View
                className={cn(
                  'h-4 w-4 items-center justify-center rounded border',
                  on ? 'border-primary bg-primary' : 'border-muted-foreground',
                )}
              >
                {on ? <Icon as={Check} size={11} className="text-primary-foreground" /> : null}
              </View>
            ) : on ? (
              <Icon as={Check} size={15} className="text-primary" />
            ) : null}
            <View className="flex-1">
              <Text className={cn('text-sm', on && 'font-medium text-primary')}>{o.label}</Text>
              {o.description ? <Text className="text-xs text-muted-foreground">{o.description}</Text> : null}
            </View>
          </Pressable>
        );
      })}

      {item.answer?.custom ? (
        <View className="flex-row items-center gap-2 rounded-xl border border-primary bg-primary/10 px-3 py-2.5">
          <Icon as={PenLine} size={14} className="text-primary" />
          <Text className="flex-1 text-sm text-primary">{item.answer.custom}</Text>
        </View>
      ) : null}

      {waiting && item.allowCustom ? (
        customOpen ? (
          <View className="flex-row items-center gap-2 rounded-xl border border-border bg-background pl-3 pr-1.5">
            <TextInput
              value={custom}
              onChangeText={setCustom}
              placeholder="输入你的想法…"
              placeholderTextColor="#94a3b8"
              autoFocus
              multiline
              textAlignVertical="center"
              className="max-h-24 min-h-10 flex-1 py-2 text-sm text-foreground"
            />
            {!item.multiple ? (
              <Pressable
                onPress={submit}
                disabled={!custom.trim()}
                className={cn('h-8 w-8 items-center justify-center rounded-full bg-primary', !custom.trim() && 'opacity-40')}
                accessibilityLabel="提交"
              >
                <Icon as={Send} size={14} className="text-primary-foreground" />
              </Pressable>
            ) : null}
          </View>
        ) : (
          <Pressable onPress={() => setCustomOpen(true)} className="flex-row items-center gap-2 px-1 py-1">
            <Icon as={PenLine} size={13} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">其他，我来说…</Text>
          </Pressable>
        )
      ) : null}

      {waiting && item.multiple ? (
        <Pressable
          onPress={submit}
          disabled={!picked.length && !custom.trim()}
          className={cn('h-9 items-center justify-center rounded-full bg-primary', !picked.length && !custom.trim() && 'opacity-40')}
        >
          <Text className="text-sm font-medium text-primary-foreground">确定</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
