import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../shared/types';

const api: DesktopApi = {
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    paths: () => ipcRenderer.invoke('app:paths')
  },
  dialogs: {
    chooseFiles: (extensions) => ipcRenderer.invoke('dialogs:choose-files', extensions),
    chooseDirectory: () => ipcRenderer.invoke('dialogs:choose-directory')
  },
  conversion: {
    run: (request) => ipcRenderer.invoke('conversion:run', request)
  },
  files: {
    readText: (path) => ipcRenderer.invoke('files:read-text', path),
    readBinary: (path) => ipcRenderer.invoke('files:read-binary', path),
    save: (request) => ipcRenderer.invoke('files:save', request),
    reveal: (path) => ipcRenderer.invoke('files:reveal', path)
  },
  settings: {
    getAll: () => ipcRenderer.invoke('settings:get-all'),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value)
  },
  history: {
    list: (limit) => ipcRenderer.invoke('history:list', limit),
    clear: () => ipcRenderer.invoke('history:clear')
  },
  secrets: {
    hasDeepSeekKey: () => ipcRenderer.invoke('secrets:has-deepseek'),
    setDeepSeekKey: (value) => ipcRenderer.invoke('secrets:set-deepseek', value),
    clearDeepSeekKey: () => ipcRenderer.invoke('secrets:clear-deepseek')
  },
  ai: {
    generateChords: (request) => ipcRenderer.invoke('ai:generate-chords', request)
  },
  legacy: {
    importProject: (sourceRoot) => ipcRenderer.invoke('legacy:import-project', sourceRoot)
  }
};

contextBridge.exposeInMainWorld('skyforce', Object.freeze(api));
