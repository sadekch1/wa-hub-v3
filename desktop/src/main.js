const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { createHost } = require('../dist/host.js');

// بعض توزيعات لينكس (وبعض نسخ ويندوز المخففة) لا تدعم sandbox
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
let host = null;

function send(o) { if (win && !win.isDestroyed()) win.webContents.send('ev', o); }
function notify(title, body) {
    try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch (_) {}
}

function createWindow(page) {
    win = new BrowserWindow({
        width: 520, height: 880, minWidth: 380, minHeight: 620,
        backgroundColor: '#0A1224', title: 'WA Hub 3', autoHideMenuBar: true, show: false,
        icon: path.join(__dirname, '..', 'build', 'icon.png'),
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(__dirname, '..', 'renderer', page));
    win.on('closed', () => { win = null; });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    host = createHost({
        baseDir: app.getPath('userData'),
        downloadsDir: app.getPath('downloads'),
        resourcesDir: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'vendor'),
        emit: (o) => {
            send(o);
            if (o.t === 'queueDone') notify('اكتمل التحميل', o.name || '');
        }
    });

    ipcMain.handle('cmd', async (_e, c) => {
        switch (c.cmd) {
            case 'pickFolder': {
                const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
                return r.canceled ? null : r.filePaths[0];
            }
            case 'pickFile': {
                const r = await dialog.showOpenDialog(win, { properties: ['openFile'] });
                return r.canceled ? null : r.filePaths[0];
            }
            case 'openRec': {
                const p = await host.handle({ cmd: 'recPath', id: c.id });
                if (p) await shell.openPath(p);
                return !!p;
            }
            case 'showRec': {
                const p = await host.handle({ cmd: 'recPath', id: c.id });
                if (p) shell.showItemInFolder(p);
                return !!p;
            }
            case 'openFolder': {
                const d = await host.handle({ cmd: 'downloadDir' });
                if (d) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} await shell.openPath(d); }
                return d;
            }
            case 'quit': app.quit(); return null;
            default: return host.handle(c);
        }
    });

    // اتصال واتساب يبدأ دائماً. الوضع المحفوظ (إن اختار «تذكّر») يفتح مباشرة بعد تسجيل الدخول، وإلا شاشة البداية.
    host.start().catch(() => {});
    const m = host.isRegistered() ? host.initialMode() : null;
    if (m) host.startMode(m);
    createWindow(m ? `${m}.html` : 'index.html');
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow('index.html'); });
});

app.on('before-quit', () => { try { host && host.shutdown(); } catch (_) {} });
app.on('window-all-closed', () => { app.quit(); });
