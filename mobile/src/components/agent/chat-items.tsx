// Agent 对话中的各类条目：用户消息、助手回答、执行步骤（含截图）、提示。

import { Image } from 'expo-image';
import { Brain, Check, ChevronDown, ChevronRight, X } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { Step, UiItem } from '@/agent/conversations';
import { cn } from '@/lib/utils';

export function UserBubble({ text }: { text: string }) {
  return (
    <View className="max-w-[88%] self-end rounded-2xl rounded-br-md bg-primary px-3 py-2">
      <Text selectable className="text-sm text-primary-foreground">
        {text}
      </Text>
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
        </Pressable>
      ) : null}
      {reasoning && showReasoning ? (
        <Text selectable className="border-l-2 border-border pl-2 text-xs text-muted-foreground">
          {reasoning}
        </Text>
      ) : null}
      {text ? (
        <Text selectable className="text-sm leading-6">
          {text}
          {streaming ? '▍' : ''}
        </Text>
      ) : streaming && !reasoning ? (
        <ActivityIndicator size="small" />
      ) : null}
    </View>
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
      <Card className="px-3 py-2">
        <Pressable onPress={() => setOpen((v) => !v)} className="flex-row items-center justify-between py-1">
          <Text className="text-xs font-semibold">
            {running ? '正在执行…' : `执行了 ${steps.length} 个步骤`}
            {failed ? <Text className="text-xs text-destructive">{`（${failed} 个失败）`}</Text> : null}
          </Text>
          <Icon as={open ? ChevronDown : ChevronRight} size={14} className="text-muted-foreground" />
        </Pressable>
        {open
          ? steps.map((s) => (
              <View key={s.id} className="flex-row items-center gap-2 py-1">
                <StepIcon status={s.status} />
                <View className="rounded bg-muted px-1.5 py-0.5">
                  <Text className="font-mono text-[11px]">{s.name}</Text>
                </View>
                <Text numberOfLines={1} className={cn('flex-1 text-xs text-muted-foreground', s.status === 'error' && 'text-destructive')}>
                  {s.status === 'error' && s.result ? s.result : s.summary}
                </Text>
              </View>
            ))
          : null}
      </Card>
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
      return <UserBubble text={item.text} />;
    case 'assistant':
      return <AssistantText text={item.text} reasoning={item.reasoning} streaming={streaming} />;
    case 'steps':
      return <StepsCard steps={item.steps} image={item.image} />;
    case 'notice':
      return <Notice text={item.text} tone={item.tone} />;
  }
}
