'use strict';
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');
const http = require('http');
const config = require('../config');

const PORT = Number(process.env.SIGNALHEAD_PORT) || config.port();
const URL_BASE = `http://127.0.0.1:${PORT}`;

let win = null;
let saveTimer = null;
let cursorTimer = null;
let clickThroughEnabled = true;

function waitForServer(tries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = http.get(`${URL_BASE}/health`, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (n <= 0) return reject(new Error(`no signalhead server on ${URL_BASE}`));
        setTimeout(() => attempt(n - 1), 250);
      });
      req.setTimeout(1000, () => req.destroy());
    };
    attempt(tries);
  });
}

function defaultPosition(w, h) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - w - 24,
    y: workArea.y + Math.round(workArea.height * 0.12),
  };
}

function createWindow() {
  const cfg = config.load();
  const width = 150;
  const height = 300;
  const saved = cfg.window || {};
  const pos = Number.isFinite(saved.x) && Number.isFinite(saved.y)
    ? { x: saved.x, y: saved.y }
    : defaultPosition(width, height);

  win = new BrowserWindow({
    width,
    height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Float above fullscreen apps and every desktop/space.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  clickThroughEnabled = cfg.clickThrough !== false;
  if (clickThroughEnabled) win.setIgnoreMouseEvents(true, { forward: true });

  win.loadURL(URL_BASE + '/');
  win.once('ready-to-show', () => win.showInactive());

  // Keep the window where the user dragged it.
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      config.save({ window: { x, y } });
    }, 400);
  };
  win.on('moved', remember);
  win.on('closed', () => { clearInterval(cursorTimer); win = null; });

  cursorTimer = setInterval(pollCursor, 80);

  // Anything the page tries to open goes to the real browser, not this window.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// ---------- renderer bridge ----------
ipcMain.handle('config:get', () => config.load());
ipcMain.handle('config:save', (_e, patch) => {
  const next = config.save(patch || {});
  clickThroughEnabled = next.clickThrough !== false;
  return next;
});

// Clicks pass through the window except over the light itself.
//
// Deciding this from forwarded mouse events is unreliable: leave the window fast
// enough and the final event never arrives, so the overlay stays click-swallowing
// over a region the user cannot see. Polling the cursor against the interactive
// rect has no such edge case.
let hotRect = null;      // interactive region, CSS px relative to the page
let cursorInside = null;

ipcMain.on('window:hotrect', (_e, rect) => { hotRect = rect; });

function pollCursor() {
  if (!win || win.isDestroyed()) return;

  if (clickThroughEnabled === false) {
    if (cursorInside !== true) { cursorInside = true; win.setIgnoreMouseEvents(false); }
    return;
  }
  if (!hotRect) return;

  const pt = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const inside =
    pt.x >= b.x + hotRect.x && pt.x <= b.x + hotRect.x + hotRect.w &&
    pt.y >= b.y + hotRect.y && pt.y <= b.y + hotRect.y + hotRect.h;

  if (inside === cursorInside) return;
  cursorInside = inside;
  win.setIgnoreMouseEvents(!inside, { forward: true });
}

ipcMain.on('window:size', (_e, { w, h } = {}) => {
  if (!win || win.isDestroyed() || !w || !h) return;
  const width = Math.max(80, Math.ceil(w));
  const height = Math.max(80, Math.ceil(h));
  const [cw, ch] = win.getSize();
  if (cw === width && ch === height) return;

  // The window grows when agent labels appear, so keep it inside the screen it
  // sits on — otherwise a light parked near an edge drifts off it.
  const [x, y] = win.getPosition();
  const { workArea } = screen.getDisplayNearestPoint({ x, y });
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

  win.setBounds({
    x: clamp(x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  });
});

ipcMain.on('app:quit', () => app.quit());

app.on('window-all-closed', () => app.quit());
if (process.platform === 'darwin' && app.dock) app.dock.hide();

app.whenReady().then(async () => {
  try {
    await waitForServer();
  } catch (err) {
    console.error(err.message);
    console.error('Start it first with:  sig start');
    return app.quit();
  }
  createWindow();
});
