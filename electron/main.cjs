// Electron-оболочка AgentYard. Сама ничего не считает: поднимает локальный сервер ядра
// (обычный Node с --experimental-strip-types) и показывает его интерфейс в окне.
// Плюс то, чего не умеет браузер: выбор папки и сохранение отчёта в PDF.
'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
let server = null;
let serverUrl = null;
let win = null;

function startCore() {
  return new Promise((resolve, reject) => {
    const nodeBin = process.env.AGENTYARD_NODE || 'node';
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    server = spawn(nodeBin, ['--experimental-strip-types', '--no-warnings', path.join(ROOT, 'src', 'cli.ts'), 'ui', '--no-open', '--ready'], {
      cwd: ROOT,
      windowsHide: true,
      env,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`Сервер ядра не ответил за 20 с.\n${err}`)), 20_000);
    server.stdout.on('data', (d) => {
      out += d.toString();
      const m = /AY_READY (\{.*\})/.exec(out);
      if (m && !serverUrl) {
        clearTimeout(timer);
        serverUrl = JSON.parse(m[1]).url;
        resolve(serverUrl);
      }
    });
    server.stderr.on('data', (d) => { err += d.toString(); });
    server.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Не удалось запустить Node (${nodeBin}): ${e.message}. Нужен Node.js 22.6 или новее в PATH.`));
    });
    server.on('exit', (code) => {
      if (!serverUrl) {
        clearTimeout(timer);
        reject(new Error(`Сервер ядра завершился с кодом ${code}.\n${err}`));
      } else if (win && !app.isQuitting) {
        dialog.showErrorBox('AgentYard', `Сервер ядра остановился (код ${code}).\n${err.slice(-2000)}`);
      }
    });
  });
}

function sameOrigin(url) {
  try {
    return new URL(url).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: 'AgentYard',
    backgroundColor: '#151514',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  // отчёт открываем отдельным окном приложения, внешние ссылки — в браузере
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 1000, height: 900, autoHideMenuBar: true } };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!sameOrigin(url)) e.preventDefault();
  });
  win.loadURL(serverUrl);
}

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Папка проекта' });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('save-pdf', async (_e, url, suggested) => {
  if (!sameOrigin(url)) throw new Error('чужой адрес');
  const target = await dialog.showSaveDialog(win, { title: 'Сохранить отчёт', defaultPath: suggested || 'agentyard-report.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (target.canceled || !target.filePath) return null;
  const hidden = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await hidden.loadURL(url);
    const pdf = await hidden.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
    fs.writeFileSync(target.filePath, pdf);
    return target.filePath;
  } finally {
    hidden.destroy();
  }
});

app.whenReady().then(async () => {
  try {
    await startCore();
    createWindow();
  } catch (e) {
    dialog.showErrorBox('AgentYard не запустился', e.message);
    app.quit();
  }
});

// Выход: сначала просим ядро остановить прогон и выгрузить модели из видеопамяти (иначе Ollama держит их ещё
// минуты после закрытия окна), потом гасим процесс ядра. Ждём не дольше 30 с.
let released = false;
app.on('before-quit', (e) => {
  app.isQuitting = true;
  if (!server || server.killed) return;
  if (!released && serverUrl) {
    released = true;
    e.preventDefault();
    if (win && !win.isDestroyed()) win.hide();
    const u = new URL(serverUrl);
    const token = u.searchParams.get('t') || '';
    fetch(new URL('/api/shutdown', u.origin), { method: 'POST', headers: { 'x-ay-token': token, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30_000) })
      .catch(() => undefined)
      .finally(() => {
        if (server && !server.killed) server.kill();
        app.quit();
      });
    return;
  }
  server.kill();
});
app.on('window-all-closed', () => app.quit());
