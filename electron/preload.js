// Preload script for Electron (security best practice).
// Expose minimal APIs to renderer if needed (e.g. for native features).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Example: send message to main for heavy tasks
  sendToMain: (channel, data) => ipcRenderer.send(channel, data),
  // Listen from main
  onFromMain: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args)),
  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});

// Note: for perf, you can use this to offload more work to main process (e.g. log analysis).
console.log('[preload] Electron APIs exposed (minimal for now)');