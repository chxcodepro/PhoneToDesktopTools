// Agent 页：用自然语言让电脑做事。

import { router } from 'expo-router';
import { ArrowUp, Bug, History, Settings2, Square, SquarePen } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View, type ScrollViewInstance } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ChatItem } from '@/components/agent/chat-items';
import { HistorySheet } from '@/components/agent/history-sheet';
import { ConnectionSubtitle } from '@/components/connection-status';
import { ToolDebugPanel } from '@/components/tool-debug-panel';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { initConversations, newConversation, send, stop, useConversation } from '@/agent/conversations';
import { initModelConfig, useModelConfig } from '@/agent/modelConfig';
import { configProblem } from '@/agent/llm';
import { cn } from '@/lib/utils';

export default function AgentScreen() {
  const conv = useConversation();
  const modelCfg = useModelConfig();
  const [text, setText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [debug, setDebug] = useState(false);
  const scrollRef = useRef<ScrollViewInstance>(null);

  useEffect(() => {
    void initConversations();
    void initModelConfig();
  }, []);

  const active = modelCfg.presets[modelCfg.active];
  const modelReady =
    modelCfg.ready &&
    modelCfg.hasKey[modelCfg.active] &&
    !configProblem({ baseUrl: active.baseUrl, apiKey: 'x', model: active.model });

  const onSend = () => {
    const t = text.trim();
    if (!t || conv.running) return;
    setText('');
    void send(t);
  };

  const lastIndex = conv.items.length - 1;

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      {/* 标题栏 */}
      <View className="flex-row items-center gap-2 border-b border-border px-4 pb-2.5 pt-2">
        <Pressable onPress={() => setHistoryOpen(true)} hitSlop={8}>
          <Icon as={History} size={20} />
        </Pressable>
        <View className="flex-1 px-1">
          <Text numberOfLines={1} className="text-base font-semibold">
            {conv.title}
          </Text>
          <ConnectionSubtitle />
        </View>
        {__DEV__ ? (
          <Pressable onPress={() => setDebug((v) => !v)} hitSlop={8}>
            <Icon as={Bug} size={18} className={debug ? 'text-primary' : 'text-muted-foreground'} />
          </Pressable>
        ) : null}
        <Pressable onPress={newConversation} hitSlop={8} disabled={conv.items.length === 0}>
          <Icon as={SquarePen} size={20} className={conv.items.length === 0 ? 'text-muted-foreground' : 'text-foreground'} />
        </Pressable>
      </View>

      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={scrollRef}
          className="flex-1"
          contentContainerClassName="gap-3 px-4 py-4"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {debug ? <ToolDebugPanel /> : null}
          {modelCfg.ready && !modelReady ? (
            <Card>
              <CardContent className="items-center gap-3 py-6">
                <Text className="font-semibold">先配置大模型</Text>
                <Button onPress={() => router.navigate('/settings')}>
                  <Icon as={Settings2} size={16} className="text-primary-foreground" />
                  <Text>去设置</Text>
                </Button>
              </CardContent>
            </Card>
          ) : null}
          {conv.items.map((it, i) => (
            <ChatItem key={it.id} item={it} streaming={conv.running && i === lastIndex && it.kind === 'assistant'} />
          ))}
          {conv.running && conv.items[lastIndex]?.kind === 'user' ? (
            <Text className="text-xs text-muted-foreground">{conv.modelLabel} 思考中…</Text>
          ) : null}
        </ScrollView>

        {/* 输入框 */}
        <View className="px-3 pb-2 pt-1">
          <View className="flex-row items-end gap-2 rounded-3xl border border-border bg-background py-1.5 pl-4 pr-1.5">
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="让电脑做点什么…"
              placeholderTextColor="#94a3b8"
              multiline
              className="max-h-32 flex-1 py-1.5 text-sm text-foreground"
            />
            {conv.running ? (
              <Pressable onPress={stop} className="h-8 w-8 items-center justify-center rounded-full bg-foreground">
                <Icon as={Square} size={12} className="text-background" fill="currentColor" />
              </Pressable>
            ) : (
              <Pressable
                onPress={onSend}
                disabled={!text.trim()}
                className={cn('h-8 w-8 items-center justify-center rounded-full bg-primary', !text.trim() && 'opacity-40')}
              >
                <Icon as={ArrowUp} size={16} className="text-primary-foreground" />
              </Pressable>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>

      <HistorySheet visible={historyOpen} onClose={() => setHistoryOpen(false)} />
    </SafeAreaView>
  );
}
