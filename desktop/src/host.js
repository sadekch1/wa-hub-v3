'use strict';
// ────────────────────────────────────────────────────────────────
// مدير التطبيق: اتصال واتساب واحد دائم (تسجيل الدخول مرة واحدة)
// + وضع نشط واحد في كل مرة (مشاهدة أو تحميل) يمكن التبديل بينهما.
// ────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { createCore } = require('./engines/core.js');
const download = require('./engines/download.js');
const watch = require('./engines/watch.js');

function createHost({ baseDir, downloadsDir, resourcesDir, emit: emitCb }) {
    fs.mkdirSync(baseDir, { recursive: true });
    const HUB_FILE = path.join(baseDir, 'hub.json');
    const AUTH_DIR = path.join(baseDir, 'auth');

    let hub = { mode: null, remember: false };
    try { hub = { ...hub, ...JSON.parse(fs.readFileSync(HUB_FILE, 'utf8')) }; } catch (_) {}
    const saveHub = () => { try { fs.writeFileSync(HUB_FILE, JSON.stringify(hub)); } catch (_) {} };

    const core = createCore({ authDir: AUTH_DIR, dataDir: baseDir, emit: (o) => emitCb(o) });

    let mode = null;
    let mod = null;
    let generation = 0;

    function stopMode() {
        generation++;                       // أي حدث متأخر من الوضع القديم يُهمل
        if (mod) { try { mod.shutdown(); } catch (_) {} }
        mod = null; mode = null;
    }

    function startMode(m) {
        stopMode();
        const gen = generation;
        const factory = m === 'watch' ? watch : download;
        mod = factory.createEngine({
            dataDir: path.join(baseDir, m),
            downloadsDir,
            resourcesDir,
            core,
            emit: (o) => { if (gen === generation) emitCb(o); }
        });
        mode = m;
    }

    async function handle(c) {
        if (await core.handle(c)) return null;           // connect / pair / logout / diag
        switch (c.cmd) {
            case 'getMode': return { mode, saved: hub.remember ? hub.mode : null, remember: !!hub.remember };
            case 'setMode':
                if (c.mode === 'watch' || c.mode === 'download') {
                    if (c.remember !== undefined) { hub.remember = !!c.remember; hub.mode = c.mode; saveHub(); }
                    startMode(c.mode);
                } else {
                    stopMode();
                    hub.remember = false; saveHub();     // «تغيير الوضع» يلغي التذكّر
                }
                return null;
            case 'getState':
                return { ...core.base(), ...(mod ? await mod.handle({ cmd: 'getState' }) : {}), mode };
            default:
                return mod ? mod.handle(c) : null;
        }
    }

    return {
        handle,
        /** يبدأ الاتصال بواتساب (أو يطلب تسجيل الدخول) */
        start: () => core.handle({ cmd: 'connect' }),
        isRegistered: () => core.isRegistered(),
        initialMode: () => (hub.remember && (hub.mode === 'watch' || hub.mode === 'download') ? hub.mode : null),
        startMode,
        _core: core,
        shutdown: () => { stopMode(); core.shutdown(); }
    };
}

module.exports = { createHost };
