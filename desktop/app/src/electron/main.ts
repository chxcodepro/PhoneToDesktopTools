// P2D 电脑端主进程：启动 Core、轮询状态、主窗口、托盘、被控红框、断开热键。
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, session, shell, systemPreferences, Tray } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { allowFirewall, aoaConnect, cancelPairing, CoreProcess, disconnect, fetchStatus, installDriver, removePaired, startPairing } from './core';
import { getAutostart, initAutostart, setAutostart } from './autostart';
import { checkUpdate, getUpdate, repoUrl, startAutoCheck } from './update';
import { aboutInfo, exportLogs } from './logs';
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

// Win7 / Win8（系统版本号 6.x）上用 GPU 绘制全屏透明的被控红框窗口，会让主进程卡死（Win7 虚拟机稳定复现），
// 这些系统改用软件绘制。界面很简单，不需要 GPU。
if (process.platform === 'win32' && Number(os.release().split('.')[0]) < 10) {
  app.disableHardwareAcceleration();
}

// 数据目录：改名前叫 PhoneToDesktop（%APPDATA%\PhoneToDesktop、~/.config/PhoneToDesktop），现在是 p2d。
// 第一次运行新版时把旧目录搬过来（设置、运行日志，以及 Core 的配对记录都在里面）；要在单实例锁之前做（锁文件也在这个目录里）
migrateUserData();

function migrateUserData(): void {
  const appData = app.getPath('appData');
  const oldDir = path.join(appData, 'PhoneToDesktop');
  const newDir = path.join(appData, 'p2d');
  // 程序显示名改成了大写的 P2D，Electron 默认按显示名取数据目录（Linux 区分大小写），这里固定用小写的 p2d，和 Core 一致
  app.setPath('userData', newDir);
  if (!fs.existsSync(oldDir)) return;
  try {
    if (fs.existsSync(newDir) && fs.readdirSync(newDir).length === 0) fs.rmdirSync(newDir);
    if (!fs.existsSync(newDir)) {
      fs.renameSync(oldDir, newDir);
      return;
    }
    // 新目录里已经有东西（比如先启动过新版）：把旧目录里新目录没有的文件复制过去，旧目录改名留作备份
    fs.cpSync(oldDir, newDir, { recursive: true, force: false, errorOnExist: false });
    fs.renameSync(oldDir, `${oldDir}.old`);
  } catch (e) {
    // 文件被占用等：这次先继续用旧目录，下次启动再搬
    console.error('搬迁数据目录失败：', e);
    app.setPath('userData', oldDir);
  }
}

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
    title: 'P2D',
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
    if (!startHidden()) mainWindow?.show();
  });
  // 关闭按钮只隐藏到托盘
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
}

/** 开机自启时只在托盘：Windows / Linux 带 --hidden 参数，Mac 由登录项打开 */
function startHidden(): boolean {
  if (process.argv.includes('--hidden')) return true;
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
}

/** 托盘图标：Mac 菜单栏用 16 点的小图（带 @2x） */
function trayIcon(name: string): string {
  return iconPath(process.platform === 'darwin' ? `mac-${name}` : name);
}

/** Mac：键鼠控制要「辅助功能」权限，截图要「屏幕录制」权限（记在 P2D 名下，Core 是它启动的子进程） */
function macPermissions(): AppStatus['macPermissions'] {
  if (process.platform !== 'darwin') return undefined;
  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
  };
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
  if (!s.coreOnline) return { icon: 'tray-idle.png', tip: 'P2D：服务未启动' };
  if (s.controllerName) return { icon: 'tray-controlled.png', tip: `P2D：${s.controllerName} 正在控制此电脑` };
  const busy = s.status?.devices?.some((d) => ['installing', 'starting', 'ready', 'unauthorized'].includes(d.stage));
  if (busy) return { icon: 'tray-connecting.png', tip: 'P2D：正在连接手机' };
  return { icon: 'tray-idle.png', tip: 'P2D：等待手机连接' };
}

// 状态每秒轮询一次，只在图标、提示文字真的变化时才更新托盘：
// Linux（麒麟 UKUI）上每次更新都会让任务栏重建托盘项，已弹出的右键菜单会闪一下就消失
let lastTrayIcon = '';
let lastTrayTip = '';
function updateTray(s: AppStatus): void {
  if (!tray) return;
  const { icon, tip } = trayState(s);
  if (icon !== lastTrayIcon) {
    tray.setImage(nativeImage.createFromPath(trayIcon(icon)));
    lastTrayIcon = icon;
  }
  if (tip !== lastTrayTip) {
    tray.setToolTip(tip);
    lastTrayTip = tip;
  }
}

function trayMenu(): Menu {
  const auto = getAutostart();
  return Menu.buildFromTemplate([
    { label: '显示窗口', click: () => showMainWindow() },
    { label: '断开连接', click: () => void doDisconnect() },
    ...(auto.supported
      ? [{ label: '开机自动启动', type: 'checkbox' as const, checked: auto.enabled, click: () => toggleAutostart(!getAutostart().enabled) }]
      : []),
    { label: '检查更新', click: () => void checkUpdate().then(showMainWindow) },
    // 窗口打不开、服务起不来时也能从托盘导出日志
    { label: '导出日志…', click: () => void exportLogs(null, current) },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function toggleAutostart(on: boolean): void {
  try {
    setAutostart(on);
  } catch (e) {
    console.error('设置开机启动失败：', e);
  }
  tray?.setContextMenu(trayMenu()); // 菜单只在开关变化时重建（每秒重建会让麒麟上的菜单闪退）
  void poll();
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(trayIcon('tray-idle.png')));
  tray.setToolTip('P2D');
  tray.setContextMenu(trayMenu());
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
    core.markOnline();
    const sess = status.sessions?.[0];
    next = {
      coreOnline: true,
      status,
      controllerName: sess ? deviceNameFor(status, sess.serial) : undefined,
      hotkey,
      autostart: getAutostart(),
      update: getUpdate(),
      macPermissions: macPermissions(),
    };
  } catch {
    next = {
      coreOnline: false,
      coreError: core.offlineReason() || undefined,
      hotkey,
      autostart: getAutostart(),
      update: getUpdate(),
      macPermissions: macPermissions(),
    };
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
  // 配对操作完成后立即刷新一次状态，界面不用等下一轮轮询
  ipcMain.handle('p2d:startPairing', () => startPairing().then(poll));
  ipcMain.handle('p2d:cancelPairing', () => cancelPairing().then(poll));
  ipcMain.handle('p2d:removePaired', (_e, id: unknown) => (typeof id === 'string' ? removePaired(id).then(poll) : undefined));
  // 需要管理员权限的修复操作：失败时把原因交给界面显示，完成后立即刷新状态
  const fix = (run: () => Promise<{ ok: boolean; message?: string }>) =>
    run()
      .catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }))
      .finally(() => void poll());
  ipcMain.handle('p2d:installDriver', () => fix(installDriver));
  ipcMain.handle('p2d:allowFirewall', () => fix(allowFirewall));
  ipcMain.handle('p2d:aoaConnect', (_e, id: unknown) =>
    typeof id === 'string' ? fix(() => aoaConnect(id)) : { ok: false, message: '参数不对' },
  );
  ipcMain.handle('p2d:setAutostart', (_e, on: unknown) => toggleAutostart(on === true));
  ipcMain.handle('p2d:checkUpdate', () => checkUpdate());
  // 只打开检查结果里的地址，不接受页面传来的地址
  ipcMain.on('p2d:openUpdate', () => {
    const u = getUpdate();
    const url = u.url || u.page;
    if (url?.startsWith('https://')) void shell.openExternal(url);
  });
  ipcMain.handle('p2d:about', () => aboutInfo());
  ipcMain.on('p2d:openRepo', () => void shell.openExternal(repoUrl()));
  ipcMain.handle('p2d:exportLogs', () => exportLogs(mainWindow, current));
  ipcMain.on('p2d:openMacPrivacy', (_e, kind: unknown) => {
    if (process.platform !== 'darwin') return;
    if (kind === 'accessibility') {
      // 弹出系统提示，并把 P2D 加进「辅助功能」列表（用户只需打开开关）
      systemPreferences.isTrustedAccessibilityClient(true);
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    } else if (kind === 'screen') {
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    }
  });
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
  initAutostart();
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
  startAutoCheck(() => broadcast({ ...current, update: getUpdate() }));
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

// Mac：点程序坞里的图标时打开主窗口
app.on('activate', () => showMainWindow());

// 所有窗口关闭时不退出（常驻托盘）
app.on('window-all-closed', () => {
  /* 保持运行 */
});
