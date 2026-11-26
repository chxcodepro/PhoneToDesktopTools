// 「关于」页面的信息和导出日志：把电脑端服务的运行日志（core.log）和当前状态存成一个文本文件，方便用户发给开发者。
import { app, BrowserWindow, dialog, shell } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { coreLogPath, corePath } from './core';
import { repoUrl } from './update';
import type { AboutInfo, AppStatus } from '../shared/types';

export function aboutInfo(): AboutInfo {
  return {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    electron: process.versions.electron,
    repoUrl: repoUrl(),
  };
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 日志文件内容：版本和系统、当前状态、Core 运行日志（最多最后 2 MB） */
export function buildLogText(status: AppStatus): string {
  const a = aboutInfo();
  const lines = [
    `P2D 电脑端日志（导出时间 ${new Date().toLocaleString()}）`,
    `版本：${a.version}　系统：${a.platform} ${a.osRelease}（${a.arch}）　Electron：${a.electron}`,
    `服务程序：${corePath()}${fs.existsSync(corePath()) ? '' : '（不存在）'}`,
    '',
    '===== 当前状态 =====',
    // 配对二维码、令牌、配对码不写进日志（日志会发给别人）
    JSON.stringify(status, (k, v: unknown) => (/token|secret|^qr$|^code$/i.test(k) && v ? '<已隐藏>' : v), 2),
    '',
    `===== 服务运行日志（${coreLogPath()}）=====`,
  ];
  let log = '';
  try {
    const buf = fs.readFileSync(coreLogPath());
    const max = 2 * 1024 * 1024;
    log = buf.length > max ? `…（前面省略 ${buf.length - max} 字节）…\n${buf.subarray(buf.length - max).toString('utf8')}` : buf.toString('utf8');
  } catch (e) {
    log = `（读取失败：${e instanceof Error ? e.message : String(e)}）`;
  }
  return `${lines.join('\n')}\n${log}`;
}

/** 让用户选保存位置（默认桌面），写入后在文件夹中显示。用户取消时返回 ok=false 且没有 message */
export async function exportLogs(win: BrowserWindow | null, status: AppStatus): Promise<{ ok: boolean; path?: string; message?: string }> {
  const defaultPath = path.join(app.getPath('desktop'), `P2D-电脑端日志-${stamp()}.txt`);
  const opts = { title: '导出日志', defaultPath, filters: [{ name: '文本文件', extensions: ['txt'] }] };
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return { ok: false };
  try {
    // 加 BOM：Win7 记事本才能认出 UTF-8
    fs.writeFileSync(r.filePath, `﻿${buildLogText(status)}`, 'utf8');
    shell.showItemInFolder(r.filePath);
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, message: `保存失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
