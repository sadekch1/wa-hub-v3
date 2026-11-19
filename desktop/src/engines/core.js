'use strict';
// ────────────────────────────────────────────────────────────────
// نواة واتساب المشتركة: تسجيل الدخول مرة واحدة + اتصال واحد دائم.
// الرسائل الواردة تُوزَّع على الوضع النشط (مشاهدة أو تحميل).
// ────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

let P = null, baileys = {}, loadError = null;
try {
    P = require('pino');
    baileys = require('@whiskeysockets/baileys');
} catch (e) { loadError = e; }

const makeWASocket = baileys.makeWASocket || baileys.default;
const {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason = {}
} = baileys;

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

function withTimeout(promise, ms, message) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function unwrap(message) {
    let m = message;
    for (let i = 0; i < 4 && m; i++) {
        if (m.ephemeralMessage) m = m.ephemeralMessage.message;
        else if (m.viewOnceMessage) m = m.viewOnceMessage.message;
        else if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
        else if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
        else break;
    }
    return m || {};
}

/** هل الرسالة من المحادثة المحددة؟ (فارغ = الكل) */
function matchesTarget(info, target) {
    if (!target) return true;
    if (info.fromMe) return true;
    if (info.jids.some((j) => j.includes(target))) return true;
    return info.jids.some((j) => j.endsWith('@lid'));
}

function createCore({ authDir, dataDir, emit: emitCb }) {
    fs.mkdirSync(dataDir, { recursive: true });
    const ERROR_LOG = path.join(dataDir, 'core-errors.log');
    const BOOT_TIME = Math.floor(Date.now() / 1000);

    function logError(err) {
        try { fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${(err && err.stack) || err}\n`); } catch (_) {}
    }
    if (loadError) logError(loadError);

    const logs = [];
    function emit(o) { try { emitCb(o); } catch (_) {} }
    function log(msg) { logs.push(String(msg)); if (logs.length > 150) logs.shift(); emit({ t: 'log', msg: String(msg) }); }

    let conn = 'idle';
    let pairingCode = '';
    let currentSock = null;
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    let pairingPhone = null;
    let pairTries = 0;
    let stopReconnect = false;
    let pairTimer = null;

    const handlers = new Set();
    const seenIds = new Set();
    const diagHooks = new Set();

    function isRegistered() {
        try { return !!JSON.parse(fs.readFileSync(path.join(authDir, 'creds.json'), 'utf8')).registered; }
        catch (_) { return false; }
    }
    function setConn(c) { conn = c; emit({ t: 'state', conn: c, registered: isRegistered() }); }

    /** الجزء المشترك من حالة الواجهة */
    function base() {
        return {
            conn, registered: isRegistered(), code: pairingCode,
            fatal: loadError ? `فشل تحميل مكتبة واتساب: ${loadError.message}` : '', logs
        };
    }

    function destroySock(s) {
        if (!s) return;
        for (const ev of ['connection.update', 'messages.upsert', 'creds.update']) { try { s.ev.removeAllListeners(ev); } catch (_) {} }
        try { s.end(undefined); } catch (_) {}
    }

    function scheduleReconnect(fast = false) {
        if (reconnectTimer || stopReconnect) return;
        reconnectAttempts++;
        const delayMs = fast ? 1000 : Math.min(RECONNECT_MAX, RECONNECT_BASE * 2 ** (reconnectAttempts - 1)) + rand(0, 1000);
        setConn('reconnecting');
        log(`إعادة الاتصال بعد ${(delayMs / 1000).toFixed(1)}ث (محاولة ${reconnectAttempts})`);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect().catch((e) => { logError(e); scheduleReconnect(); });
        }, delayMs);
    }

    async function connect() {
        destroySock(currentSock);
        stopReconnect = false;
        setConn('connecting');

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        let version;
        try { ({ version } = await fetchLatestBaileysVersion()); } catch (e) { logError(e); }

        const sock = makeWASocket({
            auth: state,
            ...(version ? { version } : {}),
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            logger: P({ level: 'silent' })
        });
        currentSock = sock;
        const isCurrent = () => sock === currentSock;
        sock.ev.on('creds.update', saveCreds);

        let codeRequested = false;
        async function requestCode() {
            if (codeRequested || !pairingPhone || sock.authState.creds.registered) return;
            codeRequested = true;
            try {
                await sleep(1500);
                if (!isCurrent()) return;
                const code = await sock.requestPairingCode(pairingPhone);
                pairingCode = code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : String(code);
                clearTimeout(pairTimer);
                emit({ t: 'code', code: pairingCode });
                log('تم الحصول على رمز الربط — أدخله في واتساب');
                setConn('pairing');
            } catch (err) {
                logError(err);
                pairTries++;
                log(`فشل طلب الرمز (${pairTries}/${PAIR_MAX_TRIES}): ${err.message}`);
                if (pairTries >= PAIR_MAX_TRIES) {
                    pairingPhone = null;
                    emit({ t: 'error', msg: 'تعذّر الحصول على رمز الربط. تحقق من الإنترنت والرقم ثم أعد المحاولة.' });
                    setConn('needpair');
                    return;
                }
                try { sock.end(undefined); } catch (_) {}
                if (isCurrent()) scheduleReconnect();
            }
        }

        sock.ev.on('connection.update', (update) => {
            if (!isCurrent()) return;
            const { connection, lastDisconnect, qr } = update;
            if (qr) { log('وصل الاتصال بواتساب — جارٍ طلب رمز الربط'); requestCode(); }

            if (connection === 'open') {
                reconnectAttempts = 0; pairingPhone = null; pairingCode = '';
                setConn('open');
            }
            if (connection === 'close') {
                const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
                    ? lastDisconnect.error.output.statusCode : undefined;
                log(`انقطع الاتصال: code=${code} ${(lastDisconnect && lastDisconnect.error && lastDisconnect.error.message) || ''}`);

                if (code === DisconnectReason.loggedOut) {
                    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (_) {}
                    if (pairingPhone && pairTries < PAIR_MAX_TRIES) {
                        pairTries++;
                        log(`لم يُقبل الرمز أو انتهت صلاحيته (${pairTries}/${PAIR_MAX_TRIES}) — رمز جديد...`);
                        scheduleReconnect(true);
                        return;
                    }
                    pairingPhone = null;
                    setConn('loggedout');
                    return;
                }
                if (code === DisconnectReason.connectionReplaced) {
                    stopReconnect = true;
                    setConn('replaced');
                    return;
                }
                scheduleReconnect(code === DisconnectReason.restartRequired);
            }
        });

        sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (!isCurrent() || type !== 'notify') return;
            const sorted = [...messages].sort((a, b) => toNum(a.messageTimestamp) - toNum(b.messageTimestamp));
            for (const msg of sorted) {
                if (!msg.message) continue;
                const ts = toNum(msg.messageTimestamp);
                if (ts && ts < BOOT_TIME - BOOT_TOLERANCE) continue;
                const mid = msg.key.id;
                if (mid) { if (seenIds.has(mid)) continue; seenIds.add(mid); }

                const info = {
                    msg, ts, m: unwrap(msg.message),
                    fromMe: !!msg.key.fromMe,
                    jid: msg.key.remoteJid || '',
                    jids: [msg.key.remoteJid, msg.key.remoteJidAlt, msg.key.participant, msg.key.participantAlt].filter(Boolean)
                };
                for (const h of handlers) { try { h(info); } catch (e) { logError(e); } }
            }
        });
    }

    async function runDiag() {
        log(`— فحص —  Node ${process.version} ${process.platform}/${process.arch}`);
        const dns = require('dns');
        try {
            const addr = await new Promise((res, rej) => dns.lookup('web.whatsapp.com', (e, a) => (e ? rej(e) : res(a))));
            log('DNS ✓ ' + addr);
        } catch (e) { log('DNS ✗ ' + (e.code || '') + ' ' + e.message); }
        try {
            await new Promise((res, rej) => {
                const tls = require('tls');
                const s = tls.connect({ host: 'web.whatsapp.com', port: 443, servername: 'web.whatsapp.com' }, () => {
                    log(`TLS ✓ ${s.getProtocol()} authorized=${s.authorized}${s.authorizationError ? ' ' + s.authorizationError : ''}`);
                    s.end(); res();
                });
                s.on('error', rej);
                s.setTimeout(10000, () => s.destroy(new Error('timeout')));
            });
        } catch (e) { log('TLS ✗ ' + e.message); }
        try {
            const v = await withTimeout(fetchLatestBaileysVersion(), 15000, 'timeout');
            log('نسخة واتساب: ' + JSON.stringify(v).slice(0, 160));
        } catch (e) { log('جلب النسخة ✗ ' + e.message); }
        for (const h of diagHooks) { try { h(); } catch (_) {} }
        log('— انتهى الفحص —');
    }

    /** أوامر الاتصال: connect / pair / logout / diag  (تعيد true إذا عالجها) */
    async function handle(c) {
        if (loadError && ['connect', 'pair', 'diag'].includes(c.cmd)) {
            emit({ t: 'error', msg: `فشل تحميل مكتبة واتساب: ${loadError.message}` });
            return true;
        }
        switch (c.cmd) {
            case 'connect':
                if (currentSock) { emit({ t: 'state', conn, registered: isRegistered() }); return true; }
                if (isRegistered()) await connect(); else setConn('needpair');
                return true;

            case 'pair': {
                const phone = String(c.phone || '').replace(/[^0-9]/g, '');
                if (phone.length < 8) { emit({ t: 'error', msg: 'رقم غير صالح' }); return true; }
                destroySock(currentSock); currentSock = null;
                clearTimeout(reconnectTimer); reconnectTimer = null;
                try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (_) {}
                pairingPhone = phone; pairTries = 0; pairingCode = ''; reconnectAttempts = 0;
                clearTimeout(pairTimer);
                pairTimer = setTimeout(() => {
                    if (pairingPhone && !pairingCode) emit({ t: 'error', msg: 'لم يتم الاتصال بواتساب خلال 40 ثانية. اضغط «فحص الاتصال» لمعرفة السبب.' });
                }, 40000);
                log('بدء الربط…');
                await connect();
                return true;
            }

            case 'diag': await runDiag(); return true;

            case 'logout':
                try { if (currentSock) await currentSock.logout(); } catch (_) {}
                destroySock(currentSock); currentSock = null;
                clearTimeout(reconnectTimer); reconnectTimer = null;
                try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (_) {}
                pairingPhone = null; pairingCode = '';
                setConn('needpair');
                return true;

            default: return false;
        }
    }

    function shutdown() {
        clearTimeout(reconnectTimer); clearTimeout(pairTimer);
        destroySock(currentSock);
        currentSock = null;
    }

    return {
        handle, base, shutdown, log, logError, isRegistered,
        onMessage(fn) { handlers.add(fn); return () => handlers.delete(fn); },
        addDiag(fn) { diagHooks.add(fn); return () => diagHooks.delete(fn); },
        sendText(jid, text) { return currentSock ? currentSock.sendMessage(jid, { text }) : Promise.resolve(); },
        get downloadContent() { return baileys.downloadContentFromMessage; },
        _dispatch(info) { for (const h of handlers) { try { h(info); } catch (e) { logError(e); } } }
    };
}

module.exports = { createCore, matchesTarget, toNum };
