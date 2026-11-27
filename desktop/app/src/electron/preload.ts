// 预加载脚本：只暴露页面需要的最小接口（sandbox 模式下只能使用 electron 模块）。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AboutInfo, AgentBridge, AgentEvent, HotkeyStatus, AgentToolsInfo, AppStatus, DownloadedFile, HttpEvent, P2DApi, UpdateInfo, WindowMode } from '../shared/types';

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
  agentHotkeys: () => ipcRenderer.invoke('p2d:agentHotkeys') as Promise<HotkeyStatus>,
  setAgentHotkeys: (s) => ipcRenderer.invoke('p2d:setAgentHotkeys', s) as Promise<HotkeyStatus>,
  agentActive: (running, operating) => ipcRenderer.send('p2d:agentActive', !!running, !!operating),
  stopAgent: () => ipcRenderer.send('p2d:stopAgent'),
  captureRegion: () => ipcRenderer.send('p2d:captureRegion'),
  onAgentEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: AgentEvent) => cb(ev);
    ipcRenderer.on('p2d:agentEvent', listener);
    return () => ipcRenderer.removeListener('p2d:agentEvent', listener);
  },
  onCaptureImage: (cb) => {
    const listener = (_e: IpcRendererEvent, url: string) => cb(url);
    ipcRenderer.on('p2d:captureImage', listener);
    return () => ipcRenderer.removeListener('p2d:captureImage', listener);
  },
  captureDone: (dataUrl) => ipcRenderer.send('p2d:captureDone', dataUrl),
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
    storeLoad: (name) => ipcRenderer.invoke('p2d:storeLoad', name),
    storeSave: (name, v) => ipcRenderer.invoke('p2d:storeSave', name, v) as Promise<void>,
    secretGet: (key) => ipcRenderer.invoke('p2d:secretGet', key) as Promise<string>,
    secretSet: (key, value) => ipcRenderer.invoke('p2d:secretSet', key, value) as Promise<void>,
    skillWrite: (id, files) => ipcRenderer.invoke('p2d:skillWrite', id, files) as Promise<string>,
    skillRead: (id, p) => ipcRenderer.invoke('p2d:skillRead', id, p) as Promise<Uint8Array>,
    skillRemove: (id) => ipcRenderer.invoke('p2d:skillRemove', id) as Promise<void>,
    skillDir: (id) => ipcRenderer.invoke('p2d:skillDir', id) as Promise<string>,
    mcp: (op, payload, id) => ipcRenderer.invoke('p2d:agentMcp', op, payload, id),
    clipboardRead: () => ipcRenderer.invoke('p2d:clipboardRead') as Promise<{ text: string; image?: string }>,
    clipboardWrite: (text) => ipcRenderer.invoke('p2d:clipboardWrite', text) as Promise<void>,
  };
}

contextBridge.exposeInMainWorld('p2d', api);
