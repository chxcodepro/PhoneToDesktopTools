// 被控提示：每个显示器一个全屏、透明、点击穿透、置顶的窗口，画红色边框和顶部悬浮条。
import { BrowserWindow, screen } from 'electron';
import * as path from 'path';

export class OverlayManager {
  private windows: BrowserWindow[] = [];
  private visible = false;

  constructor(
    private rendererDir: string,
    private preloadPath: string,
  ) {
    screen.on('display-added', () => this.rebuild());
    screen.on('display-removed', () => this.rebuild());
    screen.on('display-metrics-changed', () => this.rebuild());
  }

  owns(w: BrowserWindow): boolean {
    return this.windows.includes(w);
  }

  private create(): void {
    const displays = screen.getAllDisplays();
    const primaryId = screen.getPrimaryDisplay().id;
    for (const d of displays) {
      const w = new BrowserWindow({
        ...d.bounds,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        show: false,
        webPreferences: {
          preload: this.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false,
          devTools: false,
        },
      });
      w.setAlwaysOnTop(true, 'screen-saver');
      w.setVisibleOnAllWorkspaces(true);
      w.setIgnoreMouseEvents(true, { forward: true });
      w.setBounds(d.bounds);
      // 只有主显示器显示悬浮条，其他显示器只画红框
      void w.loadFile(path.join(this.rendererDir, 'overlay.html'), {
        query: { bar: d.id === primaryId ? '1' : '0' },
      });
      w.once('ready-to-show', () => {
        if (this.visible) w.showInactive();
      });
      this.windows.push(w);
    }
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    if (this.windows.length === 0) this.create();
    for (const w of this.windows) {
      if (!w.isDestroyed()) {
        w.showInactive();
        w.setAlwaysOnTop(true, 'screen-saver');
      }
    }
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    for (const w of this.windows) if (!w.isDestroyed()) w.hide();
  }

  private rebuild(): void {
    this.destroy();
    if (this.visible) {
      this.create();
    }
  }

  destroy(): void {
    for (const w of this.windows) if (!w.isDestroyed()) w.destroy();
    this.windows = [];
  }
}
