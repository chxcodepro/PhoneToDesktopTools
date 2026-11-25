// 开机自动启动（带 --hidden：开机后只在托盘，不弹主窗口）。
// - Windows：注册表 HKCU\...\Run（用 reg.exe 写，路径带引号），登记安装目录里的 p2d.exe（改名前的版本是 PhoneToDesktop.exe）。
//   旧的便携版每次运行都解压到临时目录，要登记 exe 本身的位置（PORTABLE_EXECUTABLE_FILE），换成安装版后启动一次就会改过来。
// - Linux（麒麟）：~/.config/autostart/p2d.desktop（XDG 自动启动，UKUI 支持）。
// 改名前用的是 Run 项「PhoneToDesktop」和 phonetodesktop.desktop，登记时顺手删掉，免得开机启动两次或指向已删除的程序。
// 用户的选择存在 userData/settings.json；第一次运行默认开启（被控电脑开机就该能连）。
// 每次启动都按选择重新登记一次：从便携版换成安装版、安装位置变了、deb 升级后路径都能跟上。
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

/** 开机要启动的程序：Windows 是安装目录里的 exe（旧便携版是 exe 本身），AppImage 是 .AppImage 文件，deb 是 /opt/p2d/p2d-desktop */
function launcher(): string {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE || process.execPath;
}

function linuxEntry(name = 'p2d'): string {
  return path.join(app.getPath('appData'), 'autostart', `${name}.desktop`);
}

// Windows 用 reg.exe 直接写 Run 项：Electron 的 setLoginItemSettings 写的路径不带引号，
// exe 放在带空格的目录里时开机能否启动要靠系统猜路径，不可靠
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'p2d';
/** 改名前的 Run 项名 */
const OLD_RUN_VALUE = 'PhoneToDesktop';

function reg(args: string[]): void {
  execFileSync('reg', args, { windowsHide: true, stdio: 'ignore' });
}

function apply(on: boolean): void {
  if (process.platform === 'win32') {
    try {
      reg(['delete', RUN_KEY, '/v', OLD_RUN_VALUE, '/f']);
    } catch {
      /* 没有旧的项 */
    }
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
  fs.rmSync(linuxEntry('phonetodesktop'), { force: true });
  const file = linuxEntry();
  if (!on) {
    fs.rmSync(file, { force: true });
    return;
  }
  // Exec 里的路径加引号（AppImage 可能放在带空格的目录里）
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=p2d',
    'Comment=用手机控制这台电脑',
    `Exec="${launcher()}" ${HIDDEN_ARG}`,
    'Icon=p2d',
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
