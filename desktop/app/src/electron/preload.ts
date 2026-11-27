// 预加载脚本：只暴露页面需要的最小接口（sandbox 模式下只能使用 electron 模块）。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AboutInfo, AgentBridge, AgentToolsInfo, AppStatus, DownloadedFile, HttpEvent, P2DApi, UpdateInfo, WindowMode } from '../shared/types';

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
  getMode: () => ipcRenderer.invoke('p2d:getMode') as Promise<WindowMode>,
  setMode: (mode) => ipcRenderer.send('p2d:setMode', mode),
  toggleMaximize: () => ipcRenderer.send('p2d:toggleMaximize'),
  agent: agentBridge(),
};

function agentBridge(): AgentBridge {
  return {
    httpStart: (id, url, init) => ipcRenderer.send('p2d:httpStart', id, url, init),
    onHttp: (cb) => {
      const listener = (_e: IpcRendererEvent, id: string, ev: HttpEvent) => cb(id, ev);
      ipcRenderer.on('p2d:http', listener);
      return () => ipcRenderer.removeListener('p2d:http', listener);
    },
    cancel: (id) => ipcRenderer.send('p2d:cancel', id),
    tools: () => ipcRenderer.invoke('p2d:agentTools') as Promise<AgentToolsInfo>,
    call: (id, name, args) => ipcRenderer.invoke('p2d:agentCall', id, name, args),
    download: (id, url, name, dir) => ipcRenderer.invoke('p2d:download', id, url, name, dir) as Promise<DownloadedFile>,
    onDownloadProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, id: string, received: number, total: number) => cb(id, received, total);
      ipcRenderer.on('p2d:downloadProgress', listener);
      return () => ipcRenderer.removeListener('p2d:downloadProgress', listener);
    },
    config: () => ipcRenderer.invoke('p2d:agentConfig'),
    saveConfig: (v) => ipcRenderer.invoke('p2d:agentSaveConfig', v) as Promise<void>,
    key: (preset) => ipcRenderer.invoke('p2d:agentKey', preset) as Promise<string>,
    setKey: (preset, key) => ipcRenderer.invoke('p2d:agentSetKey', preset, key) as Promise<void>,
    convList: () => ipcRenderer.invoke('p2d:convList') as Promise<unknown[]>,
    convLoad: (id) => ipcRenderer.invoke('p2d:convLoad', id),
    convSave: (id, data, list) => ipcRenderer.invoke('p2d:convSave', id, data, list) as Promise<void>,
    convRemove: (id, list) => ipcRenderer.invoke('p2d:convRemove', id, list) as Promise<void>,
  };
}

contextBridge.exposeInMainWorld('p2d', api);
