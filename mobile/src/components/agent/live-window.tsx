// Agent 实时画面小窗：浮在对话区上，显示电脑画面、Agent 点击的位置和当前操作。
// 按住任意位置可以拖动，松手后贴到最近的左 / 右边缘，位置会记住。
// 画面本身不响应点击（不会误操作电脑），只有放大按钮（进入虚拟桌面）和 × 按钮可点。
// 默认在对话区右上角（最新消息在底部，不会被挡住），拖到别处后记住位置。

import { router } from 'expo-router';
import { Bot, Maximize2, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, PanResponder, Pressable, View, type PanResponderInstance } from 'react-native';

import type { LiveAction } from '@/agent/conversations';
import { liveText } from '@/components/agent/live-label';
import { FrameImage } from '@/components/frame-image';
import { ActionMarker, CursorArrow } from '@/components/remote/overlays';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toView } from '@/remote/geometry';
import { useScreenStream } from '@/remote/useScreenStream';
import { uiStore } from '@/state/ui';

const SMALL_W = 176;
/** 底部状态栏高度 */
const BAR_H = 26;
const MARGIN = 10;
/** 小窗位置：贴在哪一边、离对话区顶部多远（换页面、重新打开后保持） */
const saved: { side: 'left' | 'right'; fromTop: number } = { side: 'right', fromTop: MARGIN };

/** 拖动位置放在组件外的普通对象里，避免在渲染期间读写 ref */
class DragController {
  readonly pos = new Animated.ValueXY({ x: 0, y: 0 });
  readonly pan: PanResponderInstance;
  private area = { w: 0, h: 0 };
  private size = { w: SMALL_W, h: 0 };
  private cur = { x: 0, y: 0 };
  private start = { x: 0, y: 0 };

  constructor() {
    const moved = (dx: number, dy: number) => Math.hypot(dx, dy) > 4;
    this.pan = PanResponder.create({
      // 轻点交给按钮；一旦移动就由小窗接管（捕获阶段，按钮和外层的抽屉手势都抢不走）
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => moved(g.dx, g.dy),
      onMoveShouldSetPanResponderCapture: (_, g) => moved(g.dx, g.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        this.start = { ...this.cur };
      },
      onPanResponderMove: (_, g) => this.moveTo(this.start.x + g.dx, this.start.y + g.dy),
      onPanResponderRelease: (_, g) => this.snap(this.start.x + g.dx, this.start.y + g.dy),
      onPanResponderTerminate: () => this.snap(this.cur.x, this.cur.y),
    });
  }

  private clampY(y: number): number {
    return Math.max(MARGIN, Math.min(this.area.h - this.size.h - MARGIN, y));
  }

  private moveTo(x: number, y: number): void {
    this.cur = { x: Math.max(0, Math.min(this.area.w - this.size.w, x)), y: Math.max(0, Math.min(this.area.h - this.size.h, y)) };
    this.pos.setValue(this.cur);
  }

  private snap(x: number, y: number): void {
    const side = x + this.size.w / 2 < this.area.w / 2 ? 'left' : 'right';
    const to = { x: side === 'left' ? MARGIN : this.area.w - this.size.w - MARGIN, y: this.clampY(y) };
    saved.side = side;
    saved.fromTop = to.y;
    this.cur = to;
    Animated.spring(this.pos, { toValue: to, useNativeDriver: true, bounciness: 4 }).start();
  }

  /** 对话区或小窗尺寸变化时按记住的位置重新摆放 */
  place(area: { w: number; h: number }, size: { w: number; h: number }): void {
    this.area = area;
    this.size = size;
    const to = { x: saved.side === 'left' ? MARGIN : area.w - size.w - MARGIN, y: this.clampY(saved.fromTop) };
    this.cur = to;
    this.pos.setValue(to);
  }
}

export function LiveWindow({ live, running, area }: { live: LiveAction | null; running: boolean; area: { w: number; h: number } }) {
  const { frame } = useScreenStream(0, { maxWidth: 800, fps: 6, quality: 50 });
  const [ctl] = useState(() => new DragController());
  const w = SMALL_W;
  const aspect = frame ? frame.width / frame.height : 16 / 9;
  const h = w / aspect;

  useEffect(() => {
    if (area.w > 0 && area.h > 0) ctl.place(area, { w, h: h + BAR_H });
  }, [ctl, area, w, h]);

  const inView = (p: { left: number; top: number }) => p.left >= 0 && p.top >= 0 && p.left <= w && p.top <= h;
  const marker = frame && live?.point ? toView(frame, w, live.point.x, live.point.y) : null;
  const cursor =
    frame && frame.cursorX !== undefined && frame.cursorY !== undefined ? toView(frame, w, frame.cursorX, frame.cursorY) : null;

  return (
    <Animated.View
      {...ctl.pan.panHandlers}
      style={{
        width: w,
        position: 'absolute',
        left: 0,
        top: 0,
        zIndex: 10,
        elevation: 8,
        opacity: area.w > 0 ? 1 : 0,
        transform: ctl.pos.getTranslateTransform(),
      }}
      className="overflow-hidden rounded-xl border border-border bg-zinc-950 shadow-lg"
    >
      <View style={{ width: w, height: h }} className="items-center justify-center bg-black">
        {frame ? (
          <>
            <FrameImage uri={frame.uri} />
            {cursor && inView(cursor) ? <CursorArrow left={cursor.left} top={cursor.top} size={14} /> : null}
            {marker && inView(marker) ? <ActionMarker left={marker.left} top={marker.top} /> : null}
          </>
        ) : (
          <ActivityIndicator size="small" color="#a1a1aa" />
        )}
      </View>
      <View style={{ height: BAR_H }} className="flex-row items-center gap-1.5 px-2">
        <Icon as={Bot} size={12} className="text-blue-300" />
        <Text numberOfLines={1} className="flex-1 text-[11px] text-zinc-100">
          {liveText(live, running) || 'Agent 空闲'}
        </Text>
        <Pressable onPress={() => router.push('/remote')} hitSlop={8} accessibilityLabel="打开虚拟桌面">
          <Icon as={Maximize2} size={12} className="text-zinc-400" />
        </Pressable>
        <Pressable onPress={() => uiStore.set({ liveOpen: false })} hitSlop={8} accessibilityLabel="关闭实时画面">
          <Icon as={X} size={13} className="text-zinc-400" />
        </Pressable>
      </View>
    </Animated.View>
  );
}
