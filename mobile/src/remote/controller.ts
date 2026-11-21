// 虚拟桌面手势控制器：把手机上的触摸换算成电脑鼠标操作。
// 放在组件外部的普通对象里（避免在渲染期间读写 ref），通过 onOverlay 把需要画出来的准星 / 鼠标位置交给界面。
//
// 触控模式（作用于画面）：
//   轻点 → 点击手指位置；按住后拖动 → 手指上方出现准星（附放大镜），松手点击准星位置；长按不动 → 右键。
// 触控板模式（作用于画面或下方触控板）：
//   拖动 → 相对移动鼠标（带加速，本地先画出预测位置）；轻点 → 左键；长按 → 右键。

import { PanResponder, type GestureResponderEvent, type PanResponderGestureState, type PanResponderInstance } from 'react-native';

import { toScreen, toView } from './geometry';
import type { ScreenFrame } from './useScreenStream';

export type MouseAction = (args: Record<string, unknown>) => void;
export type Mode = 'touch' | 'trackpad';

export interface Overlay {
  /** 触控模式的准星（画面坐标），null 表示不显示 */
  pointer: { x: number; y: number } | null;
  /** 鼠标位置（画面坐标）：触控板操作时用本地预测值，否则用电脑回传的位置 */
  cursor: { left: number; top: number } | null;
}

/** 准星在手指上方的距离（dp），避免手指挡住目标 */
export const POINTER_OFFSET = 64;
const TAP_SLOP = 8;
const LONG_PRESS_MS = 550;
const MOVE_INTERVAL_MS = 33;
/** 本地预测的鼠标位置在最后一次移动后保留多久，之后改用电脑回传的位置 */
const LOCAL_CURSOR_MS = 800;

export class RemoteController {
  private frame: ScreenFrame | null = null;
  private viewW = 0;
  private viewH = 0;
  private mode: Mode = 'touch';
  private rightNext = false;

  /** 电脑上的鼠标位置（屏幕坐标） */
  private cursor = { x: 0, y: 0 };
  private localUntil = 0;
  private pointer: { x: number; y: number } | null = null;

  // 当前手势
  private start = { x: 0, y: 0 };
  private startAt = 0;
  private moved = false;
  private precision = false;
  private longDone = false;
  private longTimer: ReturnType<typeof setTimeout> | null = null;
  private prev = { dx: 0, dy: 0, t: 0 };
  private lastSend = 0;

  readonly screenPan: PanResponderInstance;
  readonly padPan: PanResponderInstance;

  constructor(
    private mouse: MouseAction,
    private onConsumeRight: () => void,
    private onOverlay: (o: Overlay) => void,
  ) {
    const make = (surface: 'screen' | 'pad') =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => this.begin(surface, e),
        onPanResponderMove: (_, g) => this.move(surface, g),
        onPanResponderRelease: (_, g) => this.end(surface, g),
        onPanResponderTerminate: () => this.cancel(),
      });
    this.screenPan = make('screen');
    this.padPan = make('pad');
  }

  update(frame: ScreenFrame | null, viewW: number, viewH: number, mode: Mode, rightNext: boolean): void {
    this.frame = frame;
    this.viewW = viewW;
    this.viewH = viewH;
    this.mode = mode;
    this.rightNext = rightNext;
    if (frame?.cursorX !== undefined && frame.cursorY !== undefined && Date.now() > this.localUntil) {
      this.cursor = { x: frame.cursorX, y: frame.cursorY };
    }
    this.emit();
  }

  private emit(): void {
    const f = this.frame;
    const cursor = f && this.viewW ? toView(f, this.viewW, this.cursor.x, this.cursor.y) : null;
    this.onOverlay({ pointer: this.pointer, cursor });
  }

  private takeRight(): boolean {
    const r = this.rightNext;
    if (r) {
      this.rightNext = false;
      this.onConsumeRight();
    }
    return r;
  }

  private clearTimer(): void {
    if (this.longTimer) clearTimeout(this.longTimer);
    this.longTimer = null;
  }

  private clampView(x: number, y: number): { x: number; y: number } {
    return { x: Math.max(0, Math.min(this.viewW - 1, x)), y: Math.max(0, Math.min(this.viewH - 1, y)) };
  }

  /** 屏幕坐标限制在当前显示器内 */
  private clampScreen(x: number, y: number): { x: number; y: number } {
    const f = this.frame;
    if (!f) return { x, y };
    const w = f.width / f.scale;
    const h = f.height / f.scale;
    return { x: Math.round(Math.max(f.x, Math.min(f.x + w - 1, x))), y: Math.round(Math.max(f.y, Math.min(f.y + h - 1, y))) };
  }

  private sendMove(p: { x: number; y: number }, force = false): void {
    const now = Date.now();
    if (!force && now - this.lastSend < MOVE_INTERVAL_MS) return;
    this.lastSend = now;
    this.mouse({ action: 'move', ...p });
  }

  private begin(surface: 'screen' | 'pad', e: GestureResponderEvent): void {
    this.start = { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY };
    this.startAt = Date.now();
    this.moved = false;
    this.precision = false;
    this.longDone = false;
    this.prev = { dx: 0, dy: 0, t: this.startAt };
    this.clearTimer();
    const touch = surface === 'screen' && this.mode === 'touch';
    this.longTimer = setTimeout(() => {
      if (this.moved || this.precision || !this.frame || !this.viewW) return;
      this.longDone = true;
      if (touch) this.mouse({ action: 'right_click', ...toScreen(this.frame, this.viewW, this.start.x, this.start.y) });
      else this.mouse({ action: 'right_click' });
    }, LONG_PRESS_MS);
  }

  private move(surface: 'screen' | 'pad', g: PanResponderGestureState): void {
    if (this.longDone) return;
    if (!this.moved && Math.hypot(g.dx, g.dy) > TAP_SLOP) {
      this.moved = true;
      this.clearTimer();
    }
    if (!this.moved) return;
    if (surface === 'screen' && this.mode === 'touch') this.touchMove(g);
    else this.trackpadMove(g);
  }

  private touchMove(g: PanResponderGestureState): void {
    const f = this.frame;
    if (!f || !this.viewW) return;
    this.precision = true;
    this.pointer = this.clampView(this.start.x + g.dx, this.start.y + g.dy - POINTER_OFFSET);
    // 让电脑上的鼠标跟着准星走，悬停提示等也能看到
    const p = toScreen(f, this.viewW, this.pointer.x, this.pointer.y);
    this.cursor = p;
    this.localUntil = Date.now() + LOCAL_CURSOR_MS;
    this.sendMove(p);
    this.emit();
  }

  private trackpadMove(g: PanResponderGestureState): void {
    const f = this.frame;
    if (!f || !this.viewW) return;
    const now = Date.now();
    const step = { dx: g.dx - this.prev.dx, dy: g.dy - this.prev.dy };
    const dt = Math.max(1, now - this.prev.t);
    this.prev = { dx: g.dx, dy: g.dy, t: now };
    // 基础比例：手指移动 1dp ≈ 画面上 1dp 对应的屏幕距离；快速滑动时加速（最多 3 倍）
    const base = f.width / this.viewW / f.scale;
    const speed = Math.hypot(step.dx, step.dy) / dt; // dp/ms
    const k = base * (1 + Math.min(2, speed * 1.5));
    this.cursor = this.clampScreen(this.cursor.x + step.dx * k, this.cursor.y + step.dy * k);
    this.localUntil = now + LOCAL_CURSOR_MS;
    this.sendMove(this.cursor);
    this.emit();
  }

  private end(surface: 'screen' | 'pad', g: PanResponderGestureState): void {
    this.clearTimer();
    const f = this.frame;
    if (this.longDone || !f || !this.viewW) return this.reset();
    if (surface === 'screen' && this.mode === 'touch') {
      const target = this.precision && this.pointer ? this.pointer : { x: this.start.x, y: this.start.y };
      const right = this.takeRight();
      this.mouse({ action: right ? 'right_click' : 'click', ...toScreen(f, this.viewW, target.x, target.y) });
    } else if (!this.moved && Math.hypot(g.dx, g.dy) <= TAP_SLOP) {
      // 触控板轻点：在当前鼠标位置点击（先把最后的位置发过去）
      this.sendMove(this.cursor, true);
      this.mouse({ action: this.takeRight() ? 'right_click' : 'click' });
    } else {
      this.sendMove(this.cursor, true);
    }
    this.reset();
  }

  private cancel(): void {
    this.clearTimer();
    this.reset();
  }

  private reset(): void {
    this.precision = false;
    if (this.pointer) {
      this.pointer = null;
      this.emit();
    }
  }
}
