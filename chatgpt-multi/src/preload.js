'use strict';

// The only bridge between the tab strip page and the main process. The
// ChatGPT pages inside the account tabs get no preload script at all.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatgptMulti', {
  send: (command, ...args) => ipcRenderer.send('ui', command, ...args),
  ready: () => ipcRenderer.send('ui-ready'),
  onState: callback => {
    ipcRenderer.on('state', (_event, state) => callback(state));
  },
  onBeginRename: callback => {
    ipcRenderer.on('begin-rename', (_event, id) => callback(id));
  },
});
