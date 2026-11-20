// PhoneToDesktop 电脑端主进程：启动 Core、轮询状态、主窗口、托盘、被控红框、断开热键。
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { CoreProcess, disconnect, fetchStatus } from './core';
import { OverlayManager } from './overlay';
import { deviceNameFor, type AppStatus } from '../shared/types';

// 断开热键：依次尝试，使用第一个没有被其他程序占用的
const HOTKEY_CANDIDATES = ['Control+Alt+Q', 'Control+Alt+Shift+Q', 'Control+Shift+F12'];
let hotkey: string[] | undefined;
const rendererDir = path.join(__dirname, '..', '..', 'dist');
const preloadPath = path.join(__dirname, 'preload.js');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let current: AppStatus = { coreOnline: false };
const core = new CoreProcess();
let overlays: OverlayManager | null = null; // screen 模块需在 ready 之后使用

// 只允许运行一个实例
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

function iconPath(name: string): string {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'icons') : path.join(__dirname, '..', '..', 'build', 'icons');
  return path.join(base, name);
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 340,
    height: 440,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    title: 'PhoneToDesktop',
    backgroundColor: '#ffffff',
    icon: iconPath('app.png'),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.setMenu(null);
  void mainWindow.loadFile(path.join(rendererDir, 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) mainWindow?.show();
  });
  // 关闭按钮只隐藏到托盘
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
}

function showMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function doDisconnect(): Promise<void> {
  try {
    await disconnect();
  } catch (e) {
    console.error('断开失败：', e);
  }
  await poll();
}

function trayState(s: AppStatus): { icon: string; tip: string } {
  if (!s.coreOnline) return { icon: 'tray-idle.png', tip: 'PhoneToDesktop：服务未启动' };
  if (s.controllerName) return { icon: 'tray-controlled.png', tip: `PhoneToDesktop：${s.controllerName} 正在控制此电脑` };
  const busy = s.status?.devices?.some((d) => ['installing', 'starting', 'ready', 'unauthorized'].includes(d.stage));
  if (busy) return { icon: 'tray-connecting.png', tip: 'PhoneToDesktop：正在连接手机' };
  return { icon: 'tray-idle.png', tip: 'PhoneToDesktop：等待手机连接' };
}

let lastTrayIcon = '';
function updateTray(s: AppStatus): void {
  if (!tray) return;
  const { icon, tip } = trayState(s);
  if (icon !== lastTrayIcon) {
    tray.setImage(nativeImage.createFromPath(iconPath(icon)));
    lastTrayIcon = icon;
  }
  tray.setToolTip(tip);
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(iconPath('tray-idle.png')));
  tray.setToolTip('PhoneToDesktop');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示窗口', click: () => showMainWindow() },
      { label: '断开连接', click: () => void doDisconnect() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => showMainWindow());
}

function broadcast(s: AppStatus): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('p2d:status', s);
  }
}

async function poll(): Promise<void> {
  let next: AppStatus;
  try {
    const status = await fetchStatus();
    const sess = status.sessions?.[0];
    next = {
      coreOnline: true,
      status,
      controllerName: sess ? deviceNameFor(status, sess.serial) : undefined,
      hotkey,
    };
  } catch {
    next = { coreOnline: false, coreError: core.lastError || undefined, hotkey };
    core.ensureRunning();
  }
  current = next;
  if (next.controllerName) overlays?.show();
  else overlays?.hide();
  updateTray(next);
  broadcast(next);
}

function registerIpc(): void {
  ipcMain.handle('p2d:getStatus', () => current);
  ipcMain.handle('p2d:disconnect', () => doDisconnect());
  ipcMain.on('p2d:minimize', () => mainWindow?.minimize());
  ipcMain.on('p2d:hide', () => mainWindow?.hide());
  ipcMain.on('p2d:overlayInteractive', (e, interactive: unknown) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && overlays?.owns(w)) w.setIgnoreMouseEvents(!interactive, { forward: true });
  });
}

// 安全：禁止打开新窗口、禁止跳转到本地页面以外的地址、拒绝所有权限请求
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  registerIpc();
  overlays = new OverlayManager(rendererDir, preloadPath);
  core.start();
  createMainWindow();
  createTray();
  for (const accel of HOTKEY_CANDIDATES) {
    if (globalShortcut.register(accel, () => void doDisconnect())) {
      hotkey = accel.split('+').map((k) => (k === 'Control' ? 'Ctrl' : k));
      break;
    }
    console.error(`热键 ${accel} 注册失败（可能已被其他程序占用），尝试下一个`);
  }
  void poll();
  setInterval(() => void poll(), 1000);
  startDebugCapture();
});

// 开发调试：设置 P2D_DEBUG_CAPTURE=<目录> 时，每 2 秒把主窗口画面写入 <目录>/main.png（打包后无效）
function startDebugCapture(): void {
  const dir = process.env.P2D_DEBUG_CAPTURE;
  if (!dir || app.isPackaged) return;
  setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
    void mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(dir, 'main.png'), img.toPNG());
    });
  }, 2000);
}

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', (e) => {
  globalShortcut.unregisterAll();
  overlays?.destroy();
  if (!core.stopped) {
    e.preventDefault();
    void core.stop().finally(() => app.quit());
  }
});

// 所有窗口关闭时不退出（常驻托盘）
app.on('window-all-closed', () => {
  /* 保持运行 */
});
