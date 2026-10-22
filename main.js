'use strict';
const {
  app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage,
  safeStorage, shell, globalShortcut, nativeTheme, powerMonitor, net,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { CalDavClient } = require('./src/caldav');
const { SyncEngine } = require('./src/sync');
const ical = require('./src/ical');

const APP_ID = 'it.spunta.attivita';
// set by electron-builder's portable launcher: the real .exe the user double-clicked
const PORTABLE_EXE = process.env.PORTABLE_EXECUTABLE_FILE || null;
app.setAppUserModelId(APP_ID);
app.commandLine.appendSwitch('lang', 'it-IT'); // date/time pickers in Italian format

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const userDir = app.getPath('userData');
const CONFIG_FILE = path.join(userDir, 'impostazioni.json');
const CACHE_FILE = path.join(userDir, 'cache.json');

const DEFAULT_SETTINGS = {
  defaultList: null,
  morningSummary: true,
  morningTime: '08:30',
  closeToTray: true,
  startAtLogin: false,
  notifyAllDayAt: '09:00',
  showCompleted: false,
  shortcut: 'CommandOrControl+Alt+A',
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

let config = readJson(CONFIG_FILE, {});
config.settings = { ...DEFAULT_SETTINGS, ...(config.settings || {}) };
config.notified = config.notified || {};
const saveConfig = () => writeJson(CONFIG_FILE, config);

function getPassword() {
  if (!config.account) return null;
  const { pass, passPlain } = config.account;
  if (pass && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(pass, 'base64')); } catch { return null; }
  }
  return passPlain || null;
}
function setPassword(pw) {
  if (safeStorage.isEncryptionAvailable()) {
    config.account.pass = safeStorage.encryptString(pw).toString('base64');
    delete config.account.passPlain;
  } else {
    config.account.passPlain = pw;
  }
}

// Chromium's network stack: uses Windows proxy settings and certificate store
const netFetch = (url, opts) => net.fetch(url, { ...opts, bypassCustomProtocolHandlers: true });

let client = null;
function makeClient() {
  if (!config.account) return null;
  if (!client) {
    const pw = getPassword();
    if (!pw) return null;
    client = new CalDavClient({ url: config.account.url, username: config.account.user, password: pw, fetch: netFetch });
    if (config.account.home) client.homeUrl = config.account.home;
  }
  return client;
}

const engine = new SyncEngine({
  makeClient,
  load: () => readJson(CACHE_FILE, null),
  save: (d) => writeJson(CACHE_FILE, d),
});

let win = null;
let tray = null;
let quitting = false;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function shortcutPath() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Spunta (portatile).lnk');
}
function envInfo() {
  return {
    portable: !!PORTABLE_EXE,
    notifyShortcut: PORTABLE_EXE ? fs.existsSync(shortcutPath()) : true,
    version: app.getVersion(),
  };
}

function fullState() {
  return {
    ...engine.state(),
    account: config.account ? { url: config.account.url, user: config.account.user } : null,
    settings: config.settings,
    env: envInfo(),
    scan: client && client.lastScan ? client.lastScan : null,
  };
}

let stateTimer = null;
engine.on('change', () => {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => { send('state', fullState()); updateTray(); }, 30);
});
engine.on('notice', (msg) => send('notice', msg));

// ---------------- window ----------------

const THEME = {
  light: { bg: '#f3f5f7', symbol: '#2a3540' },
  dark: { bg: '#161b21', symbol: '#d8dee5' },
};

function createWindow(show = true) {
  const t = nativeTheme.shouldUseDarkColors ? THEME.dark : THEME.light;
  const bounds = config.bounds || { width: 1120, height: 760 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: t.bg,
    title: 'Spunta',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: t.bg, symbolColor: t.symbol, height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  if (config.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.webContents.session.setSpellCheckerLanguages(['it-IT']);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    config.maximized = win.isMaximized();
    if (!win.isMaximized() && !win.isMinimized()) config.bounds = win.getBounds();
    saveConfig();
  };
  win.on('resize', debounce(saveBounds, 500));
  win.on('move', debounce(saveBounds, 500));
  win.on('close', (e) => {
    if (quitting) return;
    if (config.settings.closeToTray && tray) {
      e.preventDefault();
      win.hide();
      if (!config.trayHintShown) {
        config.trayHintShown = true; saveConfig();
        notify('Spunta resta attiva', 'La trovi nell\'area di notifica, vicino all\'orologio. Così i promemoria continuano ad arrivare.');
      }
    } else {
      quitting = true; // setting off: closing the window exits the app
      app.quit();
    }
  });
  win.on('focus', () => engine.sync().catch(() => {}));
}

function showWindow(then) {
  if (!win || win.isDestroyed()) createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (then) {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', then);
    else then();
  }
}

nativeTheme.on('updated', () => {
  if (!win || win.isDestroyed() || process.platform === 'darwin') return;
  const t = nativeTheme.shouldUseDarkColors ? THEME.dark : THEME.light;
  try { win.setTitleBarOverlay({ color: t.bg, symbolColor: t.symbol }); } catch { /* ignore */ }
  win.setBackgroundColor(t.bg);
});

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------------- tray ----------------

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip('Spunta');
  tray.on('click', () => showWindow());
  updateTray();
}
function updateTray() {
  if (!tray) return;
  const { today, overdue } = counts();
  tray.setToolTip(`Spunta — oggi ${today}${overdue ? `, in ritardo ${overdue}` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Apri Spunta', click: () => showWindow() },
    { label: 'Nuova attività…', click: () => showWindow(() => send('focus-quickadd')) },
    { label: 'Sincronizza ora', click: () => engine.sync({ force: true }).catch(() => {}) },
    { type: 'separator' },
    { label: 'Esci', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------------- notifications ----------------

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.png'), silent: false });
  n.on('click', () => { showWindow(onClick); });
  n.show();
}

function localToday() { return ical.localDateStr(new Date()); }

function counts() {
  const today = localToday();
  let t = 0, o = 0;
  for (const task of engine.tasks()) {
    if (task.completed || !task.due) continue;
    const d = task.due.allDay ? task.due.date : ical.localDateStr(new Date(task.due.ts));
    if (d < today) o++;
    else if (d === today) t++;
  }
  return { today: t, overdue: o };
}

function hm(str) { const [h, m] = (str || '09:00').split(':').map(Number); return [h || 0, m || 0]; }

function alarmTimes(task) {
  const out = [];
  const dueTs = task.due ? (task.due.allDay
    ? (() => { const [y, m, d] = task.due.date.split('-').map(Number); const [h, mi] = hm(config.settings.notifyAllDayAt); return new Date(y, m - 1, d, h, mi).getTime(); })()
    : task.due.ts) : null;
  const startTs = task.start ? (task.start.allDay ? new Date(task.start.date + 'T09:00:00').getTime() : task.start.ts) : null;
  for (const a of task.alarms || []) {
    if (a.abs) out.push(a.abs);
    else {
      const base = a.related === 'END' ? dueTs : (startTs ?? dueTs);
      if (base !== null && base !== undefined) out.push(base + a.rel);
    }
  }
  if (!out.length && task.due && !task.due.allDay) out.push(task.due.ts);
  return out;
}

let lastCheck = Date.now() - 10 * 60 * 1000; // catch reminders from the last 10 minutes at startup
function checkReminders() {
  const now = Date.now();
  let dirty = false;
  for (const task of engine.tasks()) {
    if (task.completed) continue;
    for (const ts of alarmTimes(task)) {
      if (ts > lastCheck && ts <= now) {
        const key = `${task.uid}|${ts}`;
        if (config.notified[key]) continue;
        config.notified[key] = now;
        dirty = true;
        const when = task.due && !task.due.allDay
          ? new Date(task.due.ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
          : 'oggi';
        notify(task.title || 'Attività', `Scadenza: ${when}`, () => send('open-task', task.uid));
      }
    }
  }
  // morning summary
  const s = config.settings;
  if (s.morningSummary) {
    const [h, m] = hm(s.morningTime);
    const at = new Date(); at.setHours(h, m, 0, 0);
    const today = localToday();
    if (now >= at.getTime() && config.lastSummary !== today && now - at.getTime() < 4 * 3600 * 1000) {
      config.lastSummary = today;
      dirty = true;
      const { today: t, overdue: o } = counts();
      if (t || o) {
        const parts = [];
        if (t) parts.push(t === 1 ? '1 attività per oggi' : `${t} attività per oggi`);
        if (o) parts.push(o === 1 ? '1 in ritardo' : `${o} in ritardo`);
        notify('Buongiorno', parts.join(', '), () => send('show-view', 'today'));
      }
    }
  }
  // prune old notification keys (older than 30 days)
  for (const [k, v] of Object.entries(config.notified)) if (now - v > 30 * 86400000) { delete config.notified[k]; dirty = true; }
  lastCheck = now;
  if (dirty) saveConfig();
}

// ---------------- IPC ----------------

function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; } catch (e) { return { ok: false, error: e.message || String(e), kind: e.kind }; }
  });
}

handle('state', () => fullState());

handle('connect', async ({ url, user, password }) => {
  const c = new CalDavClient({ url, username: user, password, fetch: netFetch });
  const home = await c.discover();
  const lists = await c.listTaskLists();
  const changedAccount = !config.account || config.account.url !== c.base || config.account.user !== user;
  config.account = { url: c.base, user, home };
  setPassword(password);
  saveConfig();
  client = null;
  if (changedAccount) engine.reset();
  await engine.sync({ force: true });
  if (!config.settings.defaultList || !lists.find((l) => l.href === config.settings.defaultList)) {
    const first = lists.find((l) => !l.readOnly);
    config.settings.defaultList = first ? first.href : null;
    saveConfig();
  }
  send('state', fullState());
  return { lists: lists.length, scan: c.lastScan };
});

handle('disconnect', () => {
  config.account = null;
  client = null;
  saveConfig();
  engine.reset();
  return true;
});

handle('sync', () => engine.sync({ force: true }));
handle('createTask', (listHref, fields) => engine.createTask(listHref, fields));
handle('updateTask', (href, patch) => engine.updateTask(href, patch));
handle('deleteTask', (href) => engine.deleteTask(href));
handle('moveTask', (href, listHref) => engine.moveTask(href, listHref));
handle('createList', (name, color) => engine.createList(name, color));
handle('setSettings', (patch) => {
  config.settings = { ...config.settings, ...patch };
  saveConfig();
  if ('startAtLogin' in patch) applyLoginItem();
  if ('shortcut' in patch) registerShortcut();
  send('state', fullState());
  return config.settings;
});
handle('openExternal', (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); });

// Portable only, and only when the user presses the button: Windows shows toast
// notifications only for apps that have a Start-menu shortcut carrying their AppUserModelID.
handle('createNotifyShortcut', () => {
  if (!PORTABLE_EXE || process.platform !== 'win32') return envInfo();
  const ok = shell.writeShortcutLink(shortcutPath(), 'create', {
    target: PORTABLE_EXE, appUserModelId: APP_ID, icon: PORTABLE_EXE, iconIndex: 0, description: 'Spunta',
  });
  if (!ok) throw new Error('Windows non ha permesso di creare il collegamento');
  send('state', fullState());
  return envInfo();
});
handle('removeNotifyShortcut', () => {
  try { fs.unlinkSync(shortcutPath()); } catch { /* already gone */ }
  send('state', fullState());
  return envInfo();
});
handle('testNotification', () => {
  if (!Notification.isSupported()) throw new Error('Le notifiche non sono supportate su questo sistema');
  notify('Prova di Spunta', 'Se leggi questo messaggio, i promemoria funzionano.');
  return true;
});

function applyLoginItem() {
  if (process.platform === 'linux') return;
  const opts = { openAtLogin: !!config.settings.startAtLogin, args: ['--nascosta'] };
  if (PORTABLE_EXE) opts.path = PORTABLE_EXE; // not the temporary unpacked copy
  app.setLoginItemSettings(opts);
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  try {
    globalShortcut.register(config.settings.shortcut || DEFAULT_SETTINGS.shortcut, () => showWindow(() => send('focus-quickadd')));
  } catch { /* shortcut taken by another app */ }
}

// ---------------- lifecycle ----------------

app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const hidden = process.argv.includes('--nascosta');
  createWindow(!hidden);
  createTray();
  registerShortcut();
  applyLoginItem();
  engine.sync().catch(() => {});
  setInterval(() => engine.sync().catch(() => {}), 2 * 60 * 1000);
  setInterval(checkReminders, 20 * 1000);
  setTimeout(checkReminders, 3000);
  if (hidden) {
    // started with Windows, window hidden: tell the user it is running
    setTimeout(() => {
      const { today: t, overdue: o } = counts();
      const parts = [];
      if (t) parts.push(t === 1 ? '1 attività per oggi' : `${t} attività per oggi`);
      if (o) parts.push(o === 1 ? '1 in ritardo' : `${o} in ritardo`);
      notify('Spunta è attiva', (parts.length ? parts.join(', ') + '. ' : '') + 'La trovi vicino all\'orologio.', () => {});
    }, 8000);
  }
  powerMonitor.on('resume', () => setTimeout(() => engine.sync().catch(() => {}), 5000));
  if (process.env.SPUNTA_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
});

app.on('before-quit', () => { quitting = true; engine.flushSave(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (!tray) app.quit(); });
