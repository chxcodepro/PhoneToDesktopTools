// 虚拟桌面手势控制器：把手机上的触摸换算成电脑鼠标操作。
// 放在组件外部的普通对象里（避免在渲染期间读写 ref），通过 onOverlay 把鼠标位置、画面缩放交给界面。
//
// 平板触控模式（作用于画面，手指就是鼠标，和 Windows 平板 / iPad 的触屏操作一样）：
//   轻点 → 点击手指位置；连续轻点两下 → 双击；按住拖动 → 按住左键拖动（拖窗口、选文字、拖文件）；
//   长按不动 → 右键；双指上下滑动 → 滚动；双指捏合 → 放大 / 缩小画面；双指轻点 → 右键。
// 触控板模式（作用于画面或下方触控板）：
//   拖动 → 相对移动鼠标（带加速，本地先画出预测位置）；轻点 → 左键；长按 → 右键；双指滑动 → 滚动。
//
// 鼠标操作经 MouseQueue 按顺序发送：电脑端并行执行工具调用，按下 / 移动 / 松开乱序会拖错。

import { PanResponder, type GestureResponderEvent, type PanResponderGestureState, type PanResponderInstance } from 'react-native';

import { NO_ZOOM, pinchZoom, toScreen, toView, unzoom, type Zoom } from './geometry';
import { MouseQueue, type MouseArgs } from './mouseQueue';
import type { ScreenFrame } from './useScreenStream';

export type MouseAction = (args: MouseArgs) => Promise<unknown>;
export type Mode = 'touch' | 'trackpad';

export interface Overlay {
  /** 鼠标位置（画面内容坐标）：触控板操作时用本地预测值，否则用电脑回传的位置 */
  cursor: { left: number; top: number } | null;
  /** 画面缩放 */
  zoom: Zoom;
}

const TAP_SLOP = 8;
const LONG_PRESS_MS = 550;
const MOVE_INTERVAL_MS = 33;
/** 两次轻点间隔多短、离得多近算双击（容器像素） */
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_SLOP = 24;
/** 双指轻点：时间和移动距离上限 */
const TWO_TAP_MS = 300;
/** 双指手势判定：距离变化超过 10% 算捏合，中点移动超过 12 像素（距离基本不变）算滚动 */
const PINCH_RATIO = 0.1;
const SCROLL_START = 12;
/** 双指滑动多少像素滚一格 */
const SCROLL_STEP = 24;
/** 本地预测的鼠标位置在最后一次移动后保留多久，之后改用电脑回传的位置 */
const LOCAL_CURSOR_MS = 800;

type Surface = 'screen' | 'pad';
type Phase = 'idle' | 'pending' | 'drag' | 'long' | 'two';
type Point = { x: number; y: number };

export class RemoteController {
  private frame: ScreenFrame | null = null;
  private viewW = 0;
  private viewH = 0;
  private mode: Mode = 'touch';
  private rightNext = false;
  private zoom: Zoom = NO_ZOOM;
  private queue: MouseQueue;

  /** 电脑上的鼠标位置（屏幕坐标） */
  private cursor = { x: 0, y: 0 };
  private localUntil = 0;

  // 当前手势（坐标都是容器坐标，即手指在画面区域上的位置）
  private phase: Phase = 'idle';
  private surface: Surface = 'screen';
  private origin: Point = { x: 0, y: 0 }; // 容器左上角的页面坐标
  private start: Point = { x: 0, y: 0 };
  private startAt = 0;
  private longTimer: ReturnType<typeof setTimeout> | null = null;
  private prev = { dx: 0, dy: 0, t: 0 };
  private lastSend = 0;
  private lastTap: { at: number; c: Point } | null = null;
  // 双指
  private two: {
    kind: 'undecided' | 'scroll' | 'pinch';
    at: number;
    m0: Point;
    d0: number;
    zoom0: Zoom;
    scrolled: number;
    maxMove: number;
  } | null = null;

  readonly screenPan: PanResponderInstance;
  readonly padPan: PanResponderInstance;

  constructor(
    mouse: MouseAction,
    private onConsumeRight: () => void,
    private onOverlay: (o: Overlay) => void,
  ) {
    this.queue = new MouseQueue(mouse);
    const make = (surface: Surface) =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => this.begin(surface, e),
        onPanResponderMove: (e, g) => this.move(surface, e, g),
        onPanResponderRelease: (e, g) => this.end(surface, e, g),
        onPanResponderTerminate: () => this.cancel(),
      });
    this.screenPan = make('screen');
    this.padPan = make('pad');
  }

  update(frame: ScreenFrame | null, viewW: number, viewH: number, mode: Mode, rightNext: boolean): void {
    // 画面区域大小变了（横竖屏切换、换了显示器）就恢复不缩放
    if (viewW !== this.viewW || viewH !== this.viewH) this.zoom = NO_ZOOM;
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

  /** 恢复画面不缩放 */
  resetZoom(): void {
    this.zoom = NO_ZOOM;
    this.emit();
  }

  private emit(): void {
    const f = this.frame;
    const cursor = f && this.viewW ? toView(f, this.viewW, this.cursor.x, this.cursor.y) : null;
    this.onOverlay({ cursor, zoom: this.zoom });
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

  /** 容器坐标 → 屏幕坐标（考虑画面缩放） */
  private screenAt(c: Point): Point | null {
    const f = this.frame;
    if (!f || !this.viewW) return null;
    const p = unzoom(this.zoom, c.x, c.y);
    const x = Math.max(0, Math.min(this.viewW - 1, p.x));
    const y = Math.max(0, Math.min(this.viewH - 1, p.y));
    return toScreen(f, this.viewW, x, y);
  }

  /** 屏幕坐标限制在当前显示器内 */
  private clampScreen(x: number, y: number): Point {
    const f = this.frame;
    if (!f) return { x, y };
    const w = f.width / f.scale;
    const h = f.height / f.scale;
    return { x: Math.round(Math.max(f.x, Math.min(f.x + w - 1, x))), y: Math.round(Math.max(f.y, Math.min(f.y + h - 1, y))) };
  }

  private send(args: MouseArgs): void {
    this.queue.push(args);
  }

  private sendMove(p: Point, force = false): void {
    const now = Date.now();
    if (!force && now - this.lastSend < MOVE_INTERVAL_MS) return;
    this.lastSend = now;
    this.send({ action: 'move', x: p.x, y: p.y });
  }

  /** 本地先把鼠标画到 p（屏幕坐标），电脑回传的位置一段时间内不覆盖它 */
  private showCursor(p: Point): void {
    this.cursor = p;
    this.localUntil = Date.now() + LOCAL_CURSOR_MS;
    this.emit();
  }

  /** 触摸点的容器坐标（第 i 个手指） */
  private touchPoints(e: GestureResponderEvent): Point[] {
    const ts = e.nativeEvent.touches ?? [];
    return ts.map((t) => ({ x: t.pageX - this.origin.x, y: t.pageY - this.origin.y }));
  }

  private tabletSurface(surface: Surface): boolean {
    return surface === 'screen' && this.mode === 'touch';
  }

  private begin(surface: Surface, e: GestureResponderEvent): void {
    const n = e.nativeEvent;
    // 画面里的子元素都不接收触摸（pointerEvents="none"），locationX 是相对容器的坐标
    this.origin = { x: n.pageX - n.locationX, y: n.pageY - n.locationY };
    this.start = { x: n.locationX, y: n.locationY };
    this.startAt = Date.now();
    this.phase = 'pending';
    this.surface = surface;
    this.two = null;
    this.prev = { dx: 0, dy: 0, t: this.startAt };
    this.clearTimer();
    const tablet = this.tabletSurface(surface);
    this.longTimer = setTimeout(() => {
      if (this.phase !== 'pending' || !this.frame || !this.viewW) return;
      this.phase = 'long';
      if (tablet) {
        const p = this.screenAt(this.start);
        if (p) this.send({ action: 'right_click', ...p });
      } else {
        this.send({ action: 'right_click' });
      }
    }, LONG_PRESS_MS);
  }

  private move(surface: Surface, e: GestureResponderEvent, g: PanResponderGestureState): void {
    if (this.phase === 'idle' || this.phase === 'long') return;
    const pts = this.touchPoints(e);
    if (pts.length >= 2) {
      // 第二个手指按下：拖动中就不管它，否则进入双指手势
      if (this.phase === 'pending') this.beginTwo(pts);
      if (this.phase === 'two') this.moveTwo(surface, pts);
      return;
    }
    // 双指手势里先抬起了一个手指：剩下那个手指的移动不再处理，全部抬起时再看是不是双指轻点
    if (this.phase === 'two') return;
    if (this.phase === 'pending') {
      if (Math.hypot(g.dx, g.dy) <= TAP_SLOP) return;
      this.clearTimer();
      this.phase = 'drag';
      if (this.tabletSurface(surface)) {
        // 平板模式：在按下的位置按住左键，之后跟着手指移动
        const p = this.screenAt(this.start);
        if (!p) return;
        this.send({ action: 'down', ...p });
        this.lastSend = 0;
      }
    }
    if (this.phase !== 'drag') return;
    if (this.tabletSurface(surface)) this.tabletDrag(g);
    else this.trackpadMove(g);
  }

  private tabletDrag(g: PanResponderGestureState): void {
    const p = this.screenAt({ x: this.start.x + g.dx, y: this.start.y + g.dy });
    if (!p) return;
    this.showCursor(p);
    this.sendMove(p);
  }

  private trackpadMove(g: PanResponderGestureState): void {
    const f = this.frame;
    if (!f || !this.viewW) return;
    const now = Date.now();
    const step = { dx: g.dx - this.prev.dx, dy: g.dy - this.prev.dy };
    const dt = Math.max(1, now - this.prev.t);
    this.prev = { dx: g.dx, dy: g.dy, t: now };
    // 基础比例：手指移动 1dp ≈ 画面上 1dp 对应的屏幕距离（画面放大时按放大后的比例）；快速滑动时加速（最多 3 倍）
    const base = f.width / this.viewW / f.scale / this.zoom.s;
    const speed = Math.hypot(step.dx, step.dy) / dt; // dp/ms
    const k = base * (1 + Math.min(2, speed * 1.5));
    const p = this.clampScreen(this.cursor.x + step.dx * k, this.cursor.y + step.dy * k);
    this.showCursor(p);
    this.sendMove(p);
  }

  private beginTwo(pts: Point[]): void {
    this.clearTimer();
    const [a, b] = pts;
    this.phase = 'two';
    this.two = {
      kind: 'undecided',
      at: Date.now(),
      m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom0: this.zoom,
      scrolled: 0,
      maxMove: 0,
    };
  }

  private moveTwo(surface: Surface, pts: Point[]): void {
    const t = this.two;
    if (!t) return;
    const [a, b] = pts;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const dy = m.y - t.m0.y;
    t.maxMove = Math.max(t.maxMove, Math.hypot(m.x - t.m0.x, dy), Math.abs(d - t.d0));
    if (t.kind === 'undecided') {
      // 捏合只在画面上可用（下方触控板没有画面可缩放）
      if (surface === 'screen' && Math.abs(d / t.d0 - 1) > PINCH_RATIO) t.kind = 'pinch';
      else if (Math.abs(dy) > SCROLL_START) t.kind = 'scroll';
      else return;
    }
    if (t.kind === 'pinch') {
      this.zoom = pinchZoom(t.zoom0, t.m0, t.d0, m, d, this.viewW, this.viewH);
      this.emit();
      return;
    }
    // 滚动：手指往下滑，内容往下走（滚轮向上，dy 为正），和手机上滑动列表的方向一致
    const steps = Math.trunc(dy / SCROLL_STEP) - t.scrolled;
    if (steps === 0) return;
    t.scrolled += steps;
    if (this.tabletSurface(surface)) {
      const p = this.screenAt(t.m0);
      this.send(p ? { action: 'scroll', dy: steps, ...p } : { action: 'scroll', dy: steps });
    } else {
      this.send({ action: 'scroll', dy: steps });
    }
  }

  /** 双指手势结束（手指全部抬起），移动很少、时间很短的按双指轻点处理 */
  private finishTwo(surface: Surface): void {
    const t = this.two;
    this.two = null;
    if (!t) return;
    if (t.kind !== 'undecided' || t.maxMove > TAP_SLOP * 2 || Date.now() - t.at > TWO_TAP_MS) return;
    // 双指轻点 → 右键：平板模式点在两指中间，触控板点在当前鼠标位置
    if (this.tabletSurface(surface)) {
      const p = this.screenAt(t.m0);
      if (p) this.send({ action: 'right_click', ...p });
    } else {
      this.send({ action: 'right_click' });
    }
  }

  private end(surface: Surface, _e: GestureResponderEvent, g: PanResponderGestureState): void {
    this.clearTimer();
    const phase = this.phase;
    this.phase = 'idle';
    if (phase === 'two') return this.finishTwo(surface);
    if (phase === 'long' || phase === 'idle' || !this.frame || !this.viewW) return;
    const tablet = this.tabletSurface(surface);
    if (phase === 'drag') {
      if (tablet) {
        const p = this.screenAt({ x: this.start.x + g.dx, y: this.start.y + g.dy });
        if (p) this.send({ action: 'up', ...p });
        else this.send({ action: 'up' });
      } else {
        this.sendMove(this.cursor, true);
      }
      return;
    }
    // 轻点
    if (!tablet) {
      // 触控板轻点：在当前鼠标位置点击（先把最后的位置发过去）
      this.sendMove(this.cursor, true);
      this.send({ action: this.takeRight() ? 'right_click' : 'click' });
      return;
    }
    const p = this.screenAt(this.start);
    if (!p) return;
    const right = this.takeRight();
    const now = Date.now();
    const last = this.lastTap;
    if (!right && last && now - last.at < DOUBLE_TAP_MS && Math.hypot(this.start.x - last.c.x, this.start.y - last.c.y) < DOUBLE_TAP_SLOP) {
      // 第二下：不带坐标、不再移动鼠标，直接在第一下的位置再点一次，系统就会认成双击
      this.lastTap = null;
      this.send({ action: 'click' });
      return;
    }
    this.lastTap = right ? null : { at: now, c: { ...this.start } };
    this.showCursor(p);
    this.send({ action: right ? 'right_click' : 'click', ...p });
  }

  private cancel(): void {
    this.clearTimer();
    // 拖动中被系统打断（来电、切到后台等）：松开左键，免得电脑上一直按着
    if (this.phase === 'drag' && this.tabletSurface(this.surface)) this.send({ action: 'up' });
    this.phase = 'idle';
    this.two = null;
  }
}

