const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    platform: process.platform,
    nativeVlc: {
        isAvailable: () => ipcRenderer.invoke('native-vlc:is-available'),
        playFile: (filePath, startTime = 0) => ipcRenderer.invoke('native-vlc:play-file', { filePath, startTime }),
        playBuffer: (bytes, fileName = 'movie.mp4', startTime = 0) => ipcRenderer.invoke('native-vlc:play-buffer', {
            bytes,
            fileName,
            startTime,
        }),
        command: (name, options = undefined) => ipcRenderer.invoke('native-vlc:command', { name, options }),
        info: () => ipcRenderer.invoke('native-vlc:info'),
        processFile: (inputPath, forceVideoTranscode = false) =>
            ipcRenderer.invoke('native-vlc:process-file', { inputPath, forceVideoTranscode }),
        readFile: (filePath) => ipcRenderer.invoke('native-vlc:read-file', { filePath }),
        saveTempFile: (bytes, fileName) => ipcRenderer.invoke('native-vlc:save-temp-file', { bytes, fileName }),
    },
});
