const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    // Add any necessary IPC methods here
    platform: process.platform
});
