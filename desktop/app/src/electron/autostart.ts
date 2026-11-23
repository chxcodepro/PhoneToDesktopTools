// 开机自动启动（带 --hidden：开机后只在托盘，不弹主窗口）。
// - Windows：注册表 HKCU\...\Run（用 reg.exe 写，路径带引号）。便携版每次运行都解压到临时目录，
//   所以要登记便携版 exe 本身的位置（electron-builder 提供的 PORTABLE_EXECUTABLE_FILE）。
// - Linux（麒麟）：~/.config/autostart/phonetodesktop.desktop（XDG 自动启动，UKUI 支持）。
// 用户的选择存在 userData/settings.json；第一次运行默认开启（被控电脑开机就该能连）。
// 每次启动都按选择重新登记一次：便携版 exe 换了位置、deb 升级后路径都能跟上。
import { execFileSync } from 'child_process';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface AutostartState {
  supported: boolean;
  enabled: boolean;
}

const HIDDEN_ARG = '--hidden';

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings(): { autostart?: boolean } {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as { autostart?: boolean };
  } catch {
    return {};
  }
}

function writeSettings(s: { autostart?: boolean }): void {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

/** 开机要启动的程序：Windows 便携版是 exe 本身，AppImage 是 .AppImage 文件，deb 是 /opt/PhoneToDesktop/p2d-desktop */
function launcher(): string {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE || process.execPath;
}

function linuxEntry(): string {
  return path.join(app.getPath('appData'), 'autostart', 'phonetodesktop.desktop');
}

// Windows 用 reg.exe 直接写 Run 项：Electron 的 setLoginItemSettings 写的路径不带引号，
// exe 放在带空格的目录里时开机能否启动要靠系统猜路径，不可靠
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'PhoneToDesktop';

function reg(args: string[]): void {
  execFileSync('reg', args, { windowsHide: true, stdio: 'ignore' });
}

function apply(on: boolean): void {
  if (process.platform === 'win32') {
    if (on) reg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${launcher()}" ${HIDDEN_ARG}`, '/f']);
    else {
      try {
        reg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
      } catch {
        /* 本来就没有 */
      }
    }
    return;
  }
  const file = linuxEntry();
  if (!on) {
    fs.rmSync(file, { force: true });
    return;
  }
  // Exec 里的路径加引号（AppImage 可能放在带空格的目录里）
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=PhoneToDesktop',
    'Comment=用手机控制这台电脑',
    `Exec="${launcher()}" ${HIDDEN_ARG}`,
    'Icon=phonetodesktop',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

let state: AutostartState = { supported: false, enabled: false };

/** 启动时调用：按保存的选择（第一次运行默认开启）登记开机启动 */
export function initAutostart(): AutostartState {
  const supported = app.isPackaged && (process.platform === 'win32' || process.platform === 'linux');
  if (!supported) return (state = { supported: false, enabled: false });
  const saved = readSettings();
  const enabled = saved.autostart ?? true;
  try {
    apply(enabled);
    if (saved.autostart === undefined) writeSettings({ ...saved, autostart: enabled });
  } catch (e) {
    console.error('登记开机启动失败：', e);
  }
  return (state = { supported, enabled });
}

export function getAutostart(): AutostartState {
  return state;
}

export function setAutostart(on: boolean): AutostartState {
  if (!state.supported) return state;
  apply(on);
  writeSettings({ ...readSettings(), autostart: on });
  return (state = { ...state, enabled: on });
}
