'use strict';
// ────────────────────────────────────────────────────────────────
// محرك المشاهدة في WA Hub 3 (Windows / Linux)
// يستقبل الأجزاء من واتساب ويحفظها نهائياً داخل «غرف» منظمة في أقسام
// (userData/rooms/<roomId>/ + rooms.json)، والتشغيل يتم فقط بضغط
// المستخدم عبر mpv كقائمة متسلسلة بترتيب الأجزاء الرقمي.
// ────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { MpvPlayer, findMpv, splitArgs } = require('./player');

const { matchesTarget } = require('./core');

// ───────────────────────── ثوابت ─────────────────────────
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 30000;
const STALL_MS = 25000;
const ATTEMPT_MAX_MS = 20 * 60 * 1000;
const COMPLETED_TTL_MS = 10 * 60 * 60 * 1000;   // 10 ساعات
const INBOX_ID = 'inbox';
const INBOX_NAME = 'غير مصنّف';

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
    if (!n) n = `part_${Date.now()}`;
    if (n.length > 120) {
        const ext = path.extname(n).slice(0, 15);
        n = n.slice(0, 120 - ext.length) + ext;
    }
    return n;
}

function safeUnlink(p) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} }

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

const numRe = /(\d+)(?!.*\d)/;

/** رقم الجزء من الاسم: strict = ترقيم تسلسلي صالح، وإلا يُرتَّب بوقت الوصول */
function keyFor(name, tsMs) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const m = numRe.exec(base);
    const n = m && m[1].length <= 18 ? parseInt(m[1], 10) : NaN;
    if (Number.isFinite(n)) return { key: n, strict: n < 1e9 };
    return { key: tsMs, strict: false };
}

/**
 * تحليل اسم ملف وارد لتحديد غرفته:
 * يُجرَّد الرقم الأخير (مع كلمة part/pt/جزء أو فاصل) فيبقى الاسم الأساسي.
 * → { baseName, num|null, hasNum }
 */
function parseIntake(name) {
    const raw = String(name || '');
    // نمط file.mp4.001
    const dotNum = /^(.+)\.(\d{2,4})$/.exec(raw);
    if (dotNum) {
        const inner = dotNum[1];
        const d = inner.lastIndexOf('.');
        const baseName = (d > 0 ? inner.slice(0, d) : inner).trim();
        if (baseName) return { baseName, num: parseInt(dotNum[2], 10), hasNum: true };
    }
    const dot = raw.lastIndexOf('.');
    const stem = dot > 0 ? raw.slice(0, dot) : raw;
    const m = /^(.*?)[\s._-]*(?:part|pt|جزء)?[\s._-]*(\d+)$/i.exec(stem);
    if (m) {
        const baseName = m[1].replace(/[ ._-]+$/, '').trim();
        // لا نعتبر الاسم رقماً وحده غرفة مرقّمة، ولا أسماء قصيرة جداً بلا فاصل واضح
        if (baseName && (m[0].length > baseName.length)) {
            return { baseName, num: parseInt(m[2], 10), hasNum: true };
        }
    }
    return { baseName: stem.trim() || raw, num: null, hasNum: false };
}

// ───────────────────────── الأوامر النصية من الشات ─────────────────────────
function parseChatCommand(text) {
    const t = String(text || '').trim();
    if (!/^[!\/]/.test(t)) return null;
    const parts = t.slice(1).trim().split(/\s+/);
    const w = (parts[0] || '').toLowerCase();
    const arg = parts[1];
    const map = {
        pause: 'pause', 'ايقاف': 'pause', 'إيقاف': 'pause', 'وقف': 'pause',
        play: 'play', resume: 'play', 'تشغيل': 'play', 'استئناف': 'play',
        next: 'next', skip: 'next', 'تخطي': 'next', 'تخطّي': 'next', 'التالي': 'next',
        fs: 'fs', fullscreen: 'fs', 'شاشة': 'fs', 'ملء': 'fs',
        speed: 'speed', 'سرعة': 'speed', 'تسريع': 'speed',
        vol: 'vol', volume: 'vol', 'صوت': 'vol',
        status: 'status', 'حالة': 'status'
    };
    const cmd = map[w];
    if (!cmd) return null;
    const n = arg !== undefined ? parseFloat(arg.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))) : NaN;
    return { cmd, arg: Number.isFinite(n) ? n : null };
}

// ───────────────────────── المحرك ─────────────────────────
function createEngine({ dataDir, downloadsDir, resourcesDir, core, emit: emitCb }) {
    const SETTINGS_FILE = path.join(dataDir, 'settings.json');
    const STAGE_DIR = path.join(dataDir, 'stream');
    const ROOMS_DIR = path.join(dataDir, 'rooms');
    const ROOMS_FILE = path.join(dataDir, 'rooms.json');
    const ERROR_LOG = path.join(dataDir, 'engine-errors.log');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(STAGE_DIR, { recursive: true });
    fs.mkdirSync(ROOMS_DIR, { recursive: true });
    // بقايا تحميل مؤقتة من جلسة سابقة (الأجزاء المحفوظة في الغرف لا تُمسّ)
    try { for (const f of fs.readdirSync(STAGE_DIR)) safeUnlink(path.join(STAGE_DIR, f)); } catch (_) {}

    function logError(err) {
        try { fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${(err && err.stack) || err}\n`); } catch (_) {}
    }

    const logs = [];
    function emit(o) { try { emitCb(o); } catch (_) {} }
    function log(msg) { logs.push(String(msg)); if (logs.length > 150) logs.shift(); emit({ t: 'log', msg: String(msg) }); }

    // ── الإعدادات ──
    const defaults = {
        startFullscreen: false,
        speed: 1,
        volume: 100,
        gapMin: 1,
        gapMax: 3,
        target: '',
        chatCommands: true,
        chatReply: false,
        mpvPath: '',
        mpvArgs: ''
    };
    let settings = { ...defaults };
    try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (_) {}
    // إعدادات البث المباشر القديمة لم تعد مستخدمة في نموذج الغرف
    for (const k of ['bufferSize', 'rebufferSize', 'maxWaitSec', 'idleStartSec', 'deleteAfterPlay', 'saveDir', 'autoCatchUp', 'catchUpThreshold', 'catchUpSpeed']) delete settings[k];

    function saveSettings(patch) {
        const p = { ...patch };
        for (const k of ['gapMin', 'gapMax', 'volume']) if (k in p) p[k] = Math.max(0, Math.round(Number(p[k]) || 0));
        if ('speed' in p) p.speed = Math.min(4, Math.max(0.25, Number(p.speed) || 1));
        if ('target' in p) p.target = String(p.target || '').replace(/[^0-9]/g, '');
        settings = { ...settings, ...p };
        if (settings.gapMax < settings.gapMin) settings.gapMax = settings.gapMin;
        try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) { logError(e); }
        emit({ t: 'settings', settings, mpv: mpvInfo() });
        if ('speed' in p) applySpeed();
        if ('volume' in p && player && player.alive) player.setProp('volume', settings.volume).catch(() => {});
    }

    const mpvInfo = () => {
        const p = findMpv(settings.mpvPath, resourcesDir);
        return { found: !!p, path: p || '' };
    };

    // ───────────── مخزن الغرف والأقسام ─────────────
    let store = { sections: [], rooms: [] };
    try {
        const raw = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
        if (raw && Array.isArray(raw.sections) && Array.isArray(raw.rooms)) store = raw;
    } catch (_) {}
    if (!store.sections.some((s) => s.id === INBOX_ID)) {
        store.sections.unshift({ id: INBOX_ID, name: INBOX_NAME, createdAt: Date.now() });
    }
    for (const r of store.rooms) {
        if (!r.id || !r.name) continue;
        if (!store.sections.some((s) => s.id === r.sectionId)) r.sectionId = INBOX_ID;
        r.favorite = !!r.favorite;
        r.receiving = !!r.receiving;
        if (r.completedAt === undefined) r.completedAt = null;
        if (!Array.isArray(r.parts)) r.parts = [];
        // إسقاط أجزاء اختفت ملفاتها من القرص
        r.parts = r.parts.filter((pt) => pt && pt.path && fs.existsSync(pt.path));
    }
    store.rooms = store.rooms.filter((r) => r.id && r.name);
    // غرفة استقبال واحدة على الأكثر
    let seenReceiving = false;
    for (const r of store.rooms) { if (r.receiving) { if (seenReceiving) r.receiving = false; seenReceiving = true; } }

    let roomCounter = 0;
    const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${(roomCounter++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

    function saveStore() {
        try { fs.writeFileSync(ROOMS_FILE, JSON.stringify(store, null, 2)); } catch (e) { logError(e); }
        emitRooms();
    }

    function sortedParts(room) {
        return [...room.parts].sort((a, b) => {
            if (a.hasNum && b.hasNum) return (a.orderKey - b.orderKey) || (a.seq - b.seq);
            if (a.hasNum) return -1;
            if (b.hasNum) return 1;
            return a.seq - b.seq;
        });
    }

    function pubRoom(r) {
        const parts = sortedParts(r);
        const totalSize = parts.reduce((a, p) => a + (p.size || 0), 0);
        let remainingMs = null;
        if (r.completedAt && !r.favorite) remainingMs = Math.max(0, COMPLETED_TTL_MS - (Date.now() - r.completedAt));
        return {
            id: r.id, name: r.name, sectionId: r.sectionId, favorite: !!r.favorite,
            createdAt: r.createdAt, completedAt: r.completedAt || null, receiving: !!r.receiving,
            parts: parts.map((p) => ({ name: p.name, path: p.path, orderKey: p.orderKey, size: p.size || 0, hasNum: !!p.hasNum })),
            partsCount: parts.length, totalSize, remainingMs
        };
    }

    function pubSections() {
        return store.sections.map((s) => {
            const rooms = store.rooms.filter((r) => r.sectionId === s.id);
            return {
                id: s.id, name: s.name, createdAt: s.createdAt,
                roomCount: rooms.length,
                totalSize: rooms.reduce((a, r) => a + r.parts.reduce((x, p) => x + (p.size || 0), 0), 0)
            };
        });
    }

    function roomsState() {
        const favs = store.rooms.filter((r) => r.favorite);
        return {
            sections: pubSections(),
            rooms: store.rooms.map(pubRoom),
            favoritesCount: favs.length,
            favoritesSize: favs.reduce((a, r) => a + r.parts.reduce((x, p) => x + (p.size || 0), 0), 0),
            receivingId: (store.rooms.find((r) => r.receiving) || {}).id || null,
            openRoomId
        };
    }
    const emitRooms = () => emit({ t: 'rooms', roomsState: roomsState() });

    function createRoomRecord(name, sectionId) {
        const room = {
            id: newId('room'), name: String(name || 'غرفة').slice(0, 120),
            sectionId: store.sections.some((s) => s.id === sectionId) ? sectionId : INBOX_ID,
            favorite: false, createdAt: Date.now(), completedAt: null, receiving: false, parts: []
        };
        store.rooms.unshift(room);
        try { fs.mkdirSync(path.join(ROOMS_DIR, room.id), { recursive: true }); } catch (_) {}
        return room;
    }

    function deleteRoomRecord(room) {
        for (const p of room.parts) safeUnlink(p.path);
        try { fs.rmSync(path.join(ROOMS_DIR, room.id), { recursive: true, force: true }); } catch (_) {}
        store.rooms = store.rooms.filter((r) => r.id !== room.id);
        if (openRoomId === room.id) openRoomId = null;
    }

    /** حذف الغرف المكتملة غير المفضلة بعد 10 ساعات. يعيد عدد المحذوف. */
    function cleanupExpired() {
        const now = Date.now();
        const expired = store.rooms.filter((r) => r.completedAt && !r.favorite && now - r.completedAt >= COMPLETED_TTL_MS);
        for (const r of expired) { deleteRoomRecord(r); log(`حُذفت الغرفة «${r.name}» بعد 10 ساعات من إكمالها`); }
        if (expired.length) saveStore();
        return expired.length;
    }

    // ───────────── المشغّل ─────────────
    let player = null;
    let playerState = { paused: false, speed: 1, fullscreen: false, volume: 100 };
    let openRoomId = null;
    let nowName = '';
    let playedCount = 0;

    function playerStatus() {
        return {
            openRoomId, now: nowName, played: playedCount,
            player: { running: !!(player && player.alive), ...playerState }
        };
    }
    const emitPlayer = () => emit({ t: 'stream', s: playerStatus() });

    async function ensurePlayer() {
        if (player && player.alive) return player;
        const exe = findMpv(settings.mpvPath, resourcesDir);
        if (!exe) {
            emit({ t: 'playerError', msg: 'لم يتم العثور على mpv. على لينكس ثبّته (sudo apt install mpv) أو حدّد مساره من الإعدادات.' });
            throw new Error('mpv not found');
        }
        const p = new MpvPlayer(exe, splitArgs(settings.mpvArgs), { fullscreen: settings.startFullscreen });
        p.on('started', ({ entryId }) => {
            const seg = entryId != null ? fedPaths.get(entryId) : null;
            if (seg) { nowName = seg; emitPlayer(); }
        });
        p.on('ended', ({ reason }) => {
            if (reason !== 'error') playedCount++;
            emitPlayer();
        });
        p.on('state', (st) => { playerState = { ...playerState, ...st }; emitPlayer(); });
        p.on('exit', () => {
            if (player !== p) return;
            player = null; nowName = '';
            emit({ t: 'playerClosed' });
            emitPlayer();
        });
        try {
            await p.start();
        } catch (e) {
            logError(e);
            emit({ t: 'playerError', msg: 'تعذّر تشغيل mpv: ' + e.message });
            try { p.proc && p.proc.kill(); } catch (_) {}
            throw e;
        }
        player = p;
        emit({ t: 'playerError', msg: '' });
        playerState = { ...playerState, ...p.state };
        p.setProp('volume', settings.volume).catch(() => {});
        p.setProp('speed', settings.speed).catch(() => {});
        return p;
    }
    const fedPaths = new Map();   // entryId → اسم الجزء

    /** تشغيل غرفة كاملة كقائمة متسلسلة — لا يُستدعى إلا بضغط المستخدم */
    async function playRoom(id) {
        const room = store.rooms.find((r) => r.id === id);
        if (!room) return false;
        const parts = sortedParts(room).filter((p) => fs.existsSync(p.path));
        if (!parts.length) { emit({ t: 'playerError', msg: 'هذه الغرفة فارغة — لا توجد أجزاء للتشغيل.' }); return false; }
        openRoomId = room.id;
        const p = await ensurePlayer();
        fedPaths.clear();
        try { await p.command(['playlist-clear']); } catch (_) {}
        for (const part of parts) {
            try {
                const entryId = await p.append(part.path);
                if (entryId !== null && entryId !== undefined) fedPaths.set(entryId, part.name);
            } catch (e) { logError(e); break; }
        }
        nowName = parts[0].name;
        emitPlayer(); emitRooms();
        return true;
    }

    function applySpeed() {
        if (player && player.alive) player.setProp('speed', settings.speed).catch(() => {});
    }

    // ───────────── توزيع جزء واصل على غرفة ─────────────
    let partSeq = 0;
    for (const r of store.rooms) for (const p of r.parts) partSeq = Math.max(partSeq, (p.seq || 0) + 1);

    function assignPart({ name, size, stagePath, seq }) {
        // ① غرفة الاستقبال إن وُجدت
        let room = store.rooms.find((r) => r.receiving) || null;
        const parsed = parseIntake(name);
        if (!room) {
            // ②/③ البحث بالاسم الأساسي أو إنشاء غرفة في «غير مصنّف»
            const wanted = parsed.baseName.toLowerCase();
            room = store.rooms.find((r) => r.name.toLowerCase() === wanted) || null;
            if (!room) room = createRoomRecord(parsed.baseName, INBOX_ID);
        }
        const dir = path.join(ROOMS_DIR, room.id);
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
        const finalPath = uniquePath(dir, name);
        try { fs.renameSync(stagePath, finalPath); }
        catch (_) { fs.copyFileSync(stagePath, finalPath); safeUnlink(stagePath); }
        const actual = (() => { try { return fs.statSync(finalPath).size; } catch (_) { return size || 0; } })();
        room.parts.push({
            name: path.basename(finalPath), path: finalPath,
            orderKey: parsed.hasNum ? parsed.num : seq, size: actual,
            hasNum: parsed.hasNum, seq, at: Date.now()
        });
        saveStore();
        log(`وصل جزء «${name}» إلى غرفة «${room.name}»`);
        // جزء جديد للغرفة المفتوحة أثناء التشغيل: يُلحق بنهاية القائمة
        if (openRoomId === room.id && player && player.alive) {
            player.append(finalPath).then((entryId) => {
                if (entryId !== null && entryId !== undefined) fedPaths.set(entryId, path.basename(finalPath));
            }).catch((e) => logError(e));
        }
        return room;
    }

    // ───────────── مهام التحميل ─────────────
    const jobs = new Map();
    const queue = [];
    let running = false;
    let userPaused = false;
    let counter = 0;

    const pubJob = (j) => ({
        id: j.id, name: j.name, size: j.size, from: j.from, status: j.status,
        done: j.done || 0, speed: j.speed || 0, attempt: j.attempt || 0, error: j.error || ''
    });
    const emitJobs = () => emit({ t: 'jobs', jobs: [...jobs.values()].map(pubJob) });

    function enqueue(job) {
        jobs.set(job.id, job);
        queue.push(job);
        emitJobs();
        processQueue();
    }

    function pickNext() {
        queue.sort((a, b) => (a.strict && b.strict ? a.key - b.key : a.seq - b.seq));
        return queue.shift();
    }

    async function processQueue() {
        if (running) return;
        running = true;
        try {
            while (!userPaused && queue.length > 0) {
                const job = pickNext();
                if (job.status === 'canceled') continue;
                await handleJob(job);
                if (!userPaused && queue.length > 0) {
                    const lo = Math.max(0, settings.gapMin), hi = Math.max(lo, settings.gapMax);
                    const until = Date.now() + rand(lo * 1000, hi * 1000);
                    while (Date.now() < until && !userPaused) await sleep(200);
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
        const partPath = path.join(STAGE_DIR, `${job.id}.part`);
        const stageFinal = path.join(STAGE_DIR, `${job.id}_${job.name}`);

        if (job.size > 0) {
            const free = freeBytes(STAGE_DIR);
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
                    job.testStream ? job.testStream() : core.downloadContent(job.media, job.mediaType),
                    60000, 'انتهت مهلة بدء الاتصال بالملف'
                );
                await withTimeout(downloadWithProgress(job, stream, partPath), ATTEMPT_MAX_MS, 'انتهت مهلة التحميل');

                const actual = fs.statSync(partPath).size;
                if (actual === 0) throw new Error('الملف المحمّل فارغ');
                if (job.size > 0 && actual !== job.size) throw new Error(`الحجم غير مطابق (${actual} من ${job.size})`);

                fs.renameSync(partPath, stageFinal);
                jobs.delete(job.id);
                emitJobs();
                assignPart({ name: job.name, size: actual, stagePath: stageFinal, seq: job.seq });
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
                    const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)) + rand(0, 1000);
                    const until = Date.now() + wait;
                    while (Date.now() < until && job.status !== 'canceled') await sleep(200);
                }
            }
        }
        job.status = 'failed';
        emitJobs();
    }

    function snapshot() {
        cleanupExpired();
        return {
            paused: userPaused,
            jobs: [...jobs.values()].map(pubJob), settings,
            stream: playerStatus(), mpv: mpvInfo(), roomsState: roomsState()
        };
    }

    // ───────────── استقبال الأجزاء والأوامر من الشات ─────────────
    const offMessage = core.onMessage((info) => {
        if (!matchesTarget(info, settings.target)) return;
        const m = info.m;

        const text = m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '';
        if (text && settings.chatCommands) {
            const c = parseChatCommand(text);
            if (c && (info.fromMe || settings.target)) { runCommand(c, info.jid); return; }
        }

        let media = null, mediaType = '', name = '', size = 0;
        if (m.documentMessage) {
            media = m.documentMessage; mediaType = 'document';
            name = sanitizeFileName(media.fileName || `part_${Date.now()}`);
            size = toNum(media.fileLength);
        } else if (m.videoMessage) {
            media = m.videoMessage; mediaType = 'video';
            const cap = String(media.caption || '').trim();
            name = sanitizeFileName((cap || `video_${Date.now()}`).replace(/\s+/g, '_'));
            if (!/\.[a-z0-9]{2,4}$/i.test(name)) name += '.mp4';
            size = toNum(media.fileLength);
        }
        if (!media) return;

        const { key, strict: st } = keyFor(name, (info.ts || Math.floor(Date.now() / 1000)) * 1000);
        const id = `${Date.now().toString(36)}${(counter++).toString(36)}`;
        enqueue({
            id, media, mediaType, name, size, key, strict: st, seq: partSeq++,
            from: info.jid.split('@')[0],
            status: 'queued', done: 0, speed: 0, attempt: 0, error: ''
        });
    });
    const offDiag = core.addDiag(() => {
        const mpv = mpvInfo();
        core.log(mpv.found ? 'mpv ✓ ' + mpv.path : 'mpv ✗ غير موجود');
    });

    // ───────────── أوامر التحكم بالمشغّل ─────────────
    async function control(c, arg) {
        switch (c) {
            case 'pause': if (player && player.alive) await player.setProp('pause', true); break;
            case 'play': if (player && player.alive) await player.setProp('pause', false); break;
            case 'togglePause':
                if (player && player.alive) await player.command(['cycle', 'pause']);
                break;
            case 'next': if (player && player.alive) await player.command(['playlist-next']); break;
            case 'fs': if (player && player.alive) await player.command(['cycle', 'fullscreen']); break;
            case 'speed':
                if (arg) saveSettings({ speed: arg });
                break;
            case 'vol':
                if (arg !== null && arg !== undefined) saveSettings({ volume: Math.min(130, Math.max(0, arg)) });
                break;
            case 'open':
                if (openRoomId) await playRoom(openRoomId);
                break;
            case 'closePlayer': if (player && player.alive) await player.quit(); break;
            default: break;
        }
        emitPlayer();
    }

    function runCommand(c, jid) {
        log(`أمر من الشات: ${c.cmd}${c.arg !== null ? ' ' + c.arg : ''}`);
        const map = { pause: 'pause', play: 'play', next: 'next', fs: 'fs', speed: 'speed', vol: 'vol' };
        if (c.cmd === 'status') {
            if (settings.chatReply && jid) {
                const totalParts = store.rooms.reduce((a, r) => a + r.parts.length, 0);
                const txt = `WA Hub 3 — مشاهدة\nغرف: ${store.rooms.length} • أجزاء محفوظة: ${totalParts}${nowName ? '\nالآن: ' + nowName : ''}`;
                core.sendText(jid, txt).catch(() => {});
            }
            return;
        }
        control(map[c.cmd], c.arg).catch((e) => logError(e));
    }

    // فحص العشر ساعات عند بدء المحرك ثم كل دقيقة
    cleanupExpired();
    const tickTimer = setInterval(() => { cleanupExpired(); }, 60000);

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
            case 'control': await control(c.what, c.arg); return null;
            case 'mpvInfo': return mpvInfo();
            case 'checkCleanup': cleanupExpired(); return roomsState();

            // ── الأقسام ──
            case 'createSection': {
                const name = String(c.name || '').trim().slice(0, 60);
                if (!name) return null;
                store.sections.push({ id: newId('sec'), name, createdAt: Date.now() });
                saveStore(); return roomsState();
            }
            case 'renameSection': {
                const sec = store.sections.find((s) => s.id === c.id);
                const name = String(c.name || '').trim().slice(0, 60);
                if (sec && name) { sec.name = name; saveStore(); }
                return roomsState();
            }
            case 'deleteSection': {
                if (c.id === INBOX_ID) return roomsState();   // «غير مصنّف» لا يُحذف
                if (!store.sections.some((s) => s.id === c.id)) return roomsState();
                store.sections = store.sections.filter((s) => s.id !== c.id);
                for (const r of store.rooms) if (r.sectionId === c.id) r.sectionId = INBOX_ID;
                saveStore(); return roomsState();
            }

            // ── الغرف ──
            case 'createRoom': {
                const name = String(c.name || '').trim().slice(0, 120);
                if (!name) return null;
                createRoomRecord(name, c.sectionId || INBOX_ID);
                saveStore(); return roomsState();
            }
            case 'renameRoom': {
                const room = store.rooms.find((r) => r.id === c.id);
                const name = String(c.name || '').trim().slice(0, 120);
                if (room && name) { room.name = name; saveStore(); }
                return roomsState();
            }
            case 'deleteRoom': {
                const room = store.rooms.find((r) => r.id === c.id);
                if (room) { deleteRoomRecord(room); saveStore(); }
                return roomsState();
            }
            case 'setFavorite': {
                const room = store.rooms.find((r) => r.id === c.id);
                if (room) { room.favorite = c.favorite !== undefined ? !!c.favorite : !room.favorite; saveStore(); }
                return roomsState();
            }
            case 'moveRoom': {
                const room = store.rooms.find((r) => r.id === c.id);
                if (room && store.sections.some((s) => s.id === c.sectionId)) { room.sectionId = c.sectionId; saveStore(); }
                return roomsState();
            }
            case 'setReceiving': {
                const room = store.rooms.find((r) => r.id === c.id);
                if (room) {
                    const turnOn = !room.receiving;
                    for (const r of store.rooms) r.receiving = false;
                    room.receiving = turnOn;
                    saveStore();
                }
                return roomsState();
            }
            case 'completeRoom': {
                const room = store.rooms.find((r) => r.id === c.id);
                if (room && !room.completedAt) { room.completedAt = Date.now(); saveStore(); }
                return roomsState();
            }
            case 'uncompleteRoom': {
                const room = store.rooms.find((r) => r.id === c.id);
                if (room && room.completedAt) { room.completedAt = null; saveStore(); }
                return roomsState();
            }
            case 'playRoom': await playRoom(c.id); return roomsState();

            default: return null;
        }
    }

    function shutdown() {
        userPaused = true;
        for (const j of jobs.values()) { j.status = 'canceled'; if (j.abort) { try { j.abort(); } catch (_) {} } }
        clearInterval(tickTimer);
        offMessage(); offDiag();
        try { if (player && player.alive) player.quit(); } catch (_) {}
        // الغرف وأجزاؤها محفوظة نهائياً — تُحذف فقط ملفات التحميل المؤقتة
        try { for (const f of fs.readdirSync(STAGE_DIR)) safeUnlink(path.join(STAGE_DIR, f)); } catch (_) {}
    }

    return {
        handle, shutdown, snapshot,
        _test: { enqueue, jobs, saveSettings, runCommand, keyFor, parseIntake, roomsState, cleanupExpired, assignPart }
    };
}

module.exports = { createEngine, parseChatCommand, keyFor, parseIntake };

