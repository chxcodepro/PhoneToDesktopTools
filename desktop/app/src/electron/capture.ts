// 框选屏幕提问：截下鼠标所在的显示器，铺一个全屏窗口显示截图，用户拖出一块区域后返回那块的图片（data URL）。
import { BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron';
import * as path from 'path';

let busy = false;

export async function captureRegion(rendererDir: string, preloadPath: string): Promise<string | null> {
  if (busy) return null;
  busy = true;
  try {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const size = { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
    if (!src || src.thumbnail.isEmpty()) throw new Error('截不到屏幕（Mac 要在「系统设置 → 隐私与安全性 → 屏幕录制」里允许 P2D）');
    const image = src.thumbnail.toDataURL();

    const w = new BrowserWindow({
      ...d.bounds,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#000000',
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, devTools: false },
    });
    w.setMenu(null);
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setBounds(d.bounds);
    return await new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (v: string | null) => {
        if (done) return;
        done = true;
        ipcMain.removeListener('p2d:captureDone', onDone);
        if (!w.isDestroyed()) w.destroy();
        resolve(v);
      };
      const onDone = (e: Electron.IpcMainEvent, v: unknown) => {
        if (e.sender !== w.webContents) return;
        finish(typeof v === 'string' && v.startsWith('data:image/') ? v : null);
      };
      ipcMain.on('p2d:captureDone', onDone);
      w.on('closed', () => finish(null));
      w.on('blur', () => finish(null)); // 切到别的窗口算取消
      w.webContents.once('did-finish-load', () => {
        w.webContents.send('p2d:captureImage', image);
        w.show();
        w.focus();
      });
      void w.loadFile(path.join(rendererDir, 'capture.html'));
    });
  } finally {
    busy = false;
  }
}
