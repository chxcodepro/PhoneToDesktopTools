// 远程桌面手势控制器：保存手势回调需要的最新状态（画面、视图宽度、鼠标位置），并把手势换算成鼠标操作。
// 放在组件外部的普通对象里，避免在渲染期间读写 ref。

import { PanResponder, type PanResponderInstance } from 'react-native';

import { toScreen } from './geometry';
import type { ScreenFrame } from './useScreenStream';

export type MouseAction = (args: Record<string, unknown>) => void;

export class RemoteController {
  frame: ScreenFrame | null = null;
  viewW = 0;
  rightNext = false;
  private cursor = { x: 0, y: 0 };
  private lastMove = 0;
  private prev = { dx: 0, dy: 0 };
  readonly pan: PanResponderInstance;

  constructor(
    private mouse: MouseAction,
    private onConsumeRight: () => void,
  ) {
    this.pan = PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        this.prev = { dx: 0, dy: 0 };
        this.lastMove = 0;
      },
      onPanResponderMove: (_, g) => this.trackpadMove(g.dx, g.dy),
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) < 4 && Math.abs(g.dy) < 4) {
          this.mouse({ action: this.takeRight() ? 'right_click' : 'click' });
        }
      },
    });
  }

  update(frame: ScreenFrame | null, viewW: number, rightNext: boolean): void {
    this.frame = frame;
    this.viewW = viewW;
    this.rightNext = rightNext;
    if (frame?.cursorX !== undefined && frame.cursorY !== undefined) {
      this.cursor = { x: frame.cursorX, y: frame.cursorY };
    }
  }

  private takeRight(): boolean {
    const r = this.rightNext;
    if (r) {
      this.rightNext = false;
      this.onConsumeRight();
    }
    return r;
  }

  /** 触控模式：点哪里点哪里，长按 = 右键 */
  tap(px: number, py: number, long: boolean): void {
    if (!this.frame || !this.viewW) return;
    const p = toScreen(this.frame, this.viewW, px, py);
    const right = this.takeRight() || long;
    this.mouse({ action: right ? 'right_click' : 'click', ...p });
  }

  /** 触控板模式：按位移相对移动鼠标（限制发送频率） */
  private trackpadMove(dx: number, dy: number): void {
    const f = this.frame;
    if (!f || !this.viewW) return;
    const now = Date.now();
    if (now - this.lastMove < 30) return;
    this.lastMove = now;
    const step = { dx: dx - this.prev.dx, dy: dy - this.prev.dy };
    this.prev = { dx, dy };
    const k = (f.width / this.viewW / f.scale) * 1.6; // 灵敏度
    this.cursor = { x: Math.round(this.cursor.x + step.dx * k), y: Math.round(this.cursor.y + step.dy * k) };
    this.mouse({ action: 'move', ...this.cursor });
  }
}
