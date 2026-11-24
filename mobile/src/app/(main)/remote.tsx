// 虚拟桌面页：实时画面 + 直接点击 / 触控板 + 键盘输入（不经过大模型，直接调用电脑工具），
// 下方是 Agent 消息面板和发给 Agent 的输入框。
// 竖屏：画面铺满宽度；横屏：画面全屏，按钮竖排在右侧，隐藏状态栏。

import { useIsFocused } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Command,
  Keyboard,
  Maximize,
  Minimize,
  Monitor,
  MonitorSmartphone,
  MousePointer2,
  MousePointerClick,
  Send,
  Square,
  X,
} from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  TextInput,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type TextInputInstance,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { send, stop, useConversation } from '@/agent/conversations';
import { liveText } from '@/components/agent/live-label';
import { BackButton, goBack } from '@/components/back-button';
import { NotConnectedCard } from '@/components/connection-status';
import { FrameImage } from '@/components/frame-image';
import { AgentPanel } from '@/components/remote/agent-panel';
import { ActionMarker, CursorArrow, Crosshair, Loupe } from '@/components/remote/overlays';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { RemoteController, type Overlay } from '@/remote/controller';
import { toView } from '@/remote/geometry';
import { useScreenStream } from '@/remote/useScreenStream';
import { cycleView, useViewTargets, viewClient } from '@/state/multi';

const COMBOS: { label: string; keys: string }[] = [
  { label: 'Enter', keys: 'enter' },
  { label: 'Esc', keys: 'esc' },
  { label: '退格', keys: 'backspace' },
  { label: 'Tab', keys: 'tab' },
  { label: '复制', keys: 'ctrl+c' },
  { label: '粘贴', keys: 'ctrl+v' },
  { label: '剪切', keys: 'ctrl+x' },
  { label: '撤销', keys: 'ctrl+z' },
  { label: '全选', keys: 'ctrl+a' },
  { label: '保存', keys: 'ctrl+s' },
  { label: '切换窗口', keys: 'alt+tab' },
  { label: '关闭窗口', keys: 'alt+f4' },
  { label: '开始菜单', keys: 'win' },
  { label: '显示桌面', keys: 'win+d' },
  { label: '任务管理器', keys: 'ctrl+shift+esc' },
  { label: '刷新', keys: 'f5' },
];

export default function RemoteScreen() {
  const { view, targets } = useViewTargets();
  const status = view.status;
  const conv = useConversation();
  const [display, setDisplay] = useState(0);
  const { frame, displays, error, fps } = useScreenStream(display);
  // 触控板默认关闭：画面上直接点击；打开后竖屏在下方显示触控板，横屏时画面本身变成触控板
  const [trackpad, setTrackpad] = useState(false);
  const [rightNext, setRightNext] = useState(false);
  const [typing, setTyping] = useState(false);
  const [pcText, setPcText] = useState('');
  const [agentText, setAgentText] = useState('');
  const [combosOpen, setCombosOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [overlay, setOverlay] = useState<Overlay>({ pointer: null, cursor: null });
  const [landscapeWanted, setLandscapeWanted] = useState(false);
  const pcInputRef = useRef<TextInputInstance>(null);
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const landscape = win.width > win.height;
  const focused = useIsFocused();

  const tool = async (name: string, args: Record<string, unknown>) => {
    const c = viewClient();
    if (!c) return;
    try {
      const r = await c.callTool(name, args);
      if (r.isError) {
        const msg = r.content.find((x) => x.type === 'text');
        showToast(msg && msg.type === 'text' ? msg.text : '操作失败');
      }
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2500);
  };

  // 在本页时按需要的方向锁定。切换横竖屏只锁一次新方向（以前先恢复竖屏再锁横屏，要转两次，很慢）
  useEffect(() => {
    if (!focused) return;
    void ScreenOrientation.lockAsync(
      landscapeWanted ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP,
    ).catch(() => undefined);
    // 横屏全屏时窗口背景设为黑色，避免底部手势条区域露出白边
    void SystemUI.setBackgroundColorAsync(landscapeWanted ? '#000000' : '#ffffff').catch(() => undefined);
  }, [focused, landscapeWanted]);
  // 离开页面时恢复竖屏
  useEffect(() => {
    if (!focused) return;
    return () => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => undefined);
      void SystemUI.setBackgroundColorAsync('#ffffff').catch(() => undefined);
    };
  }, [focused]);

  // 画面按比例放进可用区域
  const aspect = frame ? frame.width / frame.height : 16 / 9;
  const fit =
    area.w && area.h ? (area.w / area.h > aspect ? { w: area.h * aspect, h: area.h } : { w: area.w, h: area.w / aspect }) : { w: 0, h: 0 };
  // 画面上的手势：横屏且打开触控板时按触控板处理，其余情况直接点击
  const screenMode = landscape && trackpad ? 'trackpad' : 'touch';

  // 手势控制器只创建一次；最新的画面、尺寸、模式在 effect 中同步给它
  const [ctrl] = useState(
    () =>
      new RemoteController(
        (args) =>
          void viewClient()
            ?.callTool('input_mouse', args)
            .catch(() => undefined),
        () => setRightNext(false),
        setOverlay,
      ),
  );
  useEffect(() => {
    ctrl.update(frame, fit.w, fit.h, screenMode, rightNext);
  }, [ctrl, frame, fit.w, fit.h, screenMode, rightNext]);

  const onArea = (e: LayoutChangeEvent) => setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });

  const sendPcText = () => {
    const t = pcText;
    if (!t) return;
    setPcText('');
    void tool('input_keyboard', { action: 'type', text: t });
  };

  const sendAgent = () => {
    const t = agentText.trim();
    if (!t || conv.running) return;
    setAgentText('');
    void send(t);
  };

  const marker = frame && fit.w && conv.running && conv.live?.point ? toView(frame, fit.w, conv.live.point.x, conv.live.point.y) : null;

  if (status !== 'connected') {
    return (
      <SafeAreaView edges={['top', 'bottom']} className="flex-1 bg-background">
        <Header title="虚拟桌面" sub="未连接" />
        <View className="p-4">
          <NotConnectedCard />
        </View>
      </SafeAreaView>
    );
  }

  /** 画面（含叠加层和手势） */
  const screen = (
    <View onLayout={onArea} className="flex-1 items-center justify-center">
      {frame && fit.w ? (
        <View style={{ width: fit.w, height: fit.h }} className="overflow-hidden bg-black" {...ctrl.screenPan.panHandlers}>
          <FrameImage uri={frame.uri} />
          {marker ? <ActionMarker left={marker.left} top={marker.top} /> : null}
          {overlay.cursor ? <CursorArrow left={overlay.cursor.left} top={overlay.cursor.top} /> : null}
          {overlay.pointer ? (
            <>
              <Crosshair x={overlay.pointer.x} y={overlay.pointer.y} />
              <Loupe frame={frame} viewW={fit.w} viewH={fit.h} x={overlay.pointer.x} y={overlay.pointer.y} />
            </>
          ) : null}
          {rightNext ? (
            <View pointerEvents="none" className="absolute left-2 top-2 rounded bg-blue-600 px-2 py-0.5">
              <Text className="text-[10px] text-white">下一次点击为右键</Text>
            </View>
          ) : null}
          {landscape && conv.running ? (
            <View
              pointerEvents="none"
              className="absolute bottom-2 left-2 right-2 flex-row items-center gap-1.5 rounded-md bg-black/70 px-2 py-1"
            >
              <Icon as={Bot} size={12} className="text-blue-300" />
              <Text numberOfLines={1} className="flex-1 text-[11px] text-white">
                {liveText(conv.live, true)}
              </Text>
            </View>
          ) : null}
        </View>
      ) : (
        <View className="items-center justify-center gap-2 p-6">
          {error ? <Text className="text-center text-xs text-zinc-400">{error}</Text> : <ActivityIndicator color="#a1a1aa" />}
        </View>
      )}
    </View>
  );

  /** 直接输入到电脑的文字框（键盘按钮打开） */
  const pcKeyboardBar = (
    <View className="h-10 flex-row items-center gap-2 rounded-lg border border-border bg-background px-3">
      <Icon as={Keyboard} size={14} className="text-muted-foreground" />
      <TextInput
        ref={pcInputRef}
        value={pcText}
        onChangeText={setPcText}
        onSubmitEditing={sendPcText}
        placeholder="输入文字，直接打到电脑上"
        placeholderTextColor="#94a3b8"
        returnKeyType="send"
        submitBehavior="submit"
        // Android 的 TextInput 自带上下内边距，放进 h-10 的框里文字会被截断
        className="h-10 flex-1 py-0 text-sm text-foreground"
        textAlignVertical="center"
      />
      <Pressable onPress={sendPcText} hitSlop={8}>
        <Icon as={Send} size={14} className={pcText ? 'text-primary' : 'text-muted-foreground'} />
      </Pressable>
      <Pressable onPress={() => setTyping(false)} hitSlop={8}>
        <Icon as={X} size={14} className="text-muted-foreground" />
      </Pressable>
    </View>
  );

  const openTyping = () => {
    setTyping(true);
    setTimeout(() => pcInputRef.current?.focus(), 50);
  };
  const toggleLandscape = () => setLandscapeWanted((v) => !v);
  const scroll = (dy: number) => void tool('input_mouse', { action: 'scroll', dy });

  const common = (
    <>
      {toast ? (
        <View pointerEvents="none" className="absolute bottom-28 self-center rounded-md bg-zinc-800 px-3 py-2">
          <Text className="text-xs text-zinc-100">{toast}</Text>
        </View>
      ) : null}
      <CombosSheet
        open={combosOpen}
        onClose={() => setCombosOpen(false)}
        onPick={(keys) => {
          setCombosOpen(false);
          void tool('input_keyboard', { action: 'key', keys });
        }}
      />
    </>
  );

  // ---------- 横屏：全屏画面 + 右侧按钮 ----------
  if (landscape) {
    const side = [
      <SideButton key="portrait" icon={Minimize} label="竖屏" onPress={toggleLandscape} />,
      <SideButton key="pad" icon={MousePointer2} label="触控板" active={trackpad} onPress={() => setTrackpad((v) => !v)} />,
      <SideButton key="kbd" icon={Keyboard} label="键盘" active={typing} onPress={openTyping} />,
      <SideButton key="right" icon={MousePointerClick} label="右键" active={rightNext} onPress={() => setRightNext((v) => !v)} />,
      <SideButton key="up" icon={ArrowUp} label="上滚" onPress={() => scroll(3)} />,
      <SideButton key="down" icon={ArrowDown} label="下滚" onPress={() => scroll(-3)} />,
      <SideButton key="combo" icon={Command} label="组合键" onPress={() => setCombosOpen(true)} />,
      ...(targets.length > 1
        ? [<SideButton key="pc" icon={MonitorSmartphone} label={view.name} onPress={() => cycleView(targets, view)} />]
        : []),
      ...(displays > 1
        ? [<SideButton key="display" icon={Monitor} label={`屏幕 ${display + 1}`} onPress={() => setDisplay((d) => (d + 1) % displays)} />]
        : []),
      <SideButton key="agent" icon={Bot} label="Agent" onPress={goBack} />,
    ];
    // 按钮全部放得下：一列放不下就分成几列（以前一列滚动，下面的按钮跑到屏幕外）
    const usable = win.height - insets.top - insets.bottom - SIDE_PAD * 2;
    const perCol = Math.max(1, Math.floor((usable + SIDE_GAP) / (SIDE_BTN + SIDE_GAP)));
    const cols: React.ReactElement[][] = [];
    for (let i = 0; i < side.length; i += perCol) cols.push(side.slice(i, i + perCol));
    return (
      <View className="flex-1 flex-row bg-black">
        <StatusBar hidden />
        <View style={{ flex: 1, paddingLeft: insets.left }}>
          {screen}
          {typing ? <View className="absolute left-3 right-3 top-3">{pcKeyboardBar}</View> : null}
        </View>
        <View
          style={{ paddingTop: insets.top + SIDE_PAD, paddingBottom: insets.bottom + SIDE_PAD, paddingRight: insets.right + 6, gap: SIDE_GAP }}
          className="flex-row justify-center border-l border-zinc-800 bg-zinc-950 pl-1.5"
        >
          {cols.map((col, i) => (
            <View key={i} style={{ gap: SIDE_GAP }} className="justify-center">
              {col}
            </View>
          ))}
        </View>
        {common}
      </View>
    );
  }

  // ---------- 竖屏 ----------
  return (
    <SafeAreaView edges={['top', 'bottom']} className="flex-1 bg-background">
      <Header
        title="虚拟桌面"
        sub={`${targets.length > 1 ? `${view.name} · ` : ''}${frame ? `${fps} fps` : '正在获取画面…'}`}
        right={
          <>
            {targets.length > 1 ? (
              <Pressable
                onPress={() => cycleView(targets, view)}
                accessibilityLabel="切换电脑"
                className="max-w-28 flex-row items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-1.5"
              >
                <Icon as={MonitorSmartphone} size={12} className="text-primary" />
                <Text numberOfLines={1} className="flex-shrink text-xs text-primary">
                  {view.name}
                </Text>
              </Pressable>
            ) : null}
            {displays > 1 ? (
              <Pressable
                onPress={() => setDisplay((d) => (d + 1) % displays)}
                className="flex-row items-center gap-1 rounded-md border border-border px-2 py-1.5"
              >
                <Icon as={Monitor} size={12} className="text-foreground" />
                <Text className="text-xs">{`屏幕 ${display + 1}/${displays}`}</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={toggleLandscape}
              hitSlop={6}
              className="flex-row items-center gap-1 rounded-md border border-border px-2 py-1.5"
            >
              <Icon as={Maximize} size={12} className="text-foreground" />
              <Text className="text-xs">横屏</Text>
            </Pressable>
          </>
        }
      />

      {/* Android 15 全面屏下系统不会自动缩小页面，由 keyboard-controller 让输入框跟随键盘 */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        {/* 画面：铺满宽度，直接点击 */}
        <View style={{ height: win.width / aspect }} className="bg-black">
          {screen}
        </View>

        <View className="flex-1 gap-2 px-3 pb-2 pt-2">
          <View className="flex-row gap-2">
            <ToolButton icon={MousePointer2} label="触控板" active={trackpad} onPress={() => setTrackpad((v) => !v)} />
            <ToolButton icon={Keyboard} label="键盘" active={typing} onPress={() => (typing ? setTyping(false) : openTyping())} />
            <ToolButton icon={MousePointerClick} label="右键" active={rightNext} onPress={() => setRightNext((v) => !v)} />
            <ToolButton icon={ArrowUp} label="上滚" onPress={() => scroll(3)} />
            <ToolButton icon={ArrowDown} label="下滚" onPress={() => scroll(-3)} />
            <ToolButton icon={Command} label="组合键" onPress={() => setCombosOpen(true)} />
          </View>
          {typing ? pcKeyboardBar : null}

          {trackpad ? (
            <View
              {...ctrl.padPan.panHandlers}
              className="flex-1 items-center justify-center gap-1 rounded-2xl border border-dashed border-border bg-muted"
            >
              <Icon as={MousePointer2} size={20} className="text-muted-foreground" />
              <Text className="text-[11px] text-muted-foreground">滑动移动鼠标 · 轻点左键 · 长按右键</Text>
            </View>
          ) : (
            <AgentPanel items={conv.items} running={conv.running} live={conv.live} />
          )}

          {/* 发给 Agent */}
          <View className="flex-row items-end gap-2 rounded-3xl border border-border bg-background py-1.5 pl-4 pr-1.5">
            <TextInput
              value={agentText}
              onChangeText={setAgentText}
              placeholder="让 Agent 操作电脑…"
              placeholderTextColor="#94a3b8"
              multiline
              textAlignVertical="center"
              className="max-h-24 min-h-8 flex-1 py-0 text-sm text-foreground"
            />
            {conv.running ? (
              <Pressable onPress={stop} className="h-8 w-8 items-center justify-center rounded-full bg-foreground">
                <Icon as={Square} size={12} className="text-background" fill="currentColor" />
              </Pressable>
            ) : (
              <Pressable
                onPress={sendAgent}
                disabled={!agentText.trim()}
                className={cn('h-8 w-8 items-center justify-center rounded-full bg-primary', !agentText.trim() && 'opacity-40')}
              >
                <Icon as={ArrowUp} size={16} className="text-primary-foreground" />
              </Pressable>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
      {common}
    </SafeAreaView>
  );
}

function Header({ title, sub, right }: { title: string; sub: string; right?: React.ReactNode }) {
  return (
    <View className="flex-row items-center gap-2 border-b border-border px-4 pb-2.5 pt-2">
      <BackButton />
      <View className="flex-1">
        <Text className="text-base font-semibold">{title}</Text>
        <Text className="text-xs text-muted-foreground">{sub}</Text>
      </View>
      {right}
    </View>
  );
}

function CombosSheet({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (keys: string) => void }) {
  return (
    <Modal visible={open} transparent animationType="slide" supportedOrientations={['portrait', 'landscape']} onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/50" onPress={onClose} />
      <SafeAreaView edges={['bottom', 'left', 'right']} className="rounded-t-2xl bg-background px-4 pb-4 pt-3">
        <View className="mb-3 flex-row items-center">
          <Text className="flex-1 text-sm font-semibold">组合键</Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <Icon as={X} size={16} className="text-muted-foreground" />
          </Pressable>
        </View>
        <View className="flex-row flex-wrap gap-2">
          {COMBOS.map((c) => (
            <Pressable
              key={c.keys}
              onPress={() => onPick(c.keys)}
              className="w-[23%] items-center rounded-lg border border-border bg-card py-2.5 active:bg-muted"
            >
              <Text className="text-xs">{c.label}</Text>
              <Text className="text-[10px] text-muted-foreground">{c.keys}</Text>
            </Pressable>
          ))}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function ToolButton({ icon, label, onPress, active }: { icon: typeof Keyboard; label: string; onPress: () => void; active?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        'flex-1 items-center gap-1 rounded-xl border py-2 active:opacity-80',
        active ? 'border-primary bg-primary' : 'border-border bg-card',
      )}
    >
      <Icon as={icon} size={16} className={active ? 'text-primary-foreground' : 'text-foreground'} />
      <Text className={cn('text-[10px]', active ? 'text-primary-foreground' : 'text-foreground')}>{label}</Text>
    </Pressable>
  );
}

/** 横屏右侧按钮的高度、间距、上下留白 */
const SIDE_BTN = 40;
const SIDE_GAP = 4;
const SIDE_PAD = 6;

interface SideItem {
  icon: typeof Keyboard;
  label: string;
  onPress: () => void;
  active?: boolean;
}

function SideButton({ icon, label, onPress, active }: SideItem) {
  return (
    <Pressable
      onPress={onPress}
      style={{ height: SIDE_BTN }}
      className={cn('w-14 items-center justify-center gap-0.5 rounded-lg active:bg-zinc-800', active && 'bg-blue-600')}
    >
      <Icon as={icon} size={18} className={active ? 'text-white' : 'text-zinc-300'} />
      <Text numberOfLines={1} className={cn('text-[9px]', active ? 'text-white' : 'text-zinc-400')}>
        {label}
      </Text>
    </Pressable>
  );
}
