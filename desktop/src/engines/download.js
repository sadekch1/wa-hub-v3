'use strict';
// ────────────────────────────────────────────────────────────────
// محرك التحميل في WA Hub 3 لسطح المكتب (Windows / Linux)
// يحمّل الملفات من واتساب مباشرة إلى المجلد.
// ────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const { matchesTarget } = require('./core');

// ───────────────────────── ثوابت ─────────────────────────
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 60000;
const STALL_MS = 25000;
const ATTEMPT_MAX_MS = 60 * 60 * 1000;
const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 60000;
const BOOT_TOLERANCE = 10;
const PAIR_MAX_TRIES = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

function toNum(v) {
    if (v == null) return 0;
    if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function sanitizeFileName(name) {
    let n = String(name || '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').trim();
    if (!n) n = `file_${Date.now()}`;
    if (n.length > 120) {
        const ext = path.extname(n).slice(0, 15);
        n = n.slice(0, 120 - ext.length) + ext;
    }
    return n;
}

function cleanFolderName(raw) {
    const n = String(raw || '').replace(/[\\/:*?"<>|]/g, '_').trim().replace(/^\.+|\.+$/g, '');
    return (n || 'my downloading file').slice(0, 80);
}

function safeUnlink(p) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} }

function uniquePath(dir, name) {
    let p = path.join(dir, name);
    if (!fs.existsSync(p)) return p;
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    let i = 1;
    while (fs.existsSync(p)) { p = path.join(dir, `${base} (${i})${ext}`); i++; }
    return p;
}

function freeBytes(dir) {
    try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch (_) { return -1; }
}

function withTimeout(promise, ms, message) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function isExpiredError(err) {
    const code = (err && err.output && err.output.statusCode) || (err && err.statusCode);
    const msg = String((err && err.message) || '');
    return code === 404 || code === 410 || /\b(404|410)\b/.test(msg) || /empty media key|media key|expired/i.test(msg);
}

// ───────────────────────── المحرك ─────────────────────────
function createEngine({ dataDir, downloadsDir, core, emit: emitCb }) {
    const SETTINGS_FILE = path.join(dataDir, 'settings.json');
    const HISTORY_FILE = path.join(dataDir, 'history.json');
    const ERROR_LOG = path.join(dataDir, 'engine-errors.log');
    fs.mkdirSync(dataDir, { recursive: true });

    const BOOT_TIME = Math.floor(Date.now() / 1000);

    function logError(err) {
        try { fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${(err && err.stack) || err}\n`); } catch (_) {}
    }

    // ── الأحداث ──
    const logs = [];
    function emit(o) { try { emitCb(o); } catch (_) {} }
    function log(msg) { logs.push(String(msg)); if (logs.length > 150) logs.shift(); emit({ t: 'log', msg: String(msg) }); }

    // ── الإعدادات ──
    const defaults = {
        baseDir: downloadsDir,
        folderName: 'my downloading file',
        target: '',
        gapMin: 3,
        gapMax: 10,
        maxSizeMb: 0,
        exts: '',
    };
    let settings = { ...defaults };
    try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (_) {}
    settings.folderName = cleanFolderName(settings.folderName);

    const downloadDir = () => path.join(settings.baseDir, settings.folderName);
    const extList = () => String(settings.exts || '').toLowerCase().split(/[,\s]+/).map((s) => s.replace(/^\./, '')).filter(Boolean);

    function saveSettings(patch) {
        const p = { ...patch };
        if ('folderName' in p) p.folderName = cleanFolderName(p.folderName);
        for (const k of ['gapMin', 'gapMax', 'maxSizeMb']) if (k in p) p[k] = Number(p[k]) || 0;
        if ('target' in p) p.target = String(p.target || '').replace(/[^0-9]/g, '');
        settings = { ...settings, ...p };
        if (settings.gapMax < settings.gapMin) settings.gapMax = settings.gapMin;
        try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) { logError(e); }
        emit({ t: 'settings', settings, downloadDir: downloadDir() });
    }

    // ── السجل ──
    let history = [];
    try {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')).filter((r) => r && r.path && fs.existsSync(r.path));
    } catch (_) {}
    function saveHistory() {
        try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); } catch (e) { logError(e); }
        emit({ t: 'history', history });
    }

    // ── المهام ──
    const jobs = new Map();
    const queue = [];
    const seenIds = new Set();
    let running = false;
    let userPaused = false;
    let counter = 0;

    const pubJob = (j) => ({
        id: j.id, name: j.name, size: j.size, from: j.from, status: j.status,
        done: j.done || 0, speed: j.speed || 0, attempt: j.attempt || 0, error: j.error || ''
    });
    const emitJobs = () => emit({ t: 'jobs', jobs: [...jobs.values()].map(pubJob) });

    function snapshot() {
        return {
            paused: userPaused,
            jobs: [...jobs.values()].map(pubJob), history, settings, downloadDir: downloadDir()
        };
    }

    // ───────────── التحميل ─────────────
    function enqueue(job) {
        jobs.set(job.id, job);
        queue.push(job);
        emitJobs();
        processQueue();
    }

    async function processQueue() {
        if (running) return;
        running = true;
        try {
            while (!userPaused && queue.length > 0) {
                const job = queue.shift();
                if (job.status === 'canceled') continue;
                await handleJob(job);
                if (!userPaused && queue.length > 0) {
                    const lo = Math.max(0, settings.gapMin), hi = Math.max(lo, settings.gapMax);
                    const until = Date.now() + rand(lo * 1000, hi * 1000);
                    while (Date.now() < until && !userPaused) await sleep(300);
                }
            }
        } finally { running = false; }
    }

    function downloadWithProgress(job, stream, partPath) {
        return new Promise((resolve, reject) => {
            const out = fs.createWriteStream(partPath);
            let downloaded = 0, settled = false, stallTimer = null;
            let lastEmit = 0, lastBytes = 0, lastTime = Date.now(), speed = 0;

            const resetStall = () => {
                clearTimeout(stallTimer);
                stallTimer = setTimeout(() => fail(new Error('توقف التنزيل (لا استجابة)')), STALL_MS);
            };
            const fail = (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(stallTimer);
                job.abort = null;
                try { stream.destroy(); } catch (_) {}
                out.destroy();
                reject(err);
            };
            job.abort = () => fail(new Error('canceled'));
            resetStall();

            stream.on('data', (chunk) => {
                downloaded += chunk.length;
                job.done = downloaded;
                resetStall();
                const now = Date.now();
                if (now - lastEmit >= 300) {
                    const dt = (now - lastTime) / 1000;
                    if (dt > 0) {
                        const inst = (downloaded - lastBytes) / dt;
                        speed = speed ? speed * 0.6 + inst * 0.4 : inst;
                    }
                    job.speed = Math.round(speed);
                    lastBytes = downloaded; lastTime = now; lastEmit = now;
                    emit({ t: 'progress', id: job.id, done: downloaded, total: job.size, speed: job.speed });
                }
            });
            stream.on('error', fail);
            out.on('error', fail);
            out.on('finish', () => {
                if (settled) return;
                settled = true;
                clearTimeout(stallTimer);
                job.abort = null;
                resolve(downloaded);
            });
            stream.pipe(out);
        });
    }

    async function handleJob(job) {
        const dir = downloadDir();
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
            job.status = 'failed'; job.error = 'تعذّر إنشاء المجلد: ' + e.message;
            emitJobs(); return;
        }
        const partPath = path.join(dir, `.${job.id}.part`);

        if (job.size > 0) {
            const free = freeBytes(dir);
            if (free >= 0 && free < job.size * 1.05 + 20 * 1048576) {
                job.status = 'failed'; job.error = 'مساحة غير كافية في القرص';
                emitJobs(); return;
            }
        }

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (job.status === 'canceled') { safeUnlink(partPath); return; }
            job.status = 'active'; job.attempt = attempt; job.done = 0; job.speed = 0; job.error = '';
            emitJobs();

            try {
                const stream = await withTimeout(
                    job.testStream ? job.testStream() : core.downloadContent(job.docMsg, 'document'),
                    60000, 'انتهت مهلة بدء الاتصال بالملف'
                );
                await withTimeout(downloadWithProgress(job, stream, partPath), ATTEMPT_MAX_MS, 'انتهت مهلة التحميل');

                const actual = fs.statSync(partPath).size;
                if (actual === 0) throw new Error('الملف المحمّل فارغ');
                if (job.size > 0 && actual !== job.size) throw new Error(`الحجم غير مطابق (${actual} من ${job.size})`);

                const finalPath = uniquePath(dir, job.name);
                fs.renameSync(partPath, finalPath);
                const rec = { id: job.id, name: path.basename(finalPath), size: actual, path: finalPath, at: Date.now() };
                jobs.delete(job.id);
                history.unshift(rec);
                saveHistory();
                emitJobs();
                emit({ t: 'done', rec });
                if (![...jobs.values()].some((j) => j.status === 'active' || j.status === 'queued')) {
                    emit({ t: 'queueDone', name: rec.name });
                }
                return;
            } catch (err) {
                logError(err);
                safeUnlink(partPath);
                if (job.status === 'canceled' || (err && err.message === 'canceled')) {
                    jobs.delete(job.id); emitJobs(); return;
                }
                if (isExpiredError(err)) {
                    job.status = 'expired'; job.error = 'انتهت صلاحية الملف على خوادم واتساب';
                    emitJobs(); return;
                }
                job.error = err.message;
                if (attempt < MAX_ATTEMPTS) {
                    emitJobs();
                    const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)) + rand(0, 1500);
                    const until = Date.now() + wait;
                    while (Date.now() < until && job.status !== 'canceled') await sleep(300);
                }
            }
        }
        job.status = 'failed';
        emitJobs();
    }

    // ───────────── استقبال الملفات من الشات ─────────────
    const offMessage = core.onMessage((info) => {
        if (!matchesTarget(info, settings.target)) return;
        const docMsg = info.m.documentMessage;
        if (!docMsg) return;

        const name = sanitizeFileName(docMsg.fileName || `file_${Date.now()}`);
        const size = toNum(docMsg.fileLength);
        const id = `${Date.now().toString(36)}${(counter++).toString(36)}`;
        const job = { id, docMsg, name, size, from: info.jid.split('@')[0],
                      status: 'queued', done: 0, speed: 0, attempt: 0, error: '' };

        const ext = path.extname(name).slice(1).toLowerCase();
        const exts = extList();
        if (exts.length && !exts.includes(ext)) {
            job.status = 'skipped'; job.error = 'نوع الملف غير مسموح';
            jobs.set(id, job); emitJobs(); return;
        }
        if (settings.maxSizeMb > 0 && size > settings.maxSizeMb * 1048576) {
            job.status = 'skipped'; job.error = `أكبر من ${settings.maxSizeMb} MB`;
            jobs.set(id, job); emitJobs(); return;
        }
        enqueue(job);
    });

    // ───────────── الأوامر ─────────────
    async function handle(c) {
        switch (c.cmd) {
            case 'getState': return snapshot();

            case 'setPause':
                userPaused = !!c.user;
                emit({ t: 'paused', paused: userPaused });
                if (!userPaused) processQueue();
                return null;

            case 'cancel': {
                const j = jobs.get(c.id);
                if (!j) return null;
                const wasActive = j.status === 'active';
                j.status = 'canceled';
                if (wasActive && j.abort) j.abort(); else { jobs.delete(j.id); emitJobs(); }
                return null;
            }

            case 'retry': {
                const j = jobs.get(c.id);
                if (!j || (j.status !== 'failed' && j.status !== 'expired')) return null;
                j.status = 'queued'; j.error = ''; j.attempt = 0;
                queue.push(j); emitJobs(); processQueue();
                return null;
            }

            case 'clearJob': jobs.delete(c.id); emitJobs(); return null;

            case 'saveSettings': saveSettings(c.settings || {}); return null;

            case 'deleteRec': {
                const r = history.find((x) => x.id === c.id);
                if (r) { safeUnlink(r.path); history = history.filter((x) => x.id !== c.id); saveHistory(); }
                return null;
            }

            case 'recPath': {
                const r = history.find((x) => x.id === c.id);
                return r ? r.path : null;
            }

            case 'downloadDir': return downloadDir();

            default: return null;
        }
    }

    function shutdown() {
        userPaused = true;
        for (const j of jobs.values()) { j.status = 'canceled'; if (j.abort) { try { j.abort(); } catch (_) {} } }
        offMessage();
    }

    return {
        handle, shutdown, snapshot,
        _test: {
            enqueue, jobs,
            get history() { return history; },
            setHistory(h) { history = h; saveHistory(); }
        }
    };
}

module.exports = { createEngine, cleanFolderName };
