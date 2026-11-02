import {
  app, BrowserWindow, shell, ipcMain, session,
  globalShortcut, Menu, MenuItem,
} from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { randomBytes } from 'crypto';
import type { VibeCvConfig } from '@streamdaemon/shared';
import { logger, redirectConsoleToLogger } from './logger.js';
import {
  initVibeCvDetector,
  stopVibeCvDetector,
  getVibeCvConfig,
  setVibeCvConfig,
  getVibeCvStatus,
  captureVibeCvDebug,
} from './vibe-cv/detector.js';
const _require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
if (!isDev && !process.env.NODE_ENV) process.env.NODE_ENV = 'production';

redirectConsoleToLogger();

// ── Remove default menu (File / Edit / View…) ─────────────
Menu.setApplicationMenu(null);

// ── Disable Autoplay restrictions for TTS ─────────────────
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── Load backend credentials BEFORE importing the backend ──
function loadBackendEnv() {
  const envPath = isDev
    ? path.resolve(__dirname, '../../backend/.env')
    : path.join(app.getAppPath(), 'extra', 'backend.env');

  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
    logger.info('Backend .env loaded');
  } catch (err) {
    logger.warn('Could not load backend .env:', err);
  }
}

loadBackendEnv();

const LOCAL_API_TOKEN = randomBytes(32).toString('hex');
process.env.LOCAL_API_TOKEN = LOCAL_API_TOKEN;

const extraPath = isDev
  ? path.resolve(__dirname, '../extra')
  : path.join(app.getAppPath(), 'extra');
const existingPath = process.env.NODE_PATH || '';
process.env.NODE_PATH = existingPath
  ? `${extraPath}${path.delimiter}${existingPath}`
  : extraPath;
_require('module').Module._initPaths();

// ── Database setup ────────────────────────────────────────
const dbPath = isDev
  ? path.resolve(__dirname, '../prisma/streamforger.db')
  : path.join(app.getPath('userData'), 'streamforger.db');

mkdirSync(path.dirname(dbPath), { recursive: true });

process.env.DATABASE_URL = `file:${dbPath}?journal_mode=WAL`;

const dataDir = isDev
  ? path.resolve(__dirname, '../../backend/data')
  : path.join(app.getPath('userData'), 'data');

mkdirSync(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;

// ── Version migration: clear old data on version change ────
const APP_VERSION = app.getVersion();
const versionMarkerPath = path.join(app.getPath('userData'), '.streamforger-version');

function runVersionMigration() {
  const oldVersion = existsSync(versionMarkerPath) ? readFileSync(versionMarkerPath, 'utf8').trim() : '';

  if (oldVersion !== APP_VERSION) {
    logger.info({ oldVersion, newVersion: APP_VERSION }, 'Version migration');

    // Note: We no longer delete the database or configs here.
    // Prisma db push will handle schema changes safely without losing the Twitch session.

    // Write current version marker
    writeFileSync(versionMarkerPath, APP_VERSION, 'utf8');
    logger.info({ version: APP_VERSION }, 'Version marker written');
  } else {
    logger.info({ version: APP_VERSION }, 'Version unchanged, skipping migration');
  }
}

runVersionMigration();

// ── Frontend dist path ────────────────────────────────────
function getFrontendDistDir(): string {
  return isDev
    ? path.resolve(__dirname, '../../frontend/dist')
    : path.join(app.getAppPath(), 'extra', 'frontend', 'dist');
}

function getFrontendPath(...parts: string[]): string {
  return path.join(getFrontendDistDir(), ...parts);
}

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let overlaySettingsWindow: BrowserWindow | null = null;
let overlayIgnoreMouse = true;
let overlayFrameless = true;
let mainAlwaysOnTop = false;
let backendReady = false;

// ── Backend ───────────────────────────────────────────────
async function startBackend(retries = 3, delayMs = 600) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { startServer } = await import('@streamdaemon/backend/dist/index.js');
      await startServer({ port: 3000, frontendDir: getFrontendDistDir() });
      backendReady = true;
      logger.info('Backend started — serving frontend at http://127.0.0.1:3000');
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ attempt, retries, error: message }, 'Backend failed to start');
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }

  logger.error('Backend could not start after multiple attempts');
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL('data:text/html;base64,PGh0bWw+PGJvZHk+PGgxPlN0cmVhbURhZW1vbiBubyBwdWVkZSBpbmljaWFyIGVsIHNlcnZpZG9yPC9oMT48cD5WZXJpZmlxdWUgcXVlIG5vIGhheSBvdHJvcyBwcm9jZXNvcyB1c2FuZG8gZWwgcHVlcnRvIDMwMDAgeSByZWluaWNpYSBsYSBhcHBsaWNhY2lvbi48L3A+PC9ib2R5PjwvaHRtbD4=');
  }
}

// ── Vibe Daemon hotkeys ───────────────────────────────────
const BACKEND_ORIGIN = isDev ? 'http://localhost:3000' : 'http://127.0.0.1:3000';
let vibeHotkeySignature = '';
const vibeHotkeyAccelerators: string[] = [];

interface VibeDaemonDesktopConfig {
  enabled: boolean;
  hotkeys?: { kill?: string; death?: string; victory?: string };
}

async function setupVibeDaemonHotkeys() {
  if (!backendReady) return;
  try {
    const headers = { 'x-local-token': LOCAL_API_TOKEN };
    const statusRes = await fetch(`${BACKEND_ORIGIN}/auth/status`, { headers });
    if (!statusRes.ok) return;
    const status = (await statusRes.json()) as { authenticated: boolean; user?: { login?: string } };
    if (!status.authenticated || !status.user?.login) return;

    const configRes = await fetch(`${BACKEND_ORIGIN}/vibe-daemon/config`, { headers });
    if (!configRes.ok) return;
    const cfg = (await configRes.json()) as VibeDaemonDesktopConfig;
    if (!cfg.enabled) return;

    const channel = status.user.login;
    const entries = Object.entries(cfg.hotkeys ?? {}) as Array<[string, string]>;
    const signature = `${channel}|${entries.map(([k, v]) => `${k}=${v}`).join(',')}`;
    if (signature === vibeHotkeySignature) return;

    for (const accelerator of vibeHotkeyAccelerators.splice(0)) {
      globalShortcut.unregister(accelerator);
    }
    vibeHotkeySignature = signature;

    for (const [eventType, accelerator] of entries) {
      if (!accelerator) continue;
      const registered = globalShortcut.register(accelerator, () => {
        fetch(`${BACKEND_ORIGIN}/vibe-daemon/event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-local-token': LOCAL_API_TOKEN },
          body: JSON.stringify({ channel, gameId: 'global', eventType, timestamp: Date.now() }),
        }).catch(() => {});
      });
      if (registered) vibeHotkeyAccelerators.push(accelerator);
    }
    logger.info({ count: vibeHotkeyAccelerators.length }, 'Vibe Daemon hotkeys registered');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ error: message }, 'Vibe Daemon hotkey setup failed');
  }
}

// ── Main window ───────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    // Allow snapping to half of a 1080px-wide vertical monitor (~540px)
    // while still leaving enough room for the mobile/responsive layout.
    minWidth: 540,
    minHeight: 480,
    show: true,
    frame: false,
    backgroundColor: '#06050d',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    shell.openExternal(openUrl);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173'];
    if (!allowed.some((prefix) => url.startsWith(prefix))) {
      event.preventDefault();
    }
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools();
    }
  });
}

function loadMainAppUrl(attempts = 8): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const mainUrl = isDev ? 'http://localhost:5173' : 'http://localhost:3000';
  mainWindow.loadURL(mainUrl).catch(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.loadURL('http://127.0.0.1:3000').catch(() => {
      if (attempts <= 1) {
        console.warn('⚠️  loadURL failed, falling back to loadFile');
        mainWindow?.loadFile(getFrontendPath('index.html')).catch(() => {});
        return;
      }
      console.warn(`⚠️  loadURL failed, retrying in 1000ms… (${attempts - 1} left)`);
      setTimeout(() => loadMainAppUrl(attempts - 1), 1000);
    });
  });
}

// ── Overlay window ────────────────────────────────────────
function createOverlayWindow(urlOrChannel: string, isUrl: boolean, theme?: string) {
  if (overlayWindow) overlayWindow.close();
  if (overlaySettingsWindow) { overlaySettingsWindow.close(); overlaySettingsWindow = null; }

  const overlayBaseUrl = isDev ? 'http://localhost:5173' : 'http://127.0.0.1:3000';
  const overlayUrl = isUrl
    ? urlOrChannel
    : `${overlayBaseUrl}/overlay.html?mode=chat&channel=${encodeURIComponent(urlOrChannel)}${theme ? `&theme=${encodeURIComponent(theme)}` : ''}`;

  overlayFrameless = true;
  overlayWindow = new BrowserWindow({
    width: 400,
    height: 600,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    frame: false,
    resizable: true,
    skipTaskbar: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    overlayWindow.setPosition(bounds.x + bounds.width + 10, bounds.y);
  } else {
    overlayWindow.setPosition(100, 100);
  }

  overlayWindow.loadURL(overlayUrl).then(() => {
    overlayWindow?.show();
  }).catch((err) => {
    console.error('[overlay] Failed to load overlay URL:', err);
    overlayWindow?.show();
  });

  overlayWindow.setIgnoreMouseEvents(false);

  overlayWindow.webContents.on('did-finish-load', () => {
    overlayWindow?.webContents.insertCSS(`
      body { background: transparent !important; margin: 0; overflow: hidden; }
      html { background: transparent !important; }
      #overlay-root { background: transparent !important; width: 100vw; height: 100vh; }
      :root { --bg-alpha: 0.6; }
    `);
  });

  overlayWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173'];
    if (!allowed.some((prefix) => url.startsWith(prefix))) {
      event.preventDefault();
    }
  });

  overlayWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12') {
      overlayWindow?.webContents.toggleDevTools();
    }
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    overlayIgnoreMouse = true;
    overlayFrameless = true;
    if (overlaySettingsWindow) { overlaySettingsWindow.close(); overlaySettingsWindow = null; }
  });
}

function recreateOverlayWindow() {
  if (!overlayWindow) return;
  const bounds = overlayWindow.getBounds();
  overlayFrameless = !overlayFrameless;
  const currentUrl = overlayWindow.webContents.getURL();
  overlayWindow.close();
  overlayWindow = null;
  overlayWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    transparent: overlayFrameless,
    backgroundColor: overlayFrameless ? '#00000000' : '#0a0a1a',
    alwaysOnTop: true,
    frame: !overlayFrameless,
    resizable: true,
    skipTaskbar: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWindow.loadURL(currentUrl).then(() => overlayWindow?.show()).catch(() => overlayWindow?.show());
  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.webContents.on('did-finish-load', () => {
    overlayWindow?.webContents.insertCSS(`
      body { background: transparent !important; margin: 0; overflow: hidden; }
      html { background: transparent !important; }
      #overlay-root { background: transparent !important; width: 100vw; height: 100vh; }
      :root { --bg-alpha: 0.6; }
    `);
  });
  overlayWindow.webContents.on('before-input-event', (_event: Electron.Event, input: Electron.Input) => {
    if (input.key === 'F12') overlayWindow?.webContents.toggleDevTools();
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    overlayIgnoreMouse = true;
    overlayFrameless = true;
    if (overlaySettingsWindow) { overlaySettingsWindow.close(); overlaySettingsWindow = null; }
  });
}

function openOverlaySettingsWindow() {
  if (!overlayWindow) return;
  if (overlaySettingsWindow && !overlaySettingsWindow.isDestroyed()) {
    overlaySettingsWindow.focus();
    return;
  }
  const overlayBaseUrl = isDev ? 'http://localhost:5173' : 'http://localhost:3000';
  overlaySettingsWindow = new BrowserWindow({
    width: 360,
    height: 500,
    parent: overlayWindow,
    modal: false,
    frame: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'StreamDaemon - Overlay Settings',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlaySettingsWindow.loadURL(`${overlayBaseUrl}/overlay.html?mode=settings`);
  overlaySettingsWindow.on('closed', () => { overlaySettingsWindow = null; });
}

function toggleClickThrough() {
  if (!overlayWindow) return;
  overlayIgnoreMouse = !overlayIgnoreMouse;
  overlayWindow.setIgnoreMouseEvents(overlayIgnoreMouse, { forward: true });
}

// ── IPC ───────────────────────────────────────────────────

const TRUSTED_OVERLAY_ORIGINS = ['http://localhost:3000', 'http://localhost:5173'];

ipcMain.on('overlay:open', (_e, url: string, isUrl: boolean, theme?: string) => {
  if (isUrl && (url.startsWith('http://localhost') || url.startsWith('file://')) && !TRUSTED_OVERLAY_ORIGINS.some(t => url.startsWith(t))) {
    console.warn('[security] Blocked untrusted overlay URL:', url);
    return;
  }
  createOverlayWindow(url, isUrl, theme);
});
ipcMain.on('overlay:close', () => overlayWindow?.close());
ipcMain.handle('overlay:isOpen', () => overlayWindow !== null && !overlayWindow.isDestroyed());
ipcMain.on('overlay:toggleClickThrough', toggleClickThrough);
ipcMain.handle('overlay:getClickThrough', () => overlayIgnoreMouse);
ipcMain.on('overlay:setOpacity', (_e, v: number) => {
  if (!overlayWindow) return;
  const alpha = Math.max(0.1, Math.min(1, v));
  overlayWindow?.webContents.insertCSS(`:root { --bg-alpha: ${alpha}; }`);
});
ipcMain.on('overlay:resize', (_e, w: number, h: number) => {
  if (!overlayWindow) return;
  const bounds = overlayWindow.getBounds();
  overlayWindow.setBounds({ x: bounds.x, y: bounds.y, width: Math.max(200, w), height: Math.max(100, h) });
});
ipcMain.on('overlay:setPosition', (_e, x: number, y: number) => {
  overlayWindow?.setPosition(x, y);
});
ipcMain.handle('overlay:getBounds', () => overlayWindow?.getBounds() ?? null);
ipcMain.on('overlay:setAlwaysOnTop', (_e, value: boolean) => {
  overlayWindow?.setAlwaysOnTop(value, 'screen-saver');
});
ipcMain.handle('overlay:getAlwaysOnTop', () => overlayWindow?.isAlwaysOnTop() ?? false);
ipcMain.on('overlay:setFontSize', (_e, size: number) => {
  if (!overlayWindow) return;
  overlayWindow.webContents.executeJavaScript(`
    try {
      const raw = localStorage.getItem('streamforger-overlay-settings') || '{}';
      const s = JSON.parse(raw);
      s.fontSize = ${size};
      localStorage.setItem('streamforger-overlay-settings', JSON.stringify(s));
      window.dispatchEvent(new CustomEvent('overlay:settings', { detail: { fontSize: ${size} } }));
    } catch (e) { console.error('[overlay] setFontSize error:', e); }
  `).catch(() => {});
});
ipcMain.on('overlay:setFont', (_e, fontFamily: string) => {
  if (!overlayWindow) return;
  overlayWindow.webContents.executeJavaScript(`
    try {
      const raw = localStorage.getItem('streamforger-overlay-settings') || '{}';
      const s = JSON.parse(raw);
      s.fontFamily = ${JSON.stringify(fontFamily)};
      localStorage.setItem('streamforger-overlay-settings', JSON.stringify(s));
      window.dispatchEvent(new CustomEvent('overlay:settings', { detail: { fontFamily: ${JSON.stringify(fontFamily)} } }));
    } catch (e) { console.error('[overlay] setFont error:', e); }
  `).catch(() => {});
});
ipcMain.on('overlay:setBgMode', (_e, mode: string) => {
  if (!overlayWindow) return;
  overlayWindow.webContents.executeJavaScript(`
    try {
      const raw = localStorage.getItem('streamforger-overlay-settings') || '{}';
      const s = JSON.parse(raw);
      s.bgMode = ${JSON.stringify(mode)};
      localStorage.setItem('streamforger-overlay-settings', JSON.stringify(s));
      window.dispatchEvent(new CustomEvent('overlay:settings', { detail: { bgMode: ${JSON.stringify(mode)} } }));
    } catch (e) { console.error('[overlay] setBgMode error:', e); }
  `).catch(() => {});
});

// ── Overlay context menu ────────────────────────────────
ipcMain.on('overlay:showContextMenu', () => {
  if (!overlayWindow) return;
  const menu = new Menu();
  menu.append(new MenuItem({
    label: overlayFrameless ? 'Mostrar bordes' : 'Eliminar bordes',
    click: () => recreateOverlayWindow(),
  }));
  menu.append(new MenuItem({
    label: 'Ajustes de ventana',
    click: () => openOverlaySettingsWindow(),
  }));
  menu.append(new MenuItem({ type: 'separator' }));
  menu.append(new MenuItem({
    label: 'Resetear ventana',
    click: () => {
      if (!overlayWindow) return;
      const defaultW = 400, defaultH = 600;
      if (mainWindow && !mainWindow.isDestroyed()) {
        const bounds = mainWindow.getBounds();
        overlayWindow.setBounds({ x: bounds.x + bounds.width + 10, y: bounds.y, width: defaultW, height: defaultH });
      } else {
        overlayWindow.setBounds({ x: 100, y: 100, width: defaultW, height: defaultH });
      }
    },
  }));
  menu.popup({ window: overlayWindow });
});

// Overlay borders toggle (from settings panel)
ipcMain.on('overlay:toggleBorders', () => recreateOverlayWindow());

// Overlay reset window (from settings panel)
ipcMain.on('overlay:resetWindow', () => {
  if (!overlayWindow) return;
  const defaultW = 400, defaultH = 600;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    overlayWindow.setBounds({ x: bounds.x + bounds.width + 10, y: bounds.y, width: defaultW, height: defaultH });
  } else {
    overlayWindow.setBounds({ x: 100, y: 100, width: defaultW, height: defaultH });
  }
});

// Open overlay settings window
ipcMain.on('overlay:showSettings', () => openOverlaySettingsWindow());

// Backend readiness
ipcMain.handle('backend:isReady', () => backendReady);

// Vibe CV (detección automática beta: Fortnite)
ipcMain.handle('vibe-cv:getConfig', () => getVibeCvConfig());
ipcMain.handle('vibe-cv:setConfig', (_e, value: VibeCvConfig) => setVibeCvConfig(value));
ipcMain.handle('vibe-cv:getStatus', () => getVibeCvStatus());
ipcMain.handle('vibe-cv:captureDebug', () => captureVibeCvDebug());

// Main window — always-on-top toggle
ipcMain.handle('window:getAlwaysOnTop', () => mainAlwaysOnTop);
ipcMain.on('window:setAlwaysOnTop', (_e, value: boolean) => {
  mainAlwaysOnTop = value;
  mainWindow?.setAlwaysOnTop(value, 'screen-saver');
});

// Main window — background opacity via CSS
ipcMain.on('window:setOpacity', (_e, value: number) => {
  if (!mainWindow) return;
  const alpha = Math.max(0.1, Math.min(1, value));
  mainWindow.webContents.insertCSS(`
    body > div:first-child { background: rgba(10,10,26,${alpha}) !important; }
  `);
});

// Main window drag / minimize / close
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:close',    () => mainWindow?.close());

// ── Lifecycle ─────────────────────────────────────────────

app.whenReady().then(async () => {
  globalShortcut.register('CommandOrControl+Shift+T', toggleClickThrough);

  // Inject local API token into all requests to the bundled backend.
  // The renderer never sees the token, reducing exposure surface.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        'http://localhost:3000/*',
        'http://127.0.0.1:3000/*',
        'ws://localhost:3000/*',
        'ws://127.0.0.1:3000/*',
      ],
    },
    (details, callback) => {
      details.requestHeaders['x-local-token'] = LOCAL_API_TOKEN;
      callback({ requestHeaders: details.requestHeaders });
    },
  );

function getInitialLoadingHtml(): string {
  const locale = (app.getLocale() || '').toLowerCase();
  let statusText = 'Initializing local broadcast engine & AES-256 vault…';
  let taglineText = 'Local-first broadcast suite, multistream chat & modular overlays.';
  if (locale.startsWith('es')) {
    statusText = 'Inicializando motor local StreamDaemon y bóveda AES-256…';
    taglineText = 'Plataforma local-first de producción en directo, chat multistream y overlays modulares.';
  } else if (locale.startsWith('fr')) {
    statusText = 'Initialisation du moteur local StreamDaemon…';
    taglineText = 'Suite locale de diffusion en direct, chat multistream et overlays modulaires.';
  } else if (locale.startsWith('de')) {
    statusText = 'Lokale StreamDaemon-Engine wird initialisiert…';
    taglineText = 'Local-First-Streaming-Suite, Multistream-Chat & modulare Overlays.';
  } else if (locale.startsWith('it')) {
    statusText = 'Inizializzazione del motore locale StreamDaemon…';
    taglineText = 'Suite locale di regia live, chat multistream e overlay modulari.';
  }

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: #06050d;
      color: #f8fafc;
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      user-select: none;
      overflow: hidden;
      position: relative;
      padding: 2rem 1.25rem 3.5rem;
    }
    .titlebar {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 32px;
      -webkit-app-region: drag;
      display: flex;
      align-items: center;
      padding: 0 0.9rem;
      background: rgba(6, 5, 13, 0.65);
      border-bottom: 1px solid rgba(139, 92, 246, 0.12);
      font-size: 0.65rem;
      font-weight: 700;
      letter-spacing: 0.14em;
      color: rgba(203, 213, 225, 0.65);
      gap: 0.45rem;
      z-index: 50;
    }
    .titlebar-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #a855f7; box-shadow: 0 0 8px #a855f7;
    }
    .bg-grid {
      position: fixed; inset: 0; pointer-events: none;
      background-image:
        linear-gradient(to right, rgba(139, 92, 246, 0.045) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(139, 92, 246, 0.045) 1px, transparent 1px);
      background-size: 44px 44px;
      -webkit-mask-image: radial-gradient(ellipse 68% 60% at 50% 48%, #000 25%, transparent 80%);
    }
    .bg-glow {
      position: fixed; inset: 0; pointer-events: none;
      background: radial-gradient(ellipse 52% 45% at 50% 38%, rgba(124, 58, 237, 0.18) 0%, rgba(6, 182, 212, 0.06) 45%, transparent 75%);
    }
    .card {
      position: relative;
      z-index: 2;
      width: 100%;
      max-width: 560px;
      background: linear-gradient(180deg, rgba(19, 15, 36, 0.88) 0%, rgba(11, 9, 22, 0.95) 100%);
      border: 1px solid rgba(168, 85, 247, 0.22);
      border-radius: 18px;
      padding: 1.85rem 2rem 1.65rem;
      box-shadow: 0 28px 70px -15px rgba(0, 0, 0, 0.85), 0 0 40px -10px rgba(124, 58, 237, 0.22);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.35rem;
      overflow: hidden;
    }
    .top-bar {
      position: absolute; top: 0; left: 0; right: 0; height: 3px;
      background: linear-gradient(90deg, #9146ff 0%, #c084fc 35%, #22d3ee 70%, #ff0033 100%);
    }
    .header-row {
      width: 100%; display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06); padding-bottom: 0.75rem;
    }
    .eyebrow {
      font-family: 'Cascadia Code', Consolas, monospace;
      font-size: 0.64rem; font-weight: 700; letter-spacing: 0.14em;
      color: rgba(192, 132, 252, 0.85);
    }
    .ver {
      font-family: 'Cascadia Code', Consolas, monospace;
      font-size: 0.66rem; font-weight: 700; color: #22d3ee;
      background: rgba(6, 182, 212, 0.12); border: 1px solid rgba(6, 182, 212, 0.3);
      padding: 0.16rem 0.52rem; border-radius: 999px;
    }
    .stage {
      position: relative; width: 144px; height: 144px;
      display: flex; align-items: center; justify-content: center;
    }
    .orb-glow {
      position: absolute; inset: 12px; border-radius: 50%;
      background: radial-gradient(circle, rgba(168, 85, 247, 0.32) 0%, rgba(6, 182, 212, 0.08) 55%, transparent 75%);
      filter: blur(8px);
    }
    .orb-outer {
      position: absolute; inset: 4px; border-radius: 50%;
      border: 1px dashed rgba(192, 132, 252, 0.28);
      animation: spin 18s linear infinite;
    }
    .orb-inner {
      position: absolute; inset: 14px; border-radius: 50%;
      border: 1.5px solid transparent;
      border-top-color: rgba(34, 211, 238, 0.65);
      border-bottom-color: rgba(168, 85, 247, 0.65);
      animation: spin-rev 7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes spin-rev { to { transform: rotate(-360deg); } }
    .pill {
      position: absolute; bottom: -4px;
      display: inline-flex; align-items: center; gap: 0.35rem;
      font-family: 'Cascadia Code', Consolas, monospace;
      font-size: 0.6rem; font-weight: 700; letter-spacing: 0.12em;
      padding: 0.2rem 0.6rem; border-radius: 999px;
      background: rgba(15, 10, 30, 0.95); border: 1px solid rgba(168, 85, 247, 0.4);
      color: #e9d5ff;
    }
    .pill-dot {
      width: 6px; height: 6px; border-radius: 50%; background: #c084fc; box-shadow: 0 0 8px #c084fc;
    }
    .brand { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 0.4rem; }
    .wordmark { margin: 0; font-size: 2.15rem; font-weight: 800; letter-spacing: -0.035em; color: #fff; }
    .accent {
      background: linear-gradient(135deg, #c084fc 0%, #818cf8 55%, #22d3ee 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .tagline { margin: 0; max-width: 430px; font-size: 0.82rem; line-height: 1.45; color: rgba(203, 213, 225, 0.72); }
    .progress-box {
      width: 100%; display: flex; flex-direction: column; gap: 0.5rem;
      background: rgba(5, 4, 12, 0.55); border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 11px; padding: 0.75rem 0.9rem;
    }
    .status-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
    .status-left { display: flex; align-items: center; gap: 0.5rem; font-size: 0.76rem; color: rgba(226, 232, 240, 0.88); }
    .pulse {
      width: 7px; height: 7px; border-radius: 50%; background: #a855f7; box-shadow: 0 0 10px #a855f7;
      animation: pulse 1.2s ease-in-out infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
    .track { width: 100%; height: 6px; background: rgba(255, 255, 255, 0.07); border-radius: 999px; overflow: hidden; }
    .fill {
      height: 100%; width: 38%; border-radius: 999px;
      background: linear-gradient(90deg, #7c3aed 0%, #a855f7 55%, #22d3ee 100%);
      box-shadow: 0 0 14px rgba(168, 85, 247, 0.65);
      animation: boot-bar 2.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    @keyframes boot-bar { 0% { width: 12%; } 60% { width: 78%; } 100% { width: 95%; } }
  </style>
</head>
<body>
  <div class="titlebar"><span class="titlebar-dot"></span><span>STREAMDAEMON STUDIO</span></div>
  <div class="bg-grid"></div>
  <div class="bg-glow"></div>
  <main class="card">
    <div class="top-bar"></div>
    <div class="header-row">
      <span class="eyebrow">CYBER HAUTE COUTURE · BROADCAST SUITE</span>
      <span class="ver">v0.7.0</span>
    </div>
    <div class="stage">
      <div class="orb-glow"></div>
      <div class="orb-outer"></div>
      <div class="orb-inner"></div>
      <svg viewBox="0 0 120 120" width="92" height="92" xmlns="http://www.w3.org/2000/svg" style="position:relative;z-index:2;filter:drop-shadow(0 8px 22px rgba(124,58,237,0.45))">
        <defs>
          <linearGradient id="sdOuter" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#c084fc" />
            <stop offset="45%" stop-color="#7c3aed" />
            <stop offset="100%" stop-color="#06b6d4" />
          </linearGradient>
          <linearGradient id="sdCore" x1="15%" y1="10%" x2="85%" y2="90%">
            <stop offset="0%" stop-color="#1e1338" />
            <stop offset="55%" stop-color="#0f0a1e" />
            <stop offset="100%" stop-color="#070510" />
          </linearGradient>
          <linearGradient id="sdHorn" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#ffffff" />
            <stop offset="65%" stop-color="#e9d5ff" />
            <stop offset="100%" stop-color="#a855f7" />
          </linearGradient>
          <linearGradient id="sdVisor" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#22d3ee" />
            <stop offset="50%" stop-color="#a855f7" />
            <stop offset="100%" stop-color="#f43f5e" />
          </linearGradient>
        </defs>
        <polygon points="60,6 106,32 106,88 60,114 14,88 14,32" fill="url(#sdOuter)" />
        <polygon points="60,11 101,35 101,85 60,109 19,85 19,35" fill="url(#sdCore)" />
        <polygon points="60,16 96,37 96,83 60,104 24,83 24,37" fill="none" stroke="rgba(192, 132, 252, 0.25)" stroke-width="1.2" />
        <path d="M 47 28 A 18 18 0 0 1 73 28" fill="none" stroke="#22d3ee" stroke-width="2.2" stroke-linecap="round" opacity="0.85" />
        <circle cx="60" cy="31" r="2.6" fill="#22d3ee" />
        <path d="M 30 26 L 46 42 L 54 38 L 60 43 L 66 38 L 74 42 L 90 26 L 86 52 L 91 62 L 78 86 L 60 98 L 42 86 L 29 62 L 34 52 Z" fill="url(#sdHorn)" />
        <path d="M 39 50 L 53 55 L 60 51 L 67 55 L 81 50 L 83 63 L 73 81 L 60 90 L 47 81 L 37 63 Z" fill="#120b24" />
        <polygon points="41,57 56,62 54,68 39,63" fill="url(#sdVisor)" />
        <polygon points="79,57 64,62 66,68 81,63" fill="url(#sdVisor)" />
        <polygon points="43,58.5 53,62 52,64.5 42,61" fill="#ffffff" opacity="0.9" />
        <polygon points="77,58.5 67,62 68,64.5 78,61" fill="#ffffff" opacity="0.9" />
        <path d="M 48 75 L 54 71 L 60 76 L 66 71 L 72 75 L 67 83 L 60 86 L 53 83 Z" fill="url(#sdOuter)" opacity="0.95" />
      </svg>
      <span class="pill"><span class="pill-dot"></span>BOOTING ENGINE</span>
    </div>
    <div class="brand">
      <h1 class="wordmark">Stream<span class="accent">Daemon</span></h1>
      <p class="tagline">${taglineText}</p>
    </div>
    <div class="progress-box">
      <div class="status-row">
        <div class="status-left"><span class="pulse"></span><span>${statusText}</span></div>
      </div>
      <div class="track"><div class="fill"></div></div>
    </div>
  </main>
</body>
</html>`;
  return `data:text/html;base64,${Buffer.from(html, 'utf-8').toString('base64')}`;
}

  // Open the main window immediately with a loading screen so the UI is responsive
  // while the bundled backend starts in the background.
  createMainWindow();
  if (mainWindow) {
    await mainWindow.loadURL(getInitialLoadingHtml());
  }

  await startBackend();
  if (backendReady && mainWindow) {
    loadMainAppUrl();
  }

  setupVibeDaemonHotkeys();
  setInterval(setupVibeDaemonHotkeys, 60_000);

  initVibeCvDetector();
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  stopVibeCvDetector();
  app.quit();
});
