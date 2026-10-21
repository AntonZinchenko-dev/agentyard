// Мостик между окном и Electron: только две безопасные функции, без доступа к Node.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ayDesktop', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  savePdf: (url, name) => ipcRenderer.invoke('save-pdf', url, name),
});
