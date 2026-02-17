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
    streamServer: {
        /** Register a local file for HTTP streaming. Returns { success, url, streamId }. */
        register: (filePath) => ipcRenderer.invoke('stream-server:register', { filePath }),
        /** Update an existing stream id to point at a newer local file snapshot. */
        update: (streamId, filePath) => ipcRenderer.invoke('stream-server:update', { streamId, filePath }),
        /** Unregister a previously registered stream. */
        unregister: (streamId) => ipcRenderer.invoke('stream-server:unregister', { streamId }),
    },
    jitStream: {
        /** Create a JIT FFmpeg stream session. mode: 'remux' | 'transcode' */
        create: (mode = 'remux') => ipcRenderer.invoke('jit-stream:create', { mode }),
        /** Push an input chunk into the JIT session stdin. */
        push: (streamId, bytes) => ipcRenderer.invoke('jit-stream:push', { streamId, bytes }),
        /** Signal end-of-input for a JIT session. */
        end: (streamId) => ipcRenderer.invoke('jit-stream:end', { streamId }),
        /** Destroy an active JIT session and release resources. */
        destroy: (streamId) => ipcRenderer.invoke('jit-stream:destroy', { streamId }),
    },
});
