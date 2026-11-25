// Agent 对话中的各类条目：用户消息、助手回答、执行步骤（含截图）、提示。

import { Image } from 'expo-image';
import { AlertCircle, Brain, Check, ChevronRight, FileText, X } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, useAnimatedStyle, withTiming } from 'react-native-reanimated';

import { formatSize } from '@/agent/attachments';
import { Markdown } from '@/components/markdown';
import { Card } from '@/components/ui/card';
import { ChoiceCard } from '@/components/agent/choice-card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { Step, UiAttachment, UiItem } from '@/agent/conversations';
import { cn } from '@/lib/utils';

/** 附件下方的小字：上传进度或出错原因。存好后的提示显示在对话面板中间（conversationStore.toast），这里只显示大小 */
function AttachmentStatus({ a }: { a: UiAttachment }) {
  switch (a.status) {
    case 'uploading':
      return <Text className="text-[10px] text-muted-foreground">{`上传中 ${Math.round((a.progress ?? 0) * 100)}%`}</Text>;
    case 'error':
      return (
        <View className="flex-row items-center gap-0.5">
          <Icon as={AlertCircle} size={10} className="text-destructive" />
          <Text numberOfLines={1} className="flex-shrink text-[10px] text-destructive">
            {a.error ?? '失败'}
          </Text>
        </View>
      );
    default:
      return <Text className="text-[10px] text-muted-foreground">{formatSize(a.size)}</Text>;
  }
}

function UserAttachments({ items }: { items: UiAttachment[] }) {
  const [zoom, setZoom] = useState<string | null>(null);
  return (
    <View className="max-w-[88%] flex-row flex-wrap justify-end gap-1.5 self-end">
      {items.map((a) =>
        a.kind === 'image' && a.uri ? (
          <Pressable key={a.id} onPress={() => setZoom(a.uri!)} className="items-end gap-0.5">
            <Image source={{ uri: a.uri }} style={{ width: 96, height: 96, borderRadius: 10 }} contentFit="cover" />
            {a.status === 'uploading' || a.status === 'error' ? <AttachmentStatus a={a} /> : null}
          </Pressable>
        ) : (
          <View key={a.id} className="w-48 flex-row items-center gap-2 rounded-xl border border-border bg-muted px-2.5 py-2">
            <Icon as={FileText} size={18} className="text-muted-foreground" />
            <View className="flex-1 gap-0.5">
              <Text numberOfLines={1} className="text-xs font-medium">
                {a.name}
              </Text>
              <AttachmentStatus a={a} />
            </View>
          </View>
        ),
      )}
      <Modal visible={!!zoom} transparent animationType="fade" onRequestClose={() => setZoom(null)}>
        <Pressable onPress={() => setZoom(null)} className="flex-1 items-center justify-center bg-black/90">
          {zoom ? <Image source={{ uri: zoom }} style={{ width: '100%', height: '80%' }} contentFit="contain" /> : null}
        </Pressable>
      </Modal>
    </View>
  );
}

export function UserBubble({ text, attachments }: { text: string; attachments?: UiAttachment[] }) {
  return (
    <View className="gap-1.5 self-stretch">
      {attachments?.length ? <UserAttachments items={attachments} /> : null}
      {text ? (
        <View className="max-w-[88%] self-end rounded-2xl rounded-br-md bg-primary px-3 py-2">
          <Text selectable className="text-sm text-primary-foreground">
            {text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function AssistantText({ text, reasoning, streaming }: { text: string; reasoning?: string; streaming?: boolean }) {
  const [showReasoning, setShowReasoning] = useState(false);
  return (
    <View className="max-w-[96%] gap-1.5 self-start">
      {reasoning ? (
        <Pressable onPress={() => setShowReasoning((v) => !v)} className="flex-row items-center gap-1">
          <Icon as={Brain} size={12} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">{showReasoning ? '收起思考过程' : '思考过程'}</Text>
          <Chevron open={showReasoning} size={12} />
        </Pressable>
      ) : null}
      {reasoning && showReasoning ? (
        <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
          <Text selectable className="border-l-2 border-border pl-2 text-xs text-muted-foreground">
            {reasoning}
          </Text>
        </Animated.View>
      ) : null}
      {text ? <Markdown text={text} cursor={streaming} /> : streaming && !reasoning ? <ActivityIndicator size="small" /> : null}
    </View>
  );
}

/** 展开时向下、收起时向右的箭头，带旋转过渡 */
function Chevron({ open, size }: { open: boolean; size: number }) {
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: withTiming(open ? '90deg' : '0deg', { duration: 180 }) }] }));
  return (
    <Animated.View style={style}>
      <Icon as={ChevronRight} size={size} className="text-muted-foreground" />
    </Animated.View>
  );
}

function StepIcon({ status }: { status: Step['status'] }) {
  if (status === 'running') return <ActivityIndicator size="small" style={{ width: 14, height: 14 }} />;
  if (status === 'error') return <Icon as={X} size={14} className="text-destructive" />;
  return <Icon as={Check} size={14} className="text-success-foreground" />;
}

export function StepsCard({ steps, image }: { steps: Step[]; image?: { data: string; mimeType: string } }) {
  const running = steps.some((s) => s.status === 'running');
  const [open, setOpen] = useState(true);
  const [zoom, setZoom] = useState(false);
  const failed = steps.filter((s) => s.status === 'error').length;
  const uri = image ? `data:${image.mimeType};base64,${image.data}` : null;

  return (
    <View className="gap-2 self-stretch">
      {/* 展开 / 收起时卡片高度过渡，步骤列表淡入淡出 */}
      <Animated.View layout={LinearTransition.duration(200)} style={{ overflow: 'hidden', borderRadius: 12 }}>
        <Card className="px-3 py-2">
          <Pressable onPress={() => setOpen((v) => !v)} className="flex-row items-center justify-between py-1">
            <Text className="flex-1 text-xs font-semibold">
              {running ? '正在执行…' : `执行了 ${steps.length} 个步骤`}
              {failed ? <Text className="text-xs text-destructive">{`（${failed} 个失败）`}</Text> : null}
            </Text>
            <Chevron open={open} size={14} />
          </Pressable>
          {open ? (
            <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(100)}>
              {steps.map((s) => (
                <Animated.View
                  key={s.id}
                  entering={FadeIn.duration(200)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}
                >
                  <StepIcon status={s.status} />
                  <View className="rounded bg-muted px-1.5 py-0.5">
                    <Text className="font-mono text-[11px]">{s.name}</Text>
                  </View>
                  <Text
                    numberOfLines={1}
                    className={cn('flex-1 text-xs text-muted-foreground', s.status === 'error' && 'text-destructive')}
                  >
                    {s.status === 'error' && s.result ? s.result : s.summary}
                  </Text>
                </Animated.View>
              ))}
            </Animated.View>
          ) : null}
        </Card>
      </Animated.View>
      {uri ? (
        <Pressable onPress={() => setZoom(true)} className="w-40 overflow-hidden rounded-lg border border-border">
          <Image source={{ uri }} style={{ width: '100%', aspectRatio: 16 / 10 }} contentFit="cover" />
        </Pressable>
      ) : null}
      {uri ? (
        <Modal visible={zoom} transparent animationType="fade" onRequestClose={() => setZoom(false)}>
          <Pressable onPress={() => setZoom(false)} className="flex-1 items-center justify-center bg-black/90">
            <Image source={{ uri }} style={{ width: '100%', height: '80%' }} contentFit="contain" />
          </Pressable>
        </Modal>
      ) : null}
    </View>
  );
}

export function Notice({ text, tone }: { text: string; tone: 'info' | 'error' }) {
  return (
    <View className={cn('self-center rounded-md px-3 py-1.5', tone === 'error' ? 'bg-destructive/10' : 'bg-muted')}>
      <Text className={cn('text-xs', tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{text}</Text>
    </View>
  );
}

export function ChatItem({ item, streaming }: { item: UiItem; streaming: boolean }) {
  switch (item.kind) {
    case 'user':
      return <UserBubble text={item.text} attachments={item.attachments} />;
    case 'assistant':
      return <AssistantText text={item.text} reasoning={item.reasoning} streaming={streaming} />;
    case 'steps':
      return <StepsCard steps={item.steps} image={item.image} />;
    case 'notice':
      return <Notice text={item.text} tone={item.tone} />;
    case 'choice':
      return <ChoiceCard item={item} />;
  }
}
