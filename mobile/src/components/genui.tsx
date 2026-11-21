// 渲染 ```p2d-ui 代码块（组件定义见 src/agent/genui.ts）。
// 「后续操作」按钮点击后把预设的话作为用户消息发给 Agent；Agent 正在执行时按钮不可点。

import { AlertTriangle, Check, CircleAlert, CircleCheck, Info, Loader, X } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { send, useConversation } from '@/agent/conversations';
import { parseGenui, type GenuiNode, type Tone } from '@/agent/genui';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

const TONE_BOX: Record<Tone, string> = {
  info: 'border-primary/30 bg-primary/5',
  success: 'border-success/40 bg-success/10',
  warning: 'border-warning/40 bg-warning/10',
  error: 'border-destructive/40 bg-destructive/10',
};
const TONE_TEXT: Record<Tone, string> = {
  info: 'text-primary',
  success: 'text-success-foreground',
  warning: 'text-warning-foreground',
  error: 'text-destructive',
};
const TONE_ICON = { info: Info, success: CircleCheck, warning: AlertTriangle, error: CircleAlert };

/** 后续操作建议：一行气泡，按文字自适应宽度、完整显示；放不下时可以左右滑动查看 */
function Buttons({ items }: { items: { label: string; send: string }[] }) {
  const { running } = useConversation();
  const [tapped, setTapped] = useState<string | null>(null);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2"
      className="-mx-1"
      // ScrollView 默认 flexGrow: 1，放在对话列表里会撑出大片空白，把后面的消息挤到可见区域之外
      style={{ flexGrow: 0 }}
      contentContainerStyle={{ paddingHorizontal: 4 }}
    >
      {items.slice(0, 3).map((b) => {
        const done = tapped === b.label;
        const disabled = running || tapped !== null;
        return (
          <Pressable
            key={b.label}
            disabled={disabled}
            onPress={() => {
              setTapped(b.label);
              void send(b.send);
            }}
            accessibilityLabel={b.label}
            className={cn(
              'h-9 flex-row items-center gap-1 rounded-full border px-4 active:bg-muted',
              done ? 'border-primary/40 bg-primary/10' : 'border-border bg-background',
              disabled && !done && 'opacity-40',
            )}
          >
            {done ? <Icon as={Check} size={12} className="text-primary" /> : null}
            <Text numberOfLines={1} className={cn('text-[13px]', done ? 'text-primary' : 'text-foreground')}>
              {b.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function Node({ n }: { n: GenuiNode }) {
  switch (n.type) {
    case 'callout':
      return (
        <View className={cn('flex-row gap-2 rounded-xl border p-3', TONE_BOX[n.tone])}>
          <Icon as={TONE_ICON[n.tone]} size={16} className={cn('mt-0.5', TONE_TEXT[n.tone])} />
          <View className="flex-1 gap-0.5">
            {n.title ? <Text className={cn('text-sm font-semibold', TONE_TEXT[n.tone])}>{n.title}</Text> : null}
            <Text className="text-[13px] leading-5">{n.text}</Text>
          </View>
        </View>
      );
    case 'stats':
      return (
        <View className="flex-row gap-2">
          {n.items.map((s) => (
            <View key={s.label} className="flex-1 gap-0.5 rounded-xl border border-border bg-background p-2.5">
              <Text numberOfLines={1} className="text-[11px] text-muted-foreground">
                {s.label}
              </Text>
              <Text numberOfLines={1} className={cn('text-base font-semibold', s.tone && TONE_TEXT[s.tone])}>
                {s.value}
              </Text>
              {s.hint ? (
                <Text numberOfLines={1} className="text-[10px] text-muted-foreground">
                  {s.hint}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      );
    case 'progress':
      return (
        <View className="gap-1.5">
          <View className="flex-row items-center">
            <Text className="flex-1 text-[13px]">{n.label}</Text>
            <Text className="text-[13px] font-medium">{`${Math.round(n.value)}%`}</Text>
          </View>
          <View className="h-2 overflow-hidden rounded-full bg-muted">
            <View style={{ width: `${n.value}%` }} className={cn('h-2 rounded-full', n.value >= 90 ? 'bg-destructive' : 'bg-primary')} />
          </View>
          {n.hint ? <Text className="text-[11px] text-muted-foreground">{n.hint}</Text> : null}
        </View>
      );
    case 'steps':
      return (
        <View className="gap-2.5">
          {n.items.map((s, i) => (
            <View key={`${i}-${s.title}`} className="flex-row gap-2.5">
              <View
                className={cn(
                  'mt-0.5 h-5 w-5 items-center justify-center rounded-full',
                  s.status === 'done'
                    ? 'bg-success'
                    : s.status === 'current'
                      ? 'bg-primary'
                      : s.status === 'error'
                        ? 'bg-destructive'
                        : 'bg-muted',
                )}
              >
                {s.status === 'done' ? (
                  <Icon as={Check} size={12} className="text-white" />
                ) : s.status === 'current' ? (
                  <Icon as={Loader} size={11} className="text-white" />
                ) : s.status === 'error' ? (
                  <Icon as={X} size={12} className="text-white" />
                ) : (
                  <Text className="text-[10px] text-muted-foreground">{i + 1}</Text>
                )}
              </View>
              <View className="flex-1">
                <Text
                  className={cn('text-[13px]', s.status === 'todo' && 'text-muted-foreground', s.status === 'current' && 'font-medium')}
                >
                  {s.title}
                </Text>
                {s.detail ? <Text className="text-xs text-muted-foreground">{s.detail}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      );
    case 'kv':
      return (
        <View className="overflow-hidden rounded-xl border border-border">
          {n.title ? <Text className="bg-muted px-3 py-1.5 text-xs font-medium">{n.title}</Text> : null}
          {n.items.map((r, i) => (
            <View key={`${i}-${r.label}`} className={cn('flex-row gap-3 px-3 py-2', i > 0 && 'border-t border-border')}>
              <Text className="w-20 text-[13px] text-muted-foreground">{r.label}</Text>
              <Text selectable className="flex-1 text-[13px]">
                {r.value}
              </Text>
            </View>
          ))}
        </View>
      );
    case 'buttons':
      return <Buttons items={n.items} />;
  }
}

/** p2d-ui 代码块：流式输出还没写完时显示占位；解析失败时由调用方退回普通代码块 */
export function GenuiBlock({ code, closed, fallback }: { code: string; closed: boolean; fallback: React.ReactNode }) {
  const spec = useMemo(() => parseGenui(code), [code]);
  if (!spec) {
    if (!closed) {
      return (
        <View className="flex-row items-center gap-2 rounded-xl border border-dashed border-border px-3 py-3">
          <Icon as={Loader} size={14} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">正在生成界面…</Text>
        </View>
      );
    }
    return <>{fallback}</>;
  }
  return (
    <View className="gap-2.5 self-stretch">
      {spec.title ? <Text className="text-sm font-semibold">{spec.title}</Text> : null}
      {spec.nodes.map((n, i) => (
        <Node key={i} n={n} />
      ))}
    </View>
  );
}
