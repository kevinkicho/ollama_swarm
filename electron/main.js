const path = require('path');

// Defer electron require for testability (when electron not installed in this env)
let app, BrowserWindow, shell;
try {
  ({ app, BrowserWindow, shell } = require('electron'));
} catch (e) {
  // mock for test-stub
  app = { commandLine: { appendSwitch: () => {} }, isPackaged: false };
  BrowserWindow = function() { return { loadURL:()=>{}, loadFile:()=>{}, once:()=>{}, webContents: { openDevTools:()=>{}, setWindowOpenHandler:()=>{}, on:()=>{} }, show:()=>{} }; };
  shell = { openExternal: () => {} };
}

const isDev = !app.isPackaged;

// Recommended performance flags for Electron (helps with memory/CPU for long-running swarms + heavy transcript)
// See user perf discussion: these give Chromium more headroom vs plain Chrome tab.
// Test on your hardware; increase heap for very large transcripts/logs.
// Combine with web perf wins (virtualization, workers, narrow selectors).
const PERFORMANCE_FLAGS = [
  ['js-flags', '--max-old-space-size=8192'], // 8GB JS heap (adjust per machine; 4096 for 4GB)
  ['disable-gpu-sandbox'],
  ['disable-software-rasterizer'], // if GPU issues in some envs
  ['enable-zero-copy'], // better rendering perf for UI
  ['disable-background-timer-throttling'], // keep long autonomous runs responsive
  ['disable-renderer-backgrounding'],
  ['no-sandbox'], // only if needed for some Linux setups (security note)
];

PERFORMANCE_FLAGS.forEach(([flag, value]) => {
  if (value) {
    app.commandLine.appendSwitch(flag, value);
  } else {
    app.commandLine.appendSwitch(flag);
  }
});

// Export for testing (expanded Electron stub test)
module.exports = { PERFORMANCE_FLAGS, createWindow };

// Only run app code if not in test (when electron is real)
if (app.whenReady && typeof app.whenReady === 'function') {
  app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Graceful shutdown hints for long-running swarms
  app.on('before-quit', () => {
    console.log('[electron] App quitting - consider graceful swarm stop if needed');
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // For dev: load from Vite dev server (npm run dev)
      // In prod: load built web/dist/index.html (after npm run build in web)
      // Enable if you need more native perf access (via preload IPC)
    },
    show: false,
  });

  if (isDev) {
    // Assume web dev server on 8244 (from project scripts)
    win.loadURL('http://localhost:8244');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../web/dist/index.html'));
  }

  win.once('ready-to-show', () => win.show());

  // Open external links in default browser (security + UX)
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Optional: prevent navigation away from app
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost:8244') && !url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

if (app.whenReady && typeof app.whenReady === 'function') {
  app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Graceful shutdown hints for long-running swarms
  app.on('before-quit', () => {
    console.log('[electron] App quitting - consider graceful swarm stop if needed');
  });
}
