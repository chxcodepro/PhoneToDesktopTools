// Agent 页（首页）：用自然语言让电脑做事。
// 左上角三条杠（或在对话区向右滑）打开侧边抽屉；右上角按钮开关实时画面小窗，小窗的放大按钮进入虚拟桌面。

import { router, useIsFocused } from 'expo-router';
import { ArrowDown, Bug, Menu, MonitorCheck, MonitorPlay, Settings2, type LucideIcon } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeInDown, FadeOut, LayoutAnimationConfig } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ChatItem, Notice } from '@/components/agent/chat-items';
import { Composer } from '@/components/agent/composer';
import { ContextRing } from '@/components/agent/context-ring';
import { ConversationDrawer, useDrawer } from '@/components/agent/drawer';
import { LiveWindow } from '@/components/agent/live-window';
import { statusLabel, StatusDot } from '@/components/connection-status';
import { ToolDebugPanel } from '@/components/tool-debug-panel';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { compressContext, initConversations, send, stop, useConversation } from '@/agent/conversations';
import { contextWindowOf, initModelConfig, reasoningOf, setReasoning, useModelConfig } from '@/agent/modelConfig';
import { reasoningOptions } from '@/agent/reasoning';
import { cn } from '@/lib/utils';
import { configProblem } from '@/agent/llm';
import { useConnection } from '@/state/connection';
import { useViewTargets } from '@/state/multi';
import { uiStore, useUi } from '@/state/ui';

function RoundButton({ icon, onPress, active, label }: { icon: LucideIcon; onPress: () => void; active?: boolean; label: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      className="h-10 w-10 items-center justify-center rounded-full border border-border bg-background shadow-sm active:bg-muted"
    >
      <Icon as={icon} size={19} className={active ? 'text-primary' : 'text-foreground'} />
    </Pressable>
  );
}

export default function AgentScreen() {
  const conv = useConversation();
  const { status, params, route, detail } = useConnection();
  const { targets } = useViewTargets();
  // 同时连接着的其他电脑数
  const extraCount = targets.filter((t) => t.pcId && t.status === 'connected').length;
  const ui = useUi();
  const focused = useIsFocused();
  // 实时画面小窗：只在用户点右上角按钮时打开 / 关闭；进入虚拟桌面等页面时暂停
  const anyPc = status === 'connected' || extraCount > 0;
  const showLive = anyPc && ui.liveOpen && focused;
  const modelCfg = useModelConfig();
  const drawer = useDrawer();
  const [pickError, setPickError] = useState<string | null>(null);
  // 对话区尺寸：实时画面小窗在其中拖动
  const [chatArea, setChatArea] = useState({ w: 0, h: 0 });
  const [debug, setDebug] = useState(false);
  const scrollRef = useRef<ScrollViewInstance>(null);
  // 跟随最新内容：手指一碰到列表就停止跟随（生成时往上翻不会被拉回底部），
  // 松手（含惯性滑动结束）后若回到了底部才恢复跟随；不跟随时显示「回到底部」按钮
  const follow = useRef(true);
  const dragging = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const settle = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    const near = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
    follow.current = near;
    setShowJump(!near);
  };
  const jumpToEnd = (animated: boolean) => {
    follow.current = true;
    setShowJump(false);
    scrollRef.current?.scrollToEnd({ animated });
  };
  // 切换 / 打开对话时回到底部
  useEffect(() => {
    follow.current = true;
    const t = setTimeout(() => {
      setShowJump(false);
      scrollRef.current?.scrollToEnd({ animated: false });
    }, 50);
    return () => clearTimeout(t);
  }, [conv.currentId]);

  useEffect(() => {
    void initConversations();
    void initModelConfig();
  }, []);

  // 打开 App 时先显示「选择电脑」页（每次启动一次）
  useEffect(() => {
    if (!ui.startupPicker) return;
    uiStore.set({ startupPicker: false });
    router.push('/pick');
  }, [ui.startupPicker]);

  const active = modelCfg.presets[modelCfg.active];
  const modelReady =
    modelCfg.ready &&
    modelCfg.hasKey[modelCfg.active] &&
    !configProblem({
      baseUrl: active.baseUrl,
      apiKey: 'x',
      model: active.model,
    });

  const lastIndex = conv.items.length - 1;

  return (
    <SafeAreaView edges={['top', 'bottom']} className="flex-1 bg-background">
      {/* 标题栏：抽屉按钮 / 对话标题 + 设备连接状态 / 实时画面开关 */}
      <View className="flex-row items-center gap-2 px-3 pb-2 pt-1.5">
        <RoundButton icon={Menu} onPress={drawer.ctl.open} label="侧边栏" />
        <View className="flex-1 items-center px-1">
          <Text numberOfLines={1} className="text-base font-semibold">
            {conv.title}
          </Text>
          {/* 当前设备和连接状态；未连接时点击去连接 */}
          <Pressable
            onPress={() => router.push('/devices')}
            hitSlop={6}
            className="mt-0.5 flex-row items-center gap-1.5"
          >
            <StatusDot status={status} />
            <Text numberOfLines={1} className="flex-shrink text-xs text-muted-foreground">
              {params ? params.host : '未连接电脑'}
            </Text>
            <Text
              className={cn(
                'text-xs',
                status === 'connected'
                  ? 'text-success-foreground'
                  : status === 'unauthorized'
                    ? 'text-destructive'
                    : 'text-muted-foreground',
              )}
            >
              {params || status !== 'idle' ? statusLabel(status, detail, route) + (status === 'connected' && route === 'wifi' ? ' · WiFi' : '') : ''}
            </Text>
            {extraCount ? <Text className="text-xs text-success-foreground">{`+${extraCount} 台`}</Text> : null}
          </Pressable>
        </View>
        {__DEV__ ? (
          <Pressable onPress={() => setDebug((v) => !v)} hitSlop={8} className="absolute right-16 top-4">
            <Icon as={Bug} size={16} className={debug ? 'text-primary' : 'text-muted-foreground'} />
          </Pressable>
        ) : null}
        {anyPc ? (
          <RoundButton icon={MonitorPlay} onPress={() => uiStore.set({ liveOpen: !ui.liveOpen })} active={ui.liveOpen} label="实时画面" />
        ) : (
          <View className="h-10 w-10" />
        )}
      </View>

      {/* Android 15 强制全面屏，系统不会自动缩小页面，由 keyboard-controller 让输入框跟随键盘 */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <View
          className="flex-1"
          {...drawer.ctl.openPan.panHandlers}
          onLayout={(e) => setChatArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        >
          <ScrollView
            ref={scrollRef}
            className="flex-1"
            contentContainerClassName="gap-3 px-4 py-4"
            keyboardShouldPersistTaps="handled"
            onScrollBeginDrag={() => {
              dragging.current = true;
              follow.current = false;
            }}
            onScrollEndDrag={(e) => {
              dragging.current = false;
              settle(e);
            }}
            onMomentumScrollEnd={settle}
            onContentSizeChange={() => {
              // 流式输出时内容一直在变：只在跟随且手指没按着时滚到底，用无动画滚动避免和手势打架
              if (follow.current && !dragging.current) scrollRef.current?.scrollToEnd({ animated: false });
            }}
          >
            {debug ? <ToolDebugPanel /> : null}
            {modelCfg.ready && !modelReady ? (
              <Card>
                <CardContent className="items-center gap-3 py-6">
                  <Text className="font-semibold">先配置大模型</Text>
                  <Button onPress={() => router.push('/settings')}>
                    <Icon as={Settings2} size={16} className="text-primary-foreground" />
                    <Text>去设置</Text>
                  </Button>
                </CardContent>
              </Card>
            ) : null}
            {/* 新条目淡入上移；打开 / 切换对话时已有的条目不播放动画 */}
            <LayoutAnimationConfig key={conv.currentId ?? 'new'} skipEntering>
              {conv.items.map((it, i) => (
                <Animated.View key={it.id} entering={FadeInDown.duration(220)}>
                  <ChatItem item={it} streaming={conv.running && i === lastIndex && it.kind === 'assistant'} />
                </Animated.View>
              ))}
            </LayoutAnimationConfig>
            {conv.running && conv.items[lastIndex]?.kind === 'user' ? (
              <Text className="text-xs text-muted-foreground">{conv.modelLabel} 思考中…</Text>
            ) : null}
          </ScrollView>
          {showJump ? (
            <Animated.View
              entering={FadeIn.duration(150)}
              exiting={FadeOut.duration(150)}
              style={{ position: 'absolute', bottom: 12, alignSelf: 'center' }}
            >
              <Pressable
                onPress={() => jumpToEnd(true)}
                accessibilityLabel="回到底部"
                className="h-9 w-9 items-center justify-center rounded-full border border-border bg-background shadow-md active:bg-muted"
              >
                <Icon as={ArrowDown} size={18} className="text-foreground" />
              </Pressable>
            </Animated.View>
          ) : null}
          {showLive ? (
            <Animated.View
              entering={FadeIn.duration(200)}
              exiting={FadeOut.duration(150)}
              pointerEvents="box-none"
              style={StyleSheet.absoluteFill}
            >
              <LiveWindow live={conv.live} running={conv.running} area={chatArea} />
            </Animated.View>
          ) : null}
          {/* 附件存到电脑等提示：显示在对话面板正中间，几秒后消失 */}
          {conv.toast ? (
            <View pointerEvents="none" style={StyleSheet.absoluteFill} className="items-center justify-center">
              <Animated.View
                key={conv.toast.id}
                entering={FadeIn.duration(150)}
                exiting={FadeOut.duration(200)}
                className="max-w-[80%] flex-row items-center gap-2 rounded-xl bg-zinc-800/90 px-4 py-3"
              >
                <Icon as={MonitorCheck} size={18} className="text-emerald-400" />
                <Text className="flex-shrink text-sm text-zinc-100">{conv.toast.text}</Text>
              </Animated.View>
            </View>
          ) : null}
        </View>

        {pickError ? (
          <Pressable onPress={() => setPickError(null)} className="px-4 pb-1">
            <Notice text={pickError} tone="error" />
          </Pressable>
        ) : null}
        <Composer
          running={conv.running}
          onSend={(t, atts) => {
            setPickError(null);
            jumpToEnd(false);
            void send(t, atts);
          }}
          onStop={stop}
          onError={setPickError}
          reasoning={reasoningOf(modelCfg.active, active)}
          reasoningOptions={reasoningOptions(modelCfg.active, active.model)}
          onReasoning={(l) => void setReasoning(l)}
          draft={ui.draft}
          accessory={
            <ContextRing
              model={active.model}
              contextWindow={contextWindowOf(active)}
              stats={conv.stats}
              totalTokens={conv.totalTokens}
              running={conv.running}
              onCompress={() => void compressContext()}
            />
          }
        />
      </KeyboardAvoidingView>

      <ConversationDrawer open={drawer.open} ctl={drawer.ctl} />
    </SafeAreaView>
  );
}
