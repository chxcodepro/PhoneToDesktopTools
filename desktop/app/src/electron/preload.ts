// 预加载脚本：只暴露页面需要的最小接口（sandbox 模式下只能使用 electron 模块）。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppStatus, P2DApi } from '../shared/types';

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
  setOverlayInteractive: (interactive) => ipcRenderer.send('p2d:overlayInteractive', !!interactive),
  startPairing: () => ipcRenderer.invoke('p2d:startPairing') as Promise<void>,
  cancelPairing: () => ipcRenderer.invoke('p2d:cancelPairing') as Promise<void>,
  removePaired: (id) => ipcRenderer.invoke('p2d:removePaired', id) as Promise<void>,
  installDriver: () => ipcRenderer.invoke('p2d:installDriver') as Promise<{ ok: boolean; message?: string }>,
  allowFirewall: () => ipcRenderer.invoke('p2d:allowFirewall') as Promise<{ ok: boolean; message?: string }>,
  setAutostart: (on) => ipcRenderer.invoke('p2d:setAutostart', !!on) as Promise<void>,
};

contextBridge.exposeInMainWorld('p2d', api);
