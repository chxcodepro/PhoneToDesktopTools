// 鼠标操作按顺序发给电脑：电脑端并行执行各个工具调用，按下 / 移动 / 松开如果乱序，拖动就会出错。
// 上一个调用返回后才发下一个；排队中的连续移动只保留最后一个、连续滚动合成一次，网络慢时不会越积越多。

export type MouseArgs = Record<string, unknown>;

export class MouseQueue {
  private queue: MouseArgs[] = [];
  private busy = false;

  constructor(private send: (args: MouseArgs) => Promise<unknown>) {}

  push(args: MouseArgs): void {
    const last = this.queue[this.queue.length - 1];
    if (args.action === 'move' && last?.action === 'move') this.queue[this.queue.length - 1] = args;
    else if (args.action === 'scroll' && last?.action === 'scroll' && last.x === args.x && last.y === args.y) {
      // 同一位置的连续滚动合成一次（滑得快、网络慢时不会越积越多）；来回滑动正好抵消时整个去掉（电脑端不接受 dy=0）
      const dy = Number(last.dy) + Number(args.dy);
      if (dy) this.queue[this.queue.length - 1] = { ...last, dy };
      else this.queue.pop();
    } else this.queue.push(args);
    void this.pump();
  }

  /** 还没发出去的操作数（测试用） */
  get pending(): number {
    return this.queue.length;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let a = this.queue.shift(); a; a = this.queue.shift()) {
        try {
          await this.send(a);
        } catch {
          // 单个操作失败（比如电脑端拒绝）不影响后面的
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
