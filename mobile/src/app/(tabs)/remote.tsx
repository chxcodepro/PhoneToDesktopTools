// 远程桌面页：实时画面 + 触控 / 触控板操作 + 键盘输入（不经过大模型，直接调用电脑工具）。

import { router } from 'expo-router';
import { ArrowDown, ArrowUp, Bot, Command, Keyboard, Monitor, MousePointer2, MousePointerClick, Send } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  TextInput,
  View,
  type LayoutChangeEvent,
  type TextInputInstance,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NotConnectedCard } from '@/components/connection-status';
import { FrameImage } from '@/components/frame-image';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { RemoteController } from '@/remote/controller';
import { toView } from '@/remote/geometry';
import { useScreenStream } from '@/remote/useScreenStream';
import { getClient, useConnection } from '@/state/connection';

type Mode = 'touch' | 'trackpad';

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
  const { status } = useConnection();
  const [display, setDisplay] = useState(0);
  const { frame, displays, error, fps } = useScreenStream(display);
  const [mode, setMode] = useState<Mode>('touch');
  const [rightNext, setRightNext] = useState(false);
  const [text, setText] = useState('');
  const [combosOpen, setCombosOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [viewW, setViewW] = useState(0);
  const inputRef = useRef<TextInputInstance>(null);

  const tool = async (name: string, args: Record<string, unknown>) => {
    const c = getClient();
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

  // 手势控制器只创建一次；最新的画面、视图宽度等在 effect 中同步给它
  const [ctrl] = useState(
    () =>
      new RemoteController(
        (args) => void getClient()?.callTool('input_mouse', args).catch(() => undefined),
        () => setRightNext(false),
      ),
  );
  useEffect(() => {
    ctrl.update(frame, viewW, rightNext);
  }, [ctrl, frame, viewW, rightNext]);

  const onLayout = (e: LayoutChangeEvent) => setViewW(e.nativeEvent.layout.width);
  const aspect = frame ? frame.width / frame.height : 16 / 10;
  const cursorPos =
    frame && viewW && frame.cursorX !== undefined && frame.cursorY !== undefined
      ? toView(frame, viewW, frame.cursorX, frame.cursorY)
      : null;

  const sendText = () => {
    const t = text;
    if (!t) return;
    setText('');
    void tool('input_keyboard', { action: 'type', text: t });
  };

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-zinc-950">
      <View className="flex-row items-center gap-3 border-b border-zinc-800 px-4 pb-2.5 pt-2">
        <View className="flex-1">
          <Text className="text-base font-semibold text-zinc-50">远程桌面</Text>
          <Text className="text-xs text-zinc-400">{frame ? `${fps} fps` : status === 'connected' ? '正在获取画面…' : '未连接'}</Text>
        </View>
        {displays > 1 ? (
          <Pressable onPress={() => setDisplay((d) => (d + 1) % displays)} className="flex-row items-center gap-1 rounded-md border border-zinc-800 px-2 py-1">
            <Icon as={Monitor} size={12} className="text-zinc-300" />
            <Text className="text-xs text-zinc-300">{`屏幕 ${display + 1}/${displays}`}</Text>
          </Pressable>
        ) : null}
        <View className="flex-row rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
          {(['touch', 'trackpad'] as const).map((m) => (
            <Pressable key={m} onPress={() => setMode(m)} className={cn('rounded-md px-2.5 py-1', mode === m && 'bg-zinc-700')}>
              <Text className={cn('text-xs font-medium', mode === m ? 'text-white' : 'text-zinc-400')}>{m === 'touch' ? '触控' : '触控板'}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {status !== 'connected' ? (
        <View className="p-4">
          <NotConnectedCard />
        </View>
      ) : (
        <View className="flex-1 gap-3 px-3 pt-3">
          {/* 画面 */}
          <View onLayout={onLayout} style={{ aspectRatio: aspect }} className="w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            {frame ? (
              <>
                <FrameImage uri={frame.uri} />
                {cursorPos ? (
                  <View pointerEvents="none" style={{ position: 'absolute', left: cursorPos.left - 1, top: cursorPos.top - 1 }}>
                    <Icon as={MousePointer2} size={14} className="text-white" fill="#000" />
                  </View>
                ) : null}
                {mode === 'touch' ? (
                  <Pressable
                    style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}
                    onPress={(e) => ctrl.tap(e.nativeEvent.locationX, e.nativeEvent.locationY, false)}
                    onLongPress={(e) => ctrl.tap(e.nativeEvent.locationX, e.nativeEvent.locationY, true)}
                    delayLongPress={450}
                  />
                ) : null}
              </>
            ) : (
              <View className="flex-1 items-center justify-center gap-2">
                {error ? <Text className="px-6 text-center text-xs text-zinc-400">{error}</Text> : <ActivityIndicator color="#a1a1aa" />}
              </View>
            )}
            {rightNext ? (
              <View pointerEvents="none" className="absolute left-2 top-2 rounded bg-blue-600 px-2 py-0.5">
                <Text className="text-[10px] text-white">下一次点击为右键</Text>
              </View>
            ) : null}
          </View>

          {/* 工具栏 */}
          <View className="flex-row gap-2">
            <ToolButton icon={Keyboard} label="键盘" onPress={() => inputRef.current?.focus()} />
            <ToolButton icon={MousePointerClick} label="右键" active={rightNext} onPress={() => setRightNext((v) => !v)} />
            <ToolButton icon={ArrowUp} label="上滚" onPress={() => void tool('input_mouse', { action: 'scroll', dy: 3 })} />
            <ToolButton icon={ArrowDown} label="下滚" onPress={() => void tool('input_mouse', { action: 'scroll', dy: -3 })} />
            <ToolButton icon={Command} label="组合键" onPress={() => setCombosOpen(true)} />
          </View>

          {/* 文字输入 */}
          <View className="h-10 flex-row items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3">
            <Icon as={Keyboard} size={14} className="text-zinc-500" />
            <TextInput
              ref={inputRef}
              value={text}
              onChangeText={setText}
              onSubmitEditing={sendText}
              placeholder="输入文字发送到电脑"
              placeholderTextColor="#71717a"
              returnKeyType="send"
              // Android 的 TextInput 自带上下内边距，放进 h-10 的框里文字会被截断
              className="h-10 flex-1 py-0 text-sm text-zinc-100"
              textAlignVertical="center"
            />
            <Pressable onPress={sendText} hitSlop={8}>
              <Icon as={Send} size={14} className={text ? 'text-blue-400' : 'text-zinc-600'} />
            </Pressable>
          </View>

          {/* 触控板区域 */}
          {mode === 'trackpad' ? (
            <View {...ctrl.pan.panHandlers} className="min-h-[80px] flex-1 items-center justify-center rounded-2xl border border-dashed border-zinc-700">
              <Icon as={MousePointer2} size={22} className="text-zinc-600" />
            </View>
          ) : (
            <View className="flex-1" />
          )}

          <Pressable onPress={() => router.navigate('/')} className="mb-3 h-11 flex-row items-center justify-center gap-2 rounded-full bg-blue-600 active:opacity-80">
            <Icon as={Bot} size={16} className="text-white" />
            <Text className="text-sm font-semibold text-white">交给 Agent</Text>
          </Pressable>
        </View>
      )}

      {toast ? (
        <View pointerEvents="none" className="absolute bottom-24 self-center rounded-md bg-zinc-800 px-3 py-2">
          <Text className="text-xs text-zinc-100">{toast}</Text>
        </View>
      ) : null}

      <Modal visible={combosOpen} transparent animationType="slide" onRequestClose={() => setCombosOpen(false)}>
        <Pressable className="flex-1 bg-black/50" onPress={() => setCombosOpen(false)} />
        <SafeAreaView edges={['bottom']} className="rounded-t-2xl bg-zinc-900 px-4 pb-4 pt-3">
          <Text className="mb-3 text-sm font-semibold text-zinc-100">组合键</Text>
          <View className="flex-row flex-wrap gap-2">
            {COMBOS.map((c) => (
              <Pressable
                key={c.keys}
                onPress={() => {
                  setCombosOpen(false);
                  void tool('input_keyboard', { action: 'key', keys: c.keys });
                }}
                className="w-[23%] items-center rounded-lg border border-zinc-800 bg-zinc-950 py-2.5 active:bg-zinc-800"
              >
                <Text className="text-xs text-zinc-100">{c.label}</Text>
                <Text className="text-[10px] text-zinc-500">{c.keys}</Text>
              </Pressable>
            ))}
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function ToolButton({ icon, label, onPress, active }: { icon: typeof Keyboard; label: string; onPress: () => void; active?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        'flex-1 items-center gap-1 rounded-xl border py-2.5 active:opacity-80',
        active ? 'border-blue-600 bg-blue-600' : 'border-zinc-800 bg-zinc-900',
      )}
    >
      <Icon as={icon} size={18} className={active ? 'text-white' : 'text-zinc-300'} />
      <Text className={cn('text-[10px]', active ? 'text-white' : 'text-zinc-300')}>{label}</Text>
    </Pressable>
  );
}
