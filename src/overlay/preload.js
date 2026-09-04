'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const config = require('../config');

contextBridge.exposeInMainWorld('aitl', {
  serverUrl: `http://127.0.0.1:${config.port()}`,
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  hotRect: (rect) => ipcRenderer.send('window:hotrect', rect),
  contentSize: (size) => ipcRenderer.send('window:size', size),
  quit: () => ipcRenderer.send('app:quit'),
});
