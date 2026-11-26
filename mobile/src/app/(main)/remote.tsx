// 虚拟桌面页：实时画面 + 触控 / 触控板 + 键盘输入（不经过大模型，直接调用电脑工具），
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
  MonitorOff,
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
  Dimensions,
  Modal,
  PixelRatio,
  Pressable,
  StyleSheet,
  TextInput,
  Vibration,
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
import { ActionMarker, CursorArrow } from '@/components/remote/overlays';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { ScreenCanvas } from '@/native/screenCanvas';
import { RemoteController, type Overlay } from '@/remote/controller';
import { NO_ZOOM, toView } from '@/remote/geometry';
import { useScreenStream } from '@/remote/useScreenStream';
import { setBlank } from '@/state/blank';
import { useConnection } from '@/state/connection';
import { useDevices } from '@/state/devices';
import { cycleView, useViewTargets, viewClient } from '@/state/multi';
import { osInfo } from '@/state/osInfo';

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

/** Mac 上的对应快捷键（cmd 即 Command 键） */
const MAC_COMBOS: { label: string; keys: string }[] = [
  { label: 'Return', keys: 'enter' },
  { label: 'Esc', keys: 'esc' },
  { label: '删除', keys: 'backspace' },
  { label: 'Tab', keys: 'tab' },
  { label: '复制', keys: 'cmd+c' },
  { label: '粘贴', keys: 'cmd+v' },
  { label: '剪切', keys: 'cmd+x' },
  { label: '撤销', keys: 'cmd+z' },
  { label: '全选', keys: 'cmd+a' },
  { label: '保存', keys: 'cmd+s' },
  { label: '切换应用', keys: 'cmd+tab' },
  { label: '关闭窗口', keys: 'cmd+w' },
  { label: '聚焦搜索', keys: 'cmd+space' },
  { label: '调度中心', keys: 'ctrl+up' },
  { label: '强制退出', keys: 'cmd+alt+esc' },
  { label: '刷新', keys: 'cmd+r' },
];

export default function RemoteScreen() {
  const { view, targets } = useViewTargets();
  const status = view.status;
  const conv = useConversation();
  // 正在看的电脑是不是 Mac：组合键面板换成 Command 键的版本
  const conn = useConnection();
  const { devices } = useDevices();
  const viewDev = devices.find((d) => d.pcId === (view.pcId ?? conn.pcId));
  const isMac = osInfo(viewDev?.os ?? (view.pcId ? undefined : conn.params?.os), viewDev?.osName).family === 'macos';
  // 黑屏：这台电脑开过就记住，下次连上自动打开
  const blankOn = !!viewDev?.blank;
  const toggleBlank = async () => {
    const next = !blankOn;
    const err = await setBlank(viewClient(), view.pcId ?? conn.pcId, next);
    showToast(err ?? (next ? '电脑显示器已黑屏，手机上照常操作；断开后自动恢复' : '已恢复电脑显示'));
  };
  const [display, setDisplay] = useState(0);
  // 分块推流按手机屏幕的物理像素请求原生分辨率（电脑端不会放大，屏幕比这小就按屏幕原样发）
  const [streamWidth] = useState(() => {
    const scr = Dimensions.get('screen');
    return Math.round(Math.max(scr.width, scr.height) * PixelRatio.get());
  });
  const { frame, displays, error, fps } = useScreenStream(display, { tiles: true, maxWidth: streamWidth, quality: 75, fps: 30 });
  // 触控板默认关闭：画面上直接点击；打开后竖屏在下方显示触控板，横屏时画面本身变成触控板
  const [trackpad, setTrackpad] = useState(false);
  const [rightNext, setRightNext] = useState(false);
  const [typing, setTyping] = useState(false);
  const [pcText, setPcText] = useState('');
  const [agentText, setAgentText] = useState('');
  const [combosOpen, setCombosOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [overlay, setOverlay] = useState<Overlay>({ cursor: null, zoom: NO_ZOOM, press: null });
  const [hintDone, setHintDone] = useState<string | null>(null);
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
  // 画面上的手势：横屏且打开触控板时按触控板处理，其余情况按触控模式处理（手指点哪里鼠标就到哪里）
  const screenMode = landscape && trackpad ? 'trackpad' : 'touch';
  // 刚看到画面、切换操作方式时，在画面上提示几秒怎么操作
  const hintKey = frame && focused ? screenMode : null;
  const hint = hintKey !== null && hintDone !== hintKey;
  useEffect(() => {
    if (!hintKey) return;
    const t = setTimeout(() => setHintDone(hintKey), 5000);
    return () => clearTimeout(t);
  }, [hintKey]);

  // 手势控制器只创建一次；最新的画面、尺寸、模式在 effect 中同步给它
  const [ctrl] = useState(
    () =>
      new RemoteController(
        (args) => viewClient()?.callTool('input_mouse', args) ?? Promise.resolve(),
        () => setRightNext(false),
        setOverlay,
        () => Vibration.vibrate(15),
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
          {/* 画面内容按捏合缩放；里面的元素都不接收触摸，手势坐标统一按外层容器计算 */}
          <View
            pointerEvents="none"
            style={{
              width: fit.w,
              height: fit.h,
              transformOrigin: 'top left',
              transform: [{ translateX: overlay.zoom.ox }, { translateY: overlay.zoom.oy }, { scale: overlay.zoom.s }],
            }}
          >
            {frame.canvasId ? (
              <ScreenCanvas canvasId={frame.canvasId} style={StyleSheet.absoluteFill} />
            ) : (
              <FrameImage uri={frame.uri} />
            )}
            {marker ? <ActionMarker left={marker.left} top={marker.top} /> : null}
            {overlay.cursor ? <CursorArrow left={overlay.cursor.left} top={overlay.cursor.top} /> : null}
          </View>
          {overlay.press ? <PressRing x={overlay.press.x} y={overlay.press.y} drag={overlay.press.state === 'drag'} /> : null}
          {overlay.zoom.s > 1 ? (
            <Pressable
              onPress={() => ctrl.resetZoom()}
              hitSlop={6}
              className="absolute right-2 top-2 rounded bg-black/70 px-2 py-0.5"
              accessibilityLabel="还原画面大小"
            >
              <Text className="text-[10px] text-white">{`${overlay.zoom.s.toFixed(1)}× 还原`}</Text>
            </Pressable>
          ) : null}
          {hint ? (
            <View pointerEvents="none" className="absolute left-2 right-2 top-8 items-center">
              <Text className="rounded bg-black/70 px-2 py-1 text-center text-[10px] leading-4 text-white">
                {screenMode === 'touch'
                  ? '轻点 = 点击 · 点两下 = 双击 · 滑动 = 滚动\n长按后拖动 = 选文字 / 拖窗口 · 长按松手 = 右键 · 双指捏合 = 放大'
                  : '滑动移动鼠标 · 轻点 = 左键 · 长按 = 右键 · 双指上下滑 = 滚动 · 双指捏合 = 放大画面'}
              </Text>
            </View>
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
        combos={isMac ? MAC_COMBOS : COMBOS}
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
      <SideButton key="blank" icon={MonitorOff} label="黑屏" active={blankOn} onPress={() => void toggleBlank()} />,
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
        {/* 画面：铺满宽度，平板触控 */}
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
            <ToolButton icon={MonitorOff} label="黑屏" active={blankOn} onPress={() => void toggleBlank()} />
          </View>
          {typing ? pcKeyboardBar : null}

          {trackpad ? (
            <View
              {...ctrl.padPan.panHandlers}
              className="flex-1 items-center justify-center gap-1 rounded-2xl border border-dashed border-border bg-muted"
            >
              <Icon as={MousePointer2} size={20} className="text-muted-foreground" />
              <Text className="text-[11px] text-muted-foreground">滑动移动鼠标 · 轻点左键 · 长按右键 · 双指滑动滚动</Text>
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

/** 长按提示：长按后出现空心圆（可以拖动了），拖动中变成实心 */
function PressRing({ x, y, drag }: { x: number; y: number; drag: boolean }) {
  const r = 22;
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: x - r,
        top: y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: r,
        borderWidth: 2,
        borderColor: '#3b82f6',
        backgroundColor: drag ? 'rgba(59,130,246,0.35)' : 'rgba(59,130,246,0.12)',
      }}
    />
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

function CombosSheet({
  combos,
  open,
  onClose,
  onPick,
}: {
  combos: { label: string; keys: string }[];
  open: boolean;
  onClose: () => void;
  onPick: (keys: string) => void;
}) {
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
          {combos.map((c) => (
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
