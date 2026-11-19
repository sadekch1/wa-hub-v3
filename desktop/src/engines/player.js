'use strict';
// ────────────────────────────────────────────────────────────────
// تحكم بـ mpv عبر JSON IPC
//   Windows: named pipe   |   Linux/macOS: unix socket
// ────────────────────────────────────────────────────────────────
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

function findMpv(custom, resourcesDir) {
    const exeName = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
    const cands = [];
    if (custom) cands.push(custom);
    if (resourcesDir) {
        cands.push(path.join(resourcesDir, 'mpv', exeName));
        cands.push(path.join(resourcesDir, 'mpv', 'mpv', exeName));
    }
    for (const c of cands) { try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch (_) {} }
    for (const d of String(process.env.PATH || '').split(path.delimiter)) {
        if (!d) continue;
        const p = path.join(d, exeName);
        try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
    return null;
}

function splitArgs(s) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(String(s || '')))) out.push(m[1] !== undefined ? m[1] : m[2]);
    return out;
}

class MpvPlayer extends EventEmitter {
    constructor(exe, extraArgs, opts) {
        super();
        this.exe = exe;
        this.extra = extraArgs || [];
        this.opts = opts || {};
        this.proc = null;
        this.sock = null;
        this.alive = false;
        this.reqId = 1;
        this.waiting = new Map();
        this.buf = '';
        this.state = { paused: false, speed: 1, fullscreen: false, volume: 100 };
        const id = `${process.pid}-${Date.now()}`;
        this.ipcPath = process.platform === 'win32'
            ? `\\\\.\\pipe\\wastream-${id}`
            : path.join(os.tmpdir(), `wastream-${id}.sock`);
    }

    async start() {
        const args = [
            '--idle=yes', '--keep-open=no', '--no-terminal', '--force-window=yes',
            '--title=WA Hub 3', `--input-ipc-server=${this.ipcPath}`,
            ...(this.opts.fullscreen ? ['--fs'] : []),
            ...this.extra
        ];
        this.proc = spawn(this.exe, args, { stdio: 'ignore', windowsHide: false });
        this.alive = true;

        const startErr = new Promise((_, rej) => {
            this.proc.once('error', (e) => { this.alive = false; rej(e); });
        });
        this.proc.once('exit', (code) => {
            this.alive = false;
            for (const [, w] of this.waiting) w.reject(new Error('mpv closed'));
            this.waiting.clear();
            try { if (process.platform !== 'win32') fs.unlinkSync(this.ipcPath); } catch (_) {}
            this.emit('exit', code);
        });

        const connect = new Promise((resolve, reject) => {
            const t0 = Date.now();
            const attempt = () => {
                if (!this.alive) return reject(new Error('mpv exited'));
                const s = net.createConnection(this.ipcPath);
                s.once('connect', () => { this.sock = s; this._wire(s); resolve(); });
                s.once('error', () => {
                    s.destroy();
                    if (Date.now() - t0 > 12000) reject(new Error('IPC timeout'));
                    else setTimeout(attempt, 150);
                });
            };
            attempt();
        });
        await Promise.race([connect, startErr]);

        this._write({ command: ['observe_property', 1, 'pause'] });
        this._write({ command: ['observe_property', 2, 'speed'] });
        this._write({ command: ['observe_property', 3, 'fullscreen'] });
        this._write({ command: ['observe_property', 4, 'volume'] });
    }

    _wire(s) {
        s.setEncoding('utf8');
        s.on('data', (chunk) => {
            this.buf += chunk;
            let i;
            while ((i = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, i).trim();
                this.buf = this.buf.slice(i + 1);
                if (!line) continue;
                try { this._onMsg(JSON.parse(line)); } catch (_) {}
            }
        });
        s.on('error', () => {});
    }

    _onMsg(m) {
        if (m.request_id !== undefined && this.waiting.has(m.request_id)) {
            const w = this.waiting.get(m.request_id);
            this.waiting.delete(m.request_id);
            clearTimeout(w.t);
            if (m.error && m.error !== 'success') w.reject(new Error(m.error));
            else w.resolve(m.data);
            return;
        }
        switch (m.event) {
            case 'property-change': {
                const key = m.name === 'pause' ? 'paused' : m.name;   // mpv: pause ← حقلنا: paused
                if (key in this.state) {
                    this.state[key] = m.data;
                    this.emit('state', { ...this.state });
                }
                break;
            }
            case 'start-file': this.emit('started', { entryId: m.playlist_entry_id }); break;
            case 'end-file':
                if (m.reason !== 'redirect') this.emit('ended', { entryId: m.playlist_entry_id, reason: m.reason });
                break;
            default: break;
        }
    }

    _write(obj) {
        if (!this.sock || this.sock.destroyed) return false;
        try { this.sock.write(JSON.stringify(obj) + '\n'); return true; } catch (_) { return false; }
    }

    command(arr, timeoutMs = 8000) {
        return new Promise((resolve, reject) => {
            const id = this.reqId++;
            const t = setTimeout(() => { this.waiting.delete(id); reject(new Error('mpv timeout')); }, timeoutMs);
            this.waiting.set(id, { resolve, reject, t });
            if (!this._write({ command: arr, request_id: id })) {
                clearTimeout(t); this.waiting.delete(id); reject(new Error('mpv not connected'));
            }
        });
    }

    /** يضيف الملف لنهاية القائمة ويبدأ التشغيل إن كان المشغّل فارغاً */
    async append(file) {
        const r = await this.command(['loadfile', file, 'append-play']);
        return r && r.playlist_entry_id !== undefined ? r.playlist_entry_id : null;
    }

    setProp(name, value) { return this.command(['set_property', name, value]); }

    async quit() {
        try { await this.command(['quit'], 1500); } catch (_) {}
        setTimeout(() => { try { if (this.proc && this.alive) this.proc.kill(); } catch (_) {} }, 800);
    }
}

module.exports = { MpvPlayer, findMpv, splitArgs };
