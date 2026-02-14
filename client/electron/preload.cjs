const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    platform: process.platform,
    nativeTranscoder: {
        isAvailable: () => ipcRenderer.invoke('native-transcoder:is-available'),
        processFile: (inputPath, forceVideoTranscode = false) =>
            ipcRenderer.invoke('native-transcoder:process-file', { inputPath, forceVideoTranscode }),
        readFile: (filePath) => ipcRenderer.invoke('native-transcoder:read-file', { filePath }),
        saveTempFile: (bytes, fileName) => ipcRenderer.invoke('native-transcoder:save-temp-file', { bytes, fileName }),
    },
});
