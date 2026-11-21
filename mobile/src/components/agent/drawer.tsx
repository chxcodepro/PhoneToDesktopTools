// Agent 页左侧抽屉：点击左上角三条杠按钮或在对话区向右滑出。
// 上面是入口卡片（模型、虚拟桌面、扩展），中间是按日期分组的历史对话，底部是搜索框和设置按钮。

import { router, type Href } from 'expo-router';
import {
  AlarmClock,
  ChevronRight,
  Cpu,
  Monitor,
  MoreHorizontal,
  Puzzle,
  Search,
  Settings,
  SquarePen,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
  Alert,
  Animated,
  BackHandler,
  Dimensions,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type PanResponderInstance,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { deleteConversation, newConversation, openConversation, useConversation, type ConversationMeta } from '@/agent/conversations';
import { useModelConfig } from '@/agent/modelConfig';
import { useSchedules } from '@/agent/scheduler';
import { StatusDot } from '@/components/connection-status';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useConnection } from '@/state/connection';

const DURATION = 220;

/** 抽屉的位置和手势；放在组件外的普通对象里，避免在渲染期间读写 ref */
export class DrawerController {
  readonly width = Math.min(Dimensions.get('window').width * 0.84, 380);
  readonly x = new Animated.Value(-this.width);
  /** 对话区上向右滑：拉出抽屉 */
  readonly openPan: PanResponderInstance;
  /** 抽屉上向左滑：收起 */
  readonly panelPan: PanResponderInstance;
  private isOpen = false;

  constructor(private onChange: (open: boolean) => void) {
    const horizontal = (dx: number, dy: number) => Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 2;
    this.openPan = PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => !this.isOpen && g.dx > 0 && horizontal(g.dx, g.dy),
      onPanResponderMove: (_, g) => this.x.setValue(Math.min(0, -this.width + Math.max(0, g.dx))),
      onPanResponderRelease: (_, g) => (g.dx > this.width / 3 || g.vx > 0.5 ? this.open() : this.close()),
      onPanResponderTerminate: () => this.close(),
    });
    this.panelPan = PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dx < 0 && horizontal(g.dx, g.dy),
      onPanResponderMove: (_, g) => this.x.setValue(Math.min(0, g.dx)),
      onPanResponderRelease: (_, g) => (g.dx < -this.width / 3 || g.vx < -0.5 ? this.close() : this.open()),
      onPanResponderTerminate: () => this.open(),
    });
  }

  private animate(to: number): void {
    Animated.timing(this.x, { toValue: to, duration: DURATION, useNativeDriver: true }).start();
  }

  open = (): void => {
    this.isOpen = true;
    this.animate(0);
    this.onChange(true);
  };

  close = (): void => {
    this.isOpen = false;
    this.animate(-this.width);
    this.onChange(false);
  };
}

export function useDrawer() {
  const [open, setOpen] = useState(false);
  const [ctl] = useState(() => new DrawerController(setOpen));
  return { open, ctl };
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return '今天';
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

function groupByDay(list: ConversationMeta[]): { label: string; items: ConversationMeta[] }[] {
  const out: { label: string; items: ConversationMeta[] }[] = [];
  for (const c of list) {
    const label = dayLabel(c.updatedAt);
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(c);
    else out.push({ label, items: [c] });
  }
  return out;
}

function EntryRow({
  icon,
  label,
  value,
  onPress,
  last,
}: {
  icon: LucideIcon;
  label: string;
  value?: React.ReactNode;
  onPress: () => void;
  last?: boolean;
}) {
  return (
    <Pressable onPress={onPress} className="flex-row items-center gap-3 pl-4 active:bg-muted">
      <Icon as={icon} size={20} className="text-foreground" />
      <View className={cn('flex-1 flex-row items-center gap-2 py-3.5 pr-3', !last && 'border-b border-border')}>
        <Text className="text-[15px]">{label}</Text>
        <View className="flex-1 flex-row items-center justify-end gap-1.5">{value}</View>
        <Icon as={ChevronRight} size={16} className="text-muted-foreground" />
      </View>
    </Pressable>
  );
}

export function ConversationDrawer({ open, ctl }: { open: boolean; ctl: DrawerController }) {
  const insets = useSafeAreaInsets();
  const { list, currentId } = useConversation();
  const model = useModelConfig();
  const { status, params } = useConnection();
  const [query, setQuery] = useState('');

  // 返回键先关抽屉
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      ctl.close();
      return true;
    });
    return () => sub.remove();
  }, [open, ctl]);

  const go = (href: Href) => {
    ctl.close();
    router.push(href);
  };

  const q = query.trim().toLowerCase();
  const groups = groupByDay(q ? list.filter((c) => c.title.toLowerCase().includes(q)) : list);
  const activeModel = model.presets[model.active]?.model;
  const enabledCount = useSchedules().tasks.filter((t) => t.enabled).length;

  const confirmDelete = (c: ConversationMeta) =>
    Alert.alert('删除这个对话？', `「${c.title}」\n删除后无法恢复。`, [
      { text: '取消', style: 'cancel' },
      { text: '删除对话', style: 'destructive', onPress: () => void deleteConversation(c.id) },
    ]);

  const backdrop = ctl.x.interpolate({ inputRange: [-ctl.width, 0], outputRange: [0, 1], extrapolate: 'clamp' });

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Animated.View
        pointerEvents={open ? 'auto' : 'none'}
        style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.35)', opacity: backdrop }]}
      >
        <Pressable style={{ flex: 1 }} onPress={ctl.close} accessibilityLabel="关闭侧边栏" />
      </Animated.View>

      <Animated.View
        {...ctl.panelPan.panHandlers}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: ctl.width,
          transform: [{ translateX: ctl.x }],
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        }}
        className="bg-muted"
      >
        {/* 在底部搜索框输入时，内容整体移到键盘上方 */}
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
          {/* 顶部：应用名 + 新对话 */}
          <View className="flex-row items-center gap-3 px-5 pb-3 pt-3">
            <View className="h-10 w-10 items-center justify-center rounded-full bg-primary">
              <Icon as={Monitor} size={20} className="text-primary-foreground" />
            </View>
            <Text numberOfLines={1} className="flex-1 text-xl font-semibold">
              PhoneToDesktop
            </Text>
            <Pressable
              onPress={() => {
                newConversation();
                ctl.close();
              }}
              className="h-11 w-11 items-center justify-center rounded-full border border-border bg-background active:bg-muted"
              accessibilityLabel="新对话"
            >
              <Icon as={SquarePen} size={19} className="text-foreground" />
            </Pressable>
          </View>

          {/* 入口卡片 */}
          <View className="mx-3 overflow-hidden rounded-3xl bg-background">
            <EntryRow
              icon={Cpu}
              label="模型"
              value={
                <Text numberOfLines={1} className="flex-shrink text-sm text-muted-foreground">
                  {activeModel || '未配置'}
                </Text>
              }
              onPress={() => go('/settings')}
            />
            <EntryRow
              icon={Monitor}
              label="虚拟桌面"
              value={
                <>
                  <StatusDot status={status} />
                  <Text numberOfLines={1} className="flex-shrink text-sm text-muted-foreground">
                    {params && status === 'connected' ? params.host : '未连接'}
                  </Text>
                </>
              }
              onPress={() => go('/remote')}
            />
            <EntryRow
              icon={AlarmClock}
              label="定时任务"
              value={enabledCount ? <Text className="text-sm text-muted-foreground">{`${enabledCount} 个启用`}</Text> : undefined}
              onPress={() => go('/schedules')}
            />
            <EntryRow icon={Puzzle} label="扩展" onPress={() => go('/extensions')} last />
          </View>

          {/* 历史对话 */}
          <ScrollView className="flex-1" contentContainerClassName="px-3 pb-4 pt-2" keyboardShouldPersistTaps="handled">
            {groups.length === 0 ? (
              <Text className="py-10 text-center text-sm text-muted-foreground">{q ? '没有找到相关对话' : '暂无历史对话'}</Text>
            ) : null}
            {groups.map((g) => (
              <View key={g.label}>
                <Text className="px-3 pb-1.5 pt-4 text-[13px] text-muted-foreground">{g.label}</Text>
                {g.items.map((c) => {
                  const current = c.id === currentId;
                  return (
                    <Pressable
                      key={c.id}
                      onPress={() => {
                        void openConversation(c.id);
                        ctl.close();
                      }}
                      onLongPress={() => confirmDelete(c)}
                      className={cn('flex-row items-center rounded-2xl py-3 pl-3 pr-1 active:bg-background', current && 'bg-background')}
                    >
                      {current ? <View className="mr-2.5 h-5 w-1 rounded-full bg-primary" /> : null}
                      <Text numberOfLines={1} className={cn('flex-1 text-[15px]', current && 'font-semibold')}>
                        {c.title}
                      </Text>
                      <Pressable
                        onPress={() => confirmDelete(c)}
                        hitSlop={8}
                        className="h-8 w-8 items-center justify-center"
                        accessibilityLabel="更多"
                      >
                        <Icon as={MoreHorizontal} size={18} className="text-muted-foreground" />
                      </Pressable>
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </ScrollView>

          {/* 底部：搜索 + 设置 */}
          <View className="flex-row items-center gap-2 px-3 pb-3 pt-2">
            <View className="h-12 flex-1 flex-row items-center gap-2 rounded-full bg-background px-4">
              <Icon as={Search} size={18} className="text-muted-foreground" />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="搜索对话"
                placeholderTextColor="#94a3b8"
                className="h-12 flex-1 py-0 text-[15px] text-foreground"
                textAlignVertical="center"
              />
              {query ? (
                <Pressable onPress={() => setQuery('')} hitSlop={8}>
                  <Icon as={X} size={16} className="text-muted-foreground" />
                </Pressable>
              ) : null}
            </View>
            <Pressable
              onPress={() => go('/settings')}
              className="h-12 w-12 items-center justify-center rounded-full bg-background active:bg-muted"
              accessibilityLabel="设置"
            >
              <Icon as={Settings} size={20} className="text-foreground" />
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Animated.View>
    </View>
  );
}
