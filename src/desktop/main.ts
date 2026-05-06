/**
 * Clementine desktop shell.
 *
 * This process owns a native Electron window and supervises the existing
 * dashboard server. The dashboard remains the single UI source of truth.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

type ElectronApi = {
  app: any;
  BrowserWindow: any;
  Menu: any;
  Tray: any;
  nativeImage: any;
  shell: any;
  dialog: any;
  session: any;
};

function loadElectron(): ElectronApi {
  try {
    return require('electron') as ElectronApi;
  } catch {
    console.error('Electron is not installed. Run `npm install`, then `npm run desktop`.');
    process.exit(1);
  }
}

const electron = loadElectron();
const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, session } = electron;
app.setName('Clementine');
if (app.setAppUserModelId) app.setAppUserModelId('com.clementine.assistant');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const CLI_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');
const ICONS_DIR = path.join(PACKAGE_ROOT, 'build', 'icons');
const BASE_DIR = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');
const DEFAULT_PORT = Number(process.env.CLEMENTINE_DESKTOP_PORT || process.env.DASHBOARD_PORT || 3030);
const NODE_BINARY = process.env.CLEMENTINE_NODE_PATH || 'node';

let mainWindow: any = null;
let tray: any = null;
let dashboardProcess: ChildProcess | null = null;
let dashboardUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
let observedPort: number | null = null;
let isQuitting = false;
let restartTimer: NodeJS.Timeout | null = null;
let suppressNextDashboardExitRestart = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusHtml(title: string, detail: string): string {
  const safeTitle = title.replace(/[<&>]/g, '');
  const safeDetail = detail.replace(/[<&>]/g, '');
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
    'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#111827;color:#f9fafb}' +
    '.box{max-width:520px;padding:28px;text-align:center}.title{font-size:22px;font-weight:700;margin-bottom:10px}' +
    '.detail{font-size:13px;line-height:1.5;color:#cbd5e1}</style></head><body><div class="box">' +
    '<div class="title">' + safeTitle + '</div><div class="detail">' + safeDetail + '</div>' +
    '</div></body></html>',
  );
}

function loadStatus(title: string, detail: string): void {
  if (!mainWindow) return;
  mainWindow.loadURL(statusHtml(title, detail)).catch(() => undefined);
}

function resolveIconPath(name: string): string {
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  const packagedRoot = typeof electronProcess.resourcesPath === 'string'
    ? path.join(electronProcess.resourcesPath, 'build', 'icons')
    : ICONS_DIR;
  const candidates = [
    path.join(ICONS_DIR, name),
    path.join(packagedRoot, name),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function loadIcon(name: string): any {
  const icon = nativeImage.createFromPath(resolveIconPath(name));
  return icon.isEmpty() ? nativeImage.createEmpty() : icon;
}

function probeDashboard(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/', timeout: 600 },
      (res) => {
        res.resume();
        resolve(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 500));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitForDashboard(startPort: number, timeoutMs = 25_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (observedPort && await probeDashboard(observedPort)) return observedPort;
    for (let port = startPort; port < startPort + 10; port++) {
      if (await probeDashboard(port)) return port;
    }
    await sleep(400);
  }
  throw new Error(`Dashboard did not become ready on ports ${startPort}-${startPort + 9}`);
}

function attachDashboardLogs(child: ChildProcess): void {
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    const match = text.match(/http:\/\/localhost:(\d+)/);
    if (match) observedPort = Number(match[1]);
    if (process.env.CLEMENTINE_DESKTOP_DEBUG === '1') process.stdout.write(text);
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', (chunk: Buffer) => {
    if (process.env.CLEMENTINE_DESKTOP_DEBUG === '1') process.stderr.write(chunk);
  });
}

function startDashboardProcess(port: number): ChildProcess {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`Missing ${CLI_ENTRY}. Run npm run build before starting the desktop app.`);
  }
  observedPort = null;
  const child = spawn(NODE_BINARY, [CLI_ENTRY, 'dashboard', '-p', String(port)], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      CLEMENTINE_HOME: BASE_DIR,
      CLEMENTINE_NO_OPEN: '1',
      __CLEM_DASHBOARD_CHILD: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  attachDashboardLogs(child);
  child.on('exit', () => {
    if (dashboardProcess === child) dashboardProcess = null;
    if (suppressNextDashboardExitRestart) {
      suppressNextDashboardExitRestart = false;
      return;
    }
    if (!isQuitting) scheduleDashboardRestart();
  });
  return child;
}

async function startDashboardAndLoad(): Promise<void> {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  loadStatus('Starting Clementine', 'Opening the local dashboard server...');
  try {
    if (!dashboardProcess) dashboardProcess = startDashboardProcess(DEFAULT_PORT);
    const actualPort = await waitForDashboard(DEFAULT_PORT);
    dashboardUrl = `http://127.0.0.1:${actualPort}`;
    await mainWindow.loadURL(dashboardUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    loadStatus('Clementine is offline', message);
    dialog.showErrorBox('Clementine desktop failed to start', message);
  }
}

function scheduleDashboardRestart(): void {
  loadStatus('Reconnecting', 'The dashboard process stopped. Restarting it now...');
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startDashboardAndLoad().catch(() => undefined);
  }, 1200);
}

function stopDashboard(suppressRestart = true): void {
  if (!dashboardProcess) return;
  const child = dashboardProcess;
  dashboardProcess = null;
  suppressNextDashboardExitRestart = suppressRestart;
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
}

function restartDashboard(): void {
  stopDashboard(true);
  setTimeout(() => {
    startDashboardAndLoad().catch(() => undefined);
  }, 700);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: 'Clementine',
    backgroundColor: '#111827',
    icon: resolveIconPath('clementine.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('close', (event: any) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    shell.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });
}

function showWindow(): void {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function installMenu(): void {
  const template = [
    {
      label: 'Clementine',
      submenu: [
        { label: 'Show Clementine', click: showWindow },
        { label: 'Open in Browser', click: () => shell.openExternal(dashboardUrl).catch(() => undefined) },
        {
          label: 'Restart Dashboard',
          click: restartDashboard,
        },
        { type: 'separator' },
        {
          label: 'Quit Clementine',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installTray(): void {
  const trayIcon = loadIcon(process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');
  tray = new Tray(trayIcon.isEmpty() ? loadIcon('tray.png') : trayIcon);
  tray.setToolTip('Clementine');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Clementine', click: showWindow },
    { label: 'Restart Dashboard', click: restartDashboard },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

function installPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((webContents: any, permission: string, callback: (allow: boolean) => void) => {
    const url = webContents.getURL?.() || '';
    const local = url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:');
    callback(local && (permission === 'media' || permission === 'microphone'));
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    const appIcon = loadIcon('clementine.png');
    if (!appIcon.isEmpty() && app.dock) app.dock.setIcon(appIcon);
    if (app.setAboutPanelOptions) {
      app.setAboutPanelOptions({
        applicationName: 'Clementine',
        applicationVersion: app.getVersion(),
        iconPath: resolveIconPath('clementine.png'),
      });
    }
    installPermissions();
    installMenu();
    installTray();
    createWindow();
    startDashboardAndLoad().catch(() => undefined);
  });
}

app.on('activate', () => showWindow());
app.on('before-quit', () => {
  isQuitting = true;
  if (tray) {
    try { tray.destroy(); } catch { /* ignore */ }
  }
  stopDashboard();
});
