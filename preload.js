const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  fetchUrl: (url) => ipcRenderer.invoke('fetch-url', url),
});
