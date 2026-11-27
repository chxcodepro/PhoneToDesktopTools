// 预加载脚本：只暴露页面需要的最小接口（sandbox 模式下只能使用 electron 模块）。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AboutInfo, AppStatus, P2DApi, UpdateInfo } from '../shared/types';

const api: P2DApi = {
  getStatus: () => ipcRenderer.invoke('p2d:getStatus') as Promise<AppStatus>,
  onStatus: (cb) => {
    const listener = (_e: IpcRendererEvent, s: AppStatus) => cb(s);
    ipcRenderer.on('p2d:status', listener);
    return () => ipcRenderer.removeListener('p2d:status', listener);
  },
  disconnect: () => ipcRenderer.invoke('p2d:disconnect') as Promise<void>,
  minimize: () => ipcRenderer.send('p2d:minimize'),
  hide: () => ipcRenderer.send('p2d:hide'),
  fitHeight: (height) => ipcRenderer.send('p2d:fitHeight', Number(height)),
  setOverlayInteractive: (interactive) => ipcRenderer.send('p2d:overlayInteractive', !!interactive),
  startPairing: () => ipcRenderer.invoke('p2d:startPairing') as Promise<void>,
  cancelPairing: () => ipcRenderer.invoke('p2d:cancelPairing') as Promise<void>,
  removePaired: (id) => ipcRenderer.invoke('p2d:removePaired', id) as Promise<void>,
  installDriver: () => ipcRenderer.invoke('p2d:installDriver') as Promise<{ ok: boolean; message?: string }>,
  allowFirewall: () => ipcRenderer.invoke('p2d:allowFirewall') as Promise<{ ok: boolean; message?: string }>,
  setSecureDesktop: (on) => ipcRenderer.invoke('p2d:setSecureDesktop', !!on) as Promise<{ ok: boolean; message?: string }>,
  aoaConnect: (id) => ipcRenderer.invoke('p2d:aoaConnect', id) as Promise<{ ok: boolean; message?: string }>,
  setAutostart: (on) => ipcRenderer.invoke('p2d:setAutostart', !!on) as Promise<void>,
  checkUpdate: () => ipcRenderer.invoke('p2d:checkUpdate') as Promise<UpdateInfo>,
  openUpdate: () => ipcRenderer.send('p2d:openUpdate'),
  about: () => ipcRenderer.invoke('p2d:about') as Promise<AboutInfo>,
  openRepo: () => ipcRenderer.send('p2d:openRepo'),
  exportLogs: () => ipcRenderer.invoke('p2d:exportLogs') as Promise<{ ok: boolean; path?: string; message?: string }>,
  openMacPrivacy: (kind) => ipcRenderer.send('p2d:openMacPrivacy', kind),
};

contextBridge.exposeInMainWorld('p2d', api);
