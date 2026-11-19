'use strict';

// ───────────── جسر الاتصال: Electron أو وضع المتصفح ─────────────
(function setupBridge() {
    if (window.desktop) return;
    const params = new URLSearchParams(location.search);
    const token = params.get('t') || sessionStorage.getItem('wahub3_t') || '';
    if (token) sessionStorage.setItem('wahub3_t', token);
    window.desktop = {
        cmd: (c) => fetch('/api/cmd', { method: 'POST', headers: { 'x-token': token }, body: JSON.stringify(c) })
            .then((r) => r.json()).catch(() => null),
        onEvent: (cb) => {
            const es = new EventSource('/api/events?t=' + encodeURIComponent(token));
            es.onmessage = (m) => { try { cb(JSON.parse(m.data)); } catch (_) {} };
        }
    };
})();

// ───────────── الثيمات ─────────────
const THEMES = [
    { name: 'ليلي عصري', bg: '#0A1224', surface: '#111D38', surface2: '#1B2B4D', text: '#EAF1FF', sub: '#8FA3C7', accent: '#3D8BFF', dark: true },
    { name: 'نهاري', bg: '#F3F5F9', surface: '#FFFFFF', surface2: '#E8ECF3', text: '#14171F', sub: '#5B6475', accent: '#2563EB', dark: false },
    { name: 'AMOLED', bg: '#000000', surface: '#0D0D0F', surface2: '#1A1A1F', text: '#FFFFFF', sub: '#8A8F9C', accent: '#3D8BFF', dark: true },
    { name: 'بنفسجي', bg: '#160B2A', surface: '#22123F', surface2: '#301A5C', text: '#F3EDFF', sub: '#B3A1D9', accent: '#8B5CF6', dark: true },
    { name: 'زمردي', bg: '#071A13', surface: '#0C2B20', surface2: '#143A2C', text: '#E9FFF6', sub: '#93C4AE', accent: '#10B981', dark: true }
];
const ACCENTS = ['#3D8BFF', '#8B5CF6', '#10B981', '#F59E0B', '#EF4444', '#EC4899'];

function ls(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
function initialTheme() {
    try {
        if (!localStorage.getItem('wahub3_theme_migrated')) {
            const old = parseInt(localStorage.getItem('theme') || '0', 10) || 0;
            const map = [0, 2, 1, 0];
            localStorage.setItem('theme', String(map[Math.min(3, Math.max(0, old))]));
            localStorage.setItem('wahub3_theme_migrated', '1');
        }
    } catch (_) {}
    return Math.min(THEMES.length - 1, parseInt(ls('theme', '0'), 10) || 0);
}

const S = {
    conn: 'idle', registered: false, code: '', err: '', pairing: false, paused: false, engineUp: false, ready: false,
    jobs: [], settings: {}, stream: null, mpv: { found: true, path: '' }, playerErr: '', fatal: '', logs: [],
    roomsState: { sections: [], rooms: [], favoritesCount: 0, favoritesSize: 0, receivingId: null, openRoomId: null },
    selSection: 'inbox', expandedRoom: null,
    tab: 0, modal: null, modalId: null, phone: '',
    theme: initialTheme(),
    accent: (() => { const v = ls('accent', null); return v === null ? -1 : Math.min(ACCENTS.length - 1, parseInt(v, 10) || 0); })()
};

// ───────────── أدوات ─────────────
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const L = (t) => `<bdi dir="ltr">${esc(t)}</bdi>`;

function fmtSize(b) {
    b = Number(b) || 0;
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return Math.round(b / 1024) + ' KB';
    return b + ' B';
}
const fmtSpeed = (b) => (b > 0 ? fmtSize(b) + '/s' : '');
function fmtEta(s) {
    if (s < 60) return Math.round(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}
function fmtRemaining(ms) {
    if (ms === null || ms === undefined) return '';
    const totalMin = Math.ceil(ms / 60000);
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    if (h > 0) return `${h} س ${m} د`;
    return `${m} د`;
}
const connText = (c) => ({
    open: 'متصل', connecting: 'جارٍ الاتصال…', reconnecting: 'إعادة الاتصال…', pairing: 'بانتظار إدخال الرمز',
    replaced: 'فُتحت جلسة أخرى بنفس الحساب', needpair: 'غير مسجّل', loggedout: 'غير مسجّل'
}[c] || 'تشغيل المحرك…');

let toastTimer = null;
function toast(msg) {
    const t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

function applyTheme() {
    const t = THEMES[S.theme], r = document.documentElement.style;
    r.setProperty('--bg', t.bg); r.setProperty('--surface', t.surface); r.setProperty('--surface2', t.surface2);
    r.setProperty('--text', t.text); r.setProperty('--sub', t.sub); r.setProperty('--accent', S.accent >= 0 ? ACCENTS[S.accent] : t.accent);
    document.documentElement.style.colorScheme = t.dark ? 'dark' : 'light';
}

const cmd = (c) => window.desktop.cmd(c);
const save = (patch) => cmd({ cmd: 'saveSettings', settings: patch });
const ctl = (what, arg) => cmd({ cmd: 'control', what, arg });

// ───────────── القوالب ─────────────
function showLogin() {
    return S.pairing || ['needpair', 'loggedout', 'pairing'].includes(S.conn) || (S.conn === 'idle' && !S.registered);
}

function loginHTML() {
    const diag = `
      <div class="card" style="margin-top:16px">
        <div class="row"><div class="grow title" style="margin:0">التشخيص</div>
          <span class="pill ${S.engineUp ? 'green' : 'red'}">${S.engineUp ? 'المحرك يعمل' : 'المحرك لم يبدأ'}</span></div>
        <div class="sub" style="margin-top:6px">الحالة: ${connText(S.conn)}</div>
        <div class="logs">${S.logs.slice(-10).map((l) => `<div>${esc(l)}</div>`).join('')}</div>
        <button class="out block" data-act="diag" style="margin-top:8px">🔍 فحص الاتصال بواتساب</button>
      </div>`;
    const err = S.err ? `<div class="err" style="margin-top:10px;font-size:13px">${esc(S.err)}</div>` : '';
    let card;
    if (!S.code) {
        card = `<div class="card">
          <div class="title" style="margin-bottom:4px">ربط الواتساب</div>
          <div class="sub">أدخل رقمك مع رمز الدولة بدون +</div>
          <label class="f" for="phone">مثال: 213562396663</label>
          <input id="phone" type="tel" inputmode="numeric" value="${esc(S.phone)}" ${S.pairing ? 'disabled' : ''}>
          <button class="block big" data-act="pair" style="margin-top:14px" ${S.pairing ? 'disabled' : ''}>${S.pairing ? 'جارٍ طلب الرمز…' : 'طلب رمز الربط'}</button>
          ${S.pairing ? '<button class="out block" data-act="cancelPair" style="margin-top:8px">إلغاء</button>' : ''}${err}</div>`;
    } else {
        card = `<div class="card"><div class="title">رمز الربط</div><div class="code">${esc(S.code)}</div>
          <div class="sub" style="margin-top:14px">1) افتح واتساب ← الأجهزة المرتبطة<br>2) اختر «ربط جهاز»<br>3) اختر «الربط برقم الهاتف بدلاً من ذلك»<br>4) أدخل الرمز أعلاه</div>
          <div class="btns" style="margin-top:14px"><button data-act="copyCode">نسخ الرمز</button><button class="out" data-act="cancelPair">إلغاء</button></div>
          <div class="sub" style="margin-top:8px">الحالة: ${connText(S.conn)}</div>${err}</div>`;
    }
    return `<div class="login"><div class="logo">▶</div><h1>WA Hub 3 — مشاهدة</h1>
      <div class="sub">سجّل الدخول مرة واحدة وتُحفظ الجلسة</div>${card}${diag}</div>`;
}

function chips(opts, sel, key) {
    return `<div class="chips">${opts.map((o) => `<div class="chip ${o.v === sel ? 'on' : ''}" data-act="set" data-key="${key}" data-val="${o.v}">${esc(o.l)}</div>`).join('')}</div>`;
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

// ───────────── الغرف والأقسام ─────────────
function sectionName(id) {
    const sec = S.roomsState.sections.find((s) => s.id === id);
    return sec ? sec.name : 'غير مصنّف';
}

function visibleRooms() {
    const rooms = S.roomsState.rooms || [];
    if (S.selSection === 'favorites') return rooms.filter((r) => r.favorite);
    return rooms.filter((r) => r.sectionId === S.selSection);
}

function playerCardHTML() {
    const s = S.stream, pl = (s && s.player) || {};
    const openRoom = (S.roomsState.rooms || []).find((r) => r.id === (s && s.openRoomId));
    const st = S.settings;
    return `
      <div class="card now">
        <div class="row" style="justify-content:center"><span class="pill ${pl.running ? 'green' : 'sub'}">${pl.running ? (pl.paused ? '⏸ متوقف مؤقتاً' : '▶ يعمل') : 'المشغّل متوقف'}</span></div>
        <div class="nowname" id="stNow">${s && s.now ? esc(s.now) : (openRoom ? esc(openRoom.name) : '—')}</div>
        <div class="meta" id="stDetail">${openRoom ? 'الغرفة: ' + esc(openRoom.name) : 'اختر غرفة واضغط «تشغيل» — لا يبدأ أي تشغيل تلقائياً.'}</div>
        <div class="ctl">
          <button class="soft" data-act="ctl" data-what="togglePause" id="btnPause" title="إيقاف مؤقت / تشغيل">${pl.paused ? '▶' : '⏸'}</button>
          <button class="soft" data-act="ctl" data-what="next" title="تخطّي الجزء الحالي">⏭</button>
          <button class="soft" data-act="ctl" data-what="fs" title="ملء الشاشة">⛶</button>
          <button class="soft" data-act="ctl" data-what="closePlayer" title="إغلاق المشغّل">✕ إغلاق</button></div>
        <div class="title" style="margin:14px 0 8px;text-align:right">السرعة</div>
        <div class="chips" id="speedChips">${SPEEDS.map((x) => `<div class="chip ${x === (pl.speed || 1) ? 'on' : ''}" data-act="speed" data-val="${x}">${x}x</div>`).join('')}</div>
        <label class="f" style="text-align:right">الصوت: <b id="volLabel">${Math.round(pl.volume != null ? pl.volume : (st.volume || 100))}</b></label>
        <input type="range" id="vol" min="0" max="130" value="${Math.round(pl.volume != null ? pl.volume : (st.volume || 100))}">
      </div>`;
}

function roomCardHTML(r) {
    const isOpen = S.stream && S.stream.openRoomId === r.id;
    const status = [
        r.receiving ? '<span class="pill accent">📥 تستقبل هنا</span>' : '',
        isOpen ? '<span class="pill green">مفتوحة بالمشغّل</span>' : '',
        r.completedAt ? (r.favorite ? '<span class="pill green">مكتملة ★ محفوظة</span>' : `<span class="pill amber">مكتملة — تُحذف بعد ${esc(fmtRemaining(r.remainingMs))}</span>`) : ''
    ].join('');
    const expanded = S.expandedRoom === r.id;
    const partsList = expanded
        ? `<div class="parts-list">${r.parts.length ? r.parts.map((p, i) => `<div class="meta">${i + 1}. ${esc(p.name)} — ${L(fmtSize(p.size))}</div>`).join('') : '<div class="meta">لا توجد أجزاء بعد</div>'}</div>` : '';
    return `
      <div class="card" data-room="${r.id}">
        <div class="row">
          <button class="text" data-act="favRoom" data-id="${r.id}" title="مفضلة" style="font-size:20px;padding:2px 6px">${r.favorite ? '⭐' : '☆'}</button>
          <div class="grow name">${esc(r.name)}</div>${status}</div>
        <div class="meta" style="margin-top:6px">${r.partsCount} ${r.partsCount === 1 ? 'جزء' : 'أجزاء'}  •  ${L(fmtSize(r.totalSize))}${S.selSection === 'favorites' ? '  •  ' + esc(sectionName(r.sectionId)) : ''}</div>
        ${partsList}
        <div class="room-actions">
          <button data-act="playRoom" data-id="${r.id}" ${r.partsCount ? '' : 'disabled'}>▶ تشغيل</button>
          <button class="soft" data-act="toggleParts" data-id="${r.id}">${expanded ? 'إخفاء الأجزاء' : 'الأجزاء'}</button>
          <button class="soft" data-act="recvRoom" data-id="${r.id}">${r.receiving ? 'إيقاف الاستقبال هنا' : 'استقبال هنا'}</button>
          <button class="soft" data-act="favRoom" data-id="${r.id}">${r.favorite ? 'إلغاء المفضلة' : 'مفضلة'}</button>
          <button class="soft" data-act="roomMove" data-id="${r.id}">نقل إلى قسم</button>
          <button class="soft" data-act="roomRename" data-id="${r.id}">إعادة تسمية</button>
          ${r.completedAt
            ? `<button class="soft" data-act="uncompleteRoom" data-id="${r.id}">تراجع عن الإكمال</button>`
            : `<button class="soft" data-act="completeRoom" data-id="${r.id}">✓ أكملت الغرفة</button>`}
          <button class="soft" data-act="delRoom" data-id="${r.id}" style="color:var(--red)">حذف الغرفة</button>
        </div>
      </div>`;
}

function roomsHTML() {
    const rs = S.roomsState;
    const mpvWarn = !S.mpv.found
        ? `<div class="card warncard"><div class="name">⚠ مشغّل mpv غير موجود</div>
            <div class="sub">على ويندوز يأتي مع البرنامج. على لينكس ثبّته: <span class="cmds">sudo apt install mpv</span> أو حدّد مساره من الإعدادات.</div></div>` : '';
    const perr = S.playerErr ? `<div class="card warncard"><div class="err">${esc(S.playerErr)}</div></div>` : '';
    const selSec = rs.sections.find((s) => s.id === S.selSection);
    const rooms = visibleRooms();
    const selSize = S.selSection === 'favorites' ? rs.favoritesSize : (selSec ? selSec.totalSize : 0);
    const selCount = S.selSection === 'favorites' ? rs.favoritesCount : (selSec ? selSec.roomCount : 0);
    const secActions = S.selSection === 'favorites'
        ? '<div class="sub">كل الغرف المفضلة من جميع الأقسام — لا تُحذف تلقائياً أبداً.</div>'
        : S.selSection === 'inbox'
            ? '<div class="sub">القسم الافتراضي — تصل إليه الغرف الجديدة تلقائياً ولا يمكن حذفه.</div>'
            : `<div class="btns"><button class="out" data-act="secRename" data-id="${esc(S.selSection)}">إعادة تسمية القسم</button>
                 <button class="out" data-act="secDelete" data-id="${esc(S.selSection)}" style="color:var(--red)">حذف القسم</button></div>
               <div class="sub" style="margin-top:6px">حذف القسم ينقل غرفه إلى «غير مصنّف» ولا يحذفها.</div>`;
    return `
      <div class="head"><div><h1>غرف المشاهدة</h1><div class="sub">الأجزاء الواصلة تُحفظ في غرف — التشغيل بضغطك فقط</div></div>
        <span class="pill ${S.conn === 'open' ? 'green' : 'amber'}">${connText(S.conn)}</span></div>
      ${mpvWarn}${perr}
      ${playerCardHTML()}
      <div class="secbar">
        <div class="chip ${S.selSection === 'favorites' ? 'on' : ''}" data-act="secSel" data-id="favorites">⭐ المفضلة (${rs.favoritesCount})</div>
        ${rs.sections.map((sec) => `<div class="chip ${S.selSection === sec.id ? 'on' : ''}" data-act="secSel" data-id="${esc(sec.id)}">${esc(sec.name)} (${sec.roomCount})</div>`).join('')}
        <div class="chip" data-act="secNew">＋ قسم جديد</div>
      </div>
      <div class="card">
        <div class="row"><div class="grow title" style="margin:0">${S.selSection === 'favorites' ? '⭐ المفضلة' : esc(selSec ? selSec.name : '')}</div>
          <span class="pill sub">${selCount} غرفة • ${L(fmtSize(selSize))}</span></div>
        <div style="margin-top:10px">${secActions}</div>
        <button class="block" data-act="roomNew" style="margin-top:10px">＋ إنشاء غرفة</button>
        ${rs.receivingId ? `<div class="sub" style="margin-top:8px">📥 الاستقبال مفعّل في غرفة: <b>${esc((rs.rooms.find((r) => r.id === rs.receivingId) || {}).name || '')}</b> — كل الأجزاء الواصلة تذهب إليها.</div>` : ''}
      </div>
      ${rooms.length ? rooms.map(roomCardHTML).join('') : `<div class="card"><div class="name">لا توجد غرف هنا</div><div class="sub">أرسل أجزاء في الشات وستُنشأ غرف تلقائياً، أو أنشئ غرفة وفعّل «استقبال هنا».</div></div>`}
      <div class="card"><div class="title">أوامر من الشات</div>
        <div class="sub" style="margin-bottom:8px">للتحكم بالمشغّل أثناء التشغيل (تبدأ بـ ! أو /):</div>
        <div class="cmds">!pause &nbsp; !play &nbsp; !next &nbsp; !fs<br>!speed 1.25 &nbsp; !vol 50 &nbsp; !status</div>
        <div class="cmds" style="margin-top:6px;direction:rtl;text-align:right">!ايقاف &nbsp; !تشغيل &nbsp; !تخطي &nbsp; !سرعة 1.25 &nbsp; !صوت 50</div></div>`;
}

function patchPlayer() {
    const s = S.stream; if (!s || S.tab !== 0 || showLogin()) return;
    const pl = s.player || {};
    const now = document.getElementById('stNow'); if (!now) return;
    now.textContent = s.now || '—';
    const sc = document.getElementById('speedChips');
    if (sc) sc.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', parseFloat(c.dataset.val) === (pl.speed || 1)));
    const btn = document.getElementById('btnPause'); if (btn) btn.textContent = pl.paused ? '▶' : '⏸';
    const vol = document.getElementById('vol');
    if (vol && document.activeElement !== vol && pl.volume != null) { vol.value = Math.round(pl.volume); const vl = document.getElementById('volLabel'); if (vl) vl.textContent = Math.round(pl.volume); }
}

const STATUS_PILL = {
    active: ['جاري', 'accent'], queued: ['منتظر', 'amber'], failed: ['فشل', 'red'], expired: ['منتهي', 'red'], skipped: ['متخطّى', 'sub']
};

function jobMeta(j) {
    const p = j.size > 0 ? Math.min(1, j.done / j.size) : 0;
    const eta = j.speed > 0 && j.size > j.done ? '  •  ' + L(fmtEta((j.size - j.done) / j.speed)) : '';
    return `${j.size > 0 ? L(Math.round(p * 100) + '%') + '  •  ' : ''}${L(fmtSize(j.done) + ' / ' + (j.size > 0 ? fmtSize(j.size) : '؟'))}${j.speed > 0 ? '  •  ' + L(fmtSpeed(j.speed)) : ''}${eta}`;
}

function jobHTML(j) {
    const [pt, pc] = STATUS_PILL[j.status] || ['', 'sub'];
    let body;
    if (j.status === 'active') {
        const p = j.size > 0 ? Math.min(1, j.done / j.size) : 0;
        body = `<div class="bar ${j.size > 0 ? '' : 'indet'}"><i style="width:${(p * 100).toFixed(1)}%"></i></div>
          <div class="meta" data-meta>${jobMeta(j)}</div>
          ${j.attempt > 1 ? `<div class="warn">المحاولة ${j.attempt}</div>` : ''}${j.error ? `<div class="warn">${esc(j.error)}</div>` : ''}`;
    } else {
        body = `<div class="meta" style="margin-top:8px">${j.size > 0 ? L(fmtSize(j.size)) : 'حجم غير معروف'}${j.from ? '  •  ' + L(j.from) : ''}</div>
          ${j.error ? `<div class="err">${esc(j.error)}</div>` : ''}`;
    }
    let actions = '';
    if (j.status === 'active' || j.status === 'queued') actions = `<button class="text red" data-act="cancel" data-id="${j.id}">إلغاء</button>`;
    else if (j.status === 'failed' || j.status === 'expired') {
        actions = `${j.status === 'failed' ? `<button class="text" data-act="retry" data-id="${j.id}">إعادة المحاولة</button>` : ''}
                   <button class="text" data-act="remove" data-id="${j.id}">إزالة</button>`;
    } else actions = `<button class="text" data-act="remove" data-id="${j.id}">إزالة</button>`;
    return `<div class="card" data-jid="${j.id}"><div class="row"><div class="grow name" style="direction:ltr;text-align:right">${esc(j.name)}</div><span class="pill ${pc}">${pt}</span></div>
      ${body}<div class="actions">${actions}</div></div>`;
}

function downloadsHTML() {
    const order = { active: 0, queued: 1, failed: 2, expired: 2, skipped: 3 };
    const jobs = [...S.jobs].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    const cnt = (f) => S.jobs.filter(f).length;
    const speed = S.jobs.filter((j) => j.status === 'active').reduce((a, j) => a + (j.speed || 0), 0);
    return `
      <div class="head"><div><h1>التحميلات</h1><div class="sub" id="totalSpeed">${speed > 0 ? L(fmtSpeed(speed)) : '—'}</div></div>
        <span class="pill ${S.conn === 'open' ? 'green' : 'amber'}">${connText(S.conn)}</span></div>
      <div class="card"><div class="stats" style="grid-template-columns:repeat(3,1fr)">
          <div class="stat"><b>${cnt((j) => j.status === 'active')}</b><span>جاري</span></div>
          <div class="stat"><b>${cnt((j) => j.status === 'queued')}</b><span>منتظر</span></div>
          <div class="stat"><b>${cnt((j) => j.status === 'failed' || j.status === 'expired')}</b><span>فاشل</span></div></div>
        <button class="out block" data-act="pause">${S.paused ? '▶  استئناف التحميل' : '⏸  إيقاف مؤقت (بعد الملف الحالي)'}</button></div>
      ${jobs.length ? jobs.map(jobHTML).join('') : `<div class="card"><div class="name">لا توجد تحميلات جارية</div><div class="sub">كل جزء يصل إلى الشات يظهر هنا أثناء تحميله ثم يُحفظ في غرفته.</div></div>`}`;
}

function settingsHTML() {
    const st = S.settings, g = (k, d) => (st[k] === undefined ? d : st[k]);
    const gapMin = g('gapMin', 1), gapMax = g('gapMax', 3);
    return `
      <h1>الإعدادات</h1>
      <div class="card"><div class="title">التشغيل</div>
        <div class="toggle"><span>بدء المشغّل بملء الشاشة</span><label class="switch"><input type="checkbox" data-set="startFullscreen" ${g('startFullscreen', false) ? 'checked' : ''}><b></b></label></div>
        <div class="sub" style="margin-top:8px">الأجزاء تُحفظ نهائياً في غرفها ولا تُحذف بعد التشغيل. الغرف المكتملة غير المفضلة تُحذف تلقائياً بعد 10 ساعات.</div></div>

      <div class="card"><div class="title">المصدر والأوامر</div>
        <label class="f" style="margin-top:0">رقم المحادثة (فارغ = الكل)</label>
        <input type="tel" data-set="target" value="${esc(g('target', ''))}">
        <div class="toggle"><span>تفعيل أوامر الشات (!pause !next …)</span><label class="switch"><input type="checkbox" data-set="chatCommands" ${g('chatCommands', true) ? 'checked' : ''}><b></b></label></div>
        <div class="toggle"><span>الرد على أمر !status في الشات</span><label class="switch"><input type="checkbox" data-set="chatReply" ${g('chatReply', false) ? 'checked' : ''}><b></b></label></div>
        <div class="sub" style="margin-top:6px">الأوامر تُقبل من حسابك أنت أو من الرقم المحدد فقط.</div></div>

      <div class="card"><div class="title">التحميل</div>
        <div class="sub" style="font-size:13px;color:var(--text)">الفاصل العشوائي بين الأجزاء: <b id="gapLabel">${gapMin} – ${gapMax}</b> ثانية</div>
        <label class="f">الحد الأدنى</label><input type="range" id="gapMin" min="0" max="10" value="${gapMin}">
        <label class="f">الحد الأقصى</label><input type="range" id="gapMax" min="0" max="10" value="${gapMax}"></div>

      <div class="card"><div class="title">المشغّل (mpv)</div>
        <div class="row"><span class="pill ${S.mpv.found ? 'green' : 'red'}">${S.mpv.found ? 'موجود' : 'غير موجود'}</span>
          <div class="grow sub" style="direction:ltr;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(S.mpv.path)}</div></div>
        <label class="f">مسار mpv (فارغ = تلقائي)</label>
        <div class="btns"><input type="text" data-set="mpvPath" value="${esc(g('mpvPath', ''))}"><button class="soft" data-act="pickMpv" style="flex:0 0 auto">📁</button></div>
        <label class="f">وسائط إضافية لـ mpv (للمتقدمين)</label>
        <input type="text" data-set="mpvArgs" value="${esc(g('mpvArgs', ''))}" placeholder="--hwdec=auto"></div>

      <div class="card"><div class="title">المظهر</div>
        ${chips(THEMES.map((t, i) => ({ v: i, l: t.name })), S.theme, 'theme')}
        <div class="sub" style="margin:12px 0 8px">لون التمييز</div>
        <div class="swatches">${ACCENTS.map((c, i) => `<div class="sw" style="background:${c}" data-act="accent" data-i="${i}">${i === S.accent ? '✓' : ''}</div>`).join('')}</div></div>

      <div class="card"><div class="title">النظام والحساب</div><div class="stack">
        <button class="out" data-act="logs">📄 سجل الأحداث</button>
        <button class="out" data-act="diag">🔍 فحص الاتصال</button>
        <button class="out" data-act="logout" style="color:var(--red)">🚪 تسجيل الخروج</button>
        <button class="out" data-act="switchMode">🔀 تغيير الوضع</button>
        <button class="out" data-act="quit">⏻ إغلاق التطبيق</button></div></div>`;
}

function navHTML() {
    const items = [['▶', 'الغرف'], ['⬇', 'التحميلات'], ['⚙', 'الإعدادات']];
    return `<div class="nav">${items.map((it, i) => `<a class="${S.tab === i ? 'on' : ''}" data-act="tab" data-i="${i}"><span class="ic">${it[0]}</span>${it[1]}</a>`).join('')}</div>`;
}

function modalHTML() {
    if (!S.modal) return '';
    if (S.modal === 'logs') {
        return `<div class="modal-bg" data-act="closeModal"><div class="modal" data-stop><div class="title">سجل الأحداث</div>
          <div class="body logs">${S.logs.length ? S.logs.slice().reverse().map((l) => `<div>${esc(l)}</div>`).join('') : '<div>لا توجد أحداث</div>'}</div>
          <button data-act="closeModal">إغلاق</button></div></div>`;
    }
    if (S.modal === 'sectionNew') {
        return `<div class="modal-bg" data-act="closeModal"><div class="modal" data-stop><div class="title">قسم جديد</div>
          <label class="f" for="newSectionName">اسم القسم</label>
          <input id="newSectionName" type="text" placeholder="مثال: أفلام">
          <div class="btns" style="margin-top:14px"><button data-act="secCreate">إنشاء</button><button class="out" data-act="closeModal">إلغاء</button></div></div></div>`;
    }
    if (S.modal === 'sectionRename') {
        const sec = S.roomsState.sections.find((s) => s.id === S.modalId);
        return `<div class="modal-bg" data-act="closeModal"><div class="modal" data-stop><div class="title">إعادة تسمية القسم</div>
          <label class="f" for="renameSectionName">الاسم الجديد</label>
          <input id="renameSectionName" type="text" value="${esc(sec ? sec.name : '')}">
          <div class="btns" style="margin-top:14px"><button data-act="secRenameSave" data-id="${esc(S.modalId || '')}">حفظ</button><button class="out" data-act="closeModal">إلغاء</button></div></div></div>`;
    }
    if (S.modal === 'roomNew') {
        const defSec = S.selSection === 'favorites' ? 'inbox' : S.selSection;
        return `<div class="modal-bg" data-act="closeModal"><div class="modal" data-stop><div class="title">غرفة جديدة</div>
          <label class="f" for="newRoomName">اسم الغرفة</label>
          <input id="newRoomName" type="text" placeholder="مثال: فيلم الليلة">
          <label class="f" for="newRoomSection">القسم</label>
          <select id="newRoomSection">${S.roomsState.sections.map((sec) => `<option value="${esc(sec.id)}" ${sec.id === defSec ? 'selected' : ''}>${esc(sec.name)}</option>`).join('')}</select>
          <div class="btns" style="margin-top:14px"><button data-act="roomCreate">إنشاء</button><button class="out" data-act="closeModal">إلغاء</button></div></div></div>`;
    }
    if (S.modal === 'roomRename') {
        const room = S.roomsState.rooms.find((r) => r.id === S.modalId);
        return `<div class="modal-bg" data-act="closeModal"><div class="modal" data-stop><div class="title">إعادة تسمية الغرفة</div>
          <label class="f" for="renameRoomName">الاسم الجديد</label>
          <input id="renameRoomName" type="text" value="${esc(room ? room.name : '')}">
          <div class="btns" style="margin-top:14px"><button data-act="roomRenameSave" data-id="${esc(S.modalId || '')}">حفظ</button><button class="out" data-act="closeModal">إلغاء</button></div></div></div>`;
    }
    if (S.modal === 'roomMove') {
        const room = S.roomsState.rooms.find((r) => r.id === S.modalId);
        return `<div class="modal-bg" data-act="closeModal"><div class="modal" data-stop><div class="title">نقل إلى قسم</div>
          <div class="sub" style="margin-bottom:8px">الغرفة: ${esc(room ? room.name : '')}</div>
          <label class="f" for="moveRoomSection">القسم الجديد</label>
          <select id="moveRoomSection">${S.roomsState.sections.map((sec) => `<option value="${esc(sec.id)}" ${room && sec.id === room.sectionId ? 'selected' : ''}>${esc(sec.name)}</option>`).join('')}</select>
          <div class="btns" style="margin-top:14px"><button data-act="roomMoveSave" data-id="${esc(S.modalId || '')}">نقل</button><button class="out" data-act="closeModal">إلغاء</button></div></div></div>`;
    }
    return '';
}

// ───────────── العرض ─────────────
function render() {
    const app = $('#app'); if (!app) return;
    if (!S.ready) { app.innerHTML = ''; return; }
    const old = $('.content', app) || $('.login', app);
    const scroll = old ? old.scrollTop : 0;
    const fatal = S.fatal ? `<div class="banner" data-act="copyFatal">${esc(S.fatal)}\n(اضغط للنسخ)</div>` : '';
    if (showLogin()) {
        app.innerHTML = fatal + loginHTML() + modalHTML();
        const ph = $('#phone'); if (ph) ph.addEventListener('input', () => { S.phone = ph.value.replace(/[^0-9]/g, ''); });
    } else {
        const body = [roomsHTML, downloadsHTML, settingsHTML][S.tab]();
        app.innerHTML = fatal + `<div class="content">${body}</div>${navHTML()}${modalHTML()}`;
        bindInputs();
    }
    const nw = $('.content', app) || $('.login', app);
    if (nw) nw.scrollTop = scroll;
}

function bindInputs() {
    const a = $('#gapMin'), b = $('#gapMax');
    if (a && b) {
        const label = () => { $('#gapLabel').textContent = `${a.value} – ${b.value}`; };
        a.addEventListener('input', () => { if (+a.value > +b.value) b.value = a.value; label(); });
        b.addEventListener('input', () => { if (+b.value < +a.value) a.value = b.value; label(); });
        const commit = () => save({ gapMin: +a.value, gapMax: +b.value });
        a.addEventListener('change', commit); b.addEventListener('change', commit);
    }
    const vol = $('#vol');
    if (vol) {
        vol.addEventListener('input', () => { const vl = $('#volLabel'); if (vl) vl.textContent = vol.value; });
        vol.addEventListener('change', () => ctl('vol', +vol.value));
    }
}

function refresh(kind) {
    if (showLogin()) { if (['state', 'log', 'code', 'error', 'engine'].includes(kind)) render(); return; }
    if (S.tab === 0 && ['state', 'rooms', 'player', 'settings'].includes(kind)) render();
    else if (S.tab === 1 && ['jobs', 'state', 'paused'].includes(kind)) render();
    else if (S.tab === 2 && ['settings'].includes(kind)) render();
    if (S.modal === 'logs' && kind === 'log') render();
}

function patchProgress(id) {
    const j = S.jobs.find((x) => x.id === id); if (!j) return;
    const card = $(`[data-jid="${id}"]`); if (!card) return;
    const fill = $('.bar i', card), meta = $('[data-meta]', card);
    if (fill && j.size > 0) fill.style.width = (Math.min(1, j.done / j.size) * 100).toFixed(1) + '%';
    if (meta) meta.innerHTML = jobMeta(j);
    const sp = $('#totalSpeed');
    if (sp) { const tot = S.jobs.filter((x) => x.status === 'active').reduce((a, x) => a + (x.speed || 0), 0); sp.innerHTML = tot > 0 ? L(fmtSpeed(tot)) : '—'; }
}

// ───────────── أحداث المحرك ─────────────
function onEvent(o) {
    switch (o.t) {
        case 'state':
            S.conn = o.conn; S.registered = !!o.registered; S.engineUp = true;
            if (o.conn === 'open') { S.pairing = false; S.code = ''; S.err = ''; }
            if (o.conn === 'needpair' || o.conn === 'loggedout') { S.pairing = false; S.code = ''; }
            render(); break;
        case 'code': S.code = o.code; render(); break;
        case 'error': S.err = o.msg; S.pairing = false; render(); break;
        case 'log': S.logs.push(o.msg); if (S.logs.length > 150) S.logs.shift(); refresh('log'); break;
        case 'jobs': S.jobs = o.jobs; refresh('jobs'); break;
        case 'progress': {
            const j = S.jobs.find((x) => x.id === o.id);
            if (j) { j.done = o.done; j.speed = o.speed; if (o.total > 0) j.size = o.total; patchProgress(o.id); }
            break;
        }
        case 'stream': S.stream = o.s; patchPlayer(); break;
        case 'rooms':
            S.roomsState = o.roomsState;
            if (S.selSection !== 'favorites' && !S.roomsState.sections.some((s) => s.id === S.selSection)) S.selSection = 'inbox';
            refresh('rooms'); break;
        case 'settings': S.settings = o.settings; if (o.mpv) S.mpv = o.mpv; refresh('settings'); break;
        case 'paused': S.paused = o.paused; refresh('paused'); break;
        case 'playerError': S.playerErr = o.msg || ''; refresh('player'); break;
        case 'playerClosed': toast('أُغلق المشغّل'); refresh('rooms'); break;
        default: break;
    }
}

// ───────────── التفاعل ─────────────
document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    if (el.dataset.act === 'closeModal' && e.target.closest('[data-stop]') && !e.target.closest('button') && !e.target.closest('input') && !e.target.closest('select')) return;
    const a = el.dataset.act, id = el.dataset.id;

    switch (a) {
        case 'tab': S.tab = +el.dataset.i; render(); break;
        case 'pair': {
            const ph = $('#phone'); if (ph) S.phone = ph.value.replace(/[^0-9]/g, '');
            if (S.phone.length < 8) { S.err = 'أدخل رقماً صحيحاً مع رمز الدولة'; render(); break; }
            S.pairing = true; S.err = ''; S.code = ''; render();
            cmd({ cmd: 'pair', phone: S.phone }); break;
        }
        case 'cancelPair': S.pairing = false; S.code = ''; render(); cmd({ cmd: 'logout' }); break;
        case 'copyCode': try { await navigator.clipboard.writeText(S.code.replace('-', '')); toast('تم نسخ الرمز'); } catch (_) {} break;
        case 'copyFatal': try { await navigator.clipboard.writeText(S.fatal); toast('تم النسخ'); } catch (_) {} break;
        case 'diag': S.logs.push('…بدء الفحص'); render(); cmd({ cmd: 'diag' }); break;
        case 'pause': cmd({ cmd: 'setPause', user: !S.paused }); break;
        case 'cancel': cmd({ cmd: 'cancel', id }); break;
        case 'retry': cmd({ cmd: 'retry', id }); break;
        case 'remove': S.jobs = S.jobs.filter((j) => j.id !== id); cmd({ cmd: 'clearJob', id }); render(); break;
        case 'ctl': ctl(el.dataset.what); break;
        case 'speed': ctl('speed', parseFloat(el.dataset.val)); break;

        // ── الأقسام ──
        case 'secSel': S.selSection = id; render(); break;
        case 'secNew': S.modal = 'sectionNew'; S.modalId = null; render(); break;
        case 'secCreate': {
            const v = ($('#newSectionName') || {}).value || '';
            if (v.trim()) { const rs = await cmd({ cmd: 'createSection', name: v.trim() }); if (rs) S.roomsState = rs; }
            S.modal = null; render(); break;
        }
        case 'secRename': S.modal = 'sectionRename'; S.modalId = id; render(); break;
        case 'secRenameSave': {
            const v = ($('#renameSectionName') || {}).value || '';
            if (v.trim()) { const rs = await cmd({ cmd: 'renameSection', id, name: v.trim() }); if (rs) S.roomsState = rs; }
            S.modal = null; render(); break;
        }
        case 'secDelete': {
            if (confirm('حذف هذا القسم؟ ستُنقل غرفه إلى «غير مصنّف» ولن تُحذف.')) {
                const rs = await cmd({ cmd: 'deleteSection', id });
                if (rs) S.roomsState = rs;
                S.selSection = 'inbox'; render();
            }
            break;
        }

        // ── الغرف ──
        case 'roomNew': S.modal = 'roomNew'; S.modalId = null; render(); break;
        case 'roomCreate': {
            const v = ($('#newRoomName') || {}).value || '';
            const sec = ($('#newRoomSection') || {}).value || 'inbox';
            if (v.trim()) {
                const rs = await cmd({ cmd: 'createRoom', name: v.trim(), sectionId: sec });
                if (rs) S.roomsState = rs;
                S.selSection = sec;
            }
            S.modal = null; render(); break;
        }
        case 'playRoom': cmd({ cmd: 'playRoom', id }); break;
        case 'toggleParts': S.expandedRoom = S.expandedRoom === id ? null : id; render(); break;
        case 'favRoom': { const rs = await cmd({ cmd: 'setFavorite', id }); if (rs) { S.roomsState = rs; render(); } break; }
        case 'recvRoom': { const rs = await cmd({ cmd: 'setReceiving', id }); if (rs) { S.roomsState = rs; render(); } break; }
        case 'completeRoom': { const rs = await cmd({ cmd: 'completeRoom', id }); if (rs) { S.roomsState = rs; render(); } toast('ستُحذف الغرفة بعد 10 ساعات ما لم تكن مفضلة'); break; }
        case 'uncompleteRoom': { const rs = await cmd({ cmd: 'uncompleteRoom', id }); if (rs) { S.roomsState = rs; render(); } break; }
        case 'delRoom': {
            if (confirm('حذف هذه الغرفة وكل أجزائها من القرص؟')) {
                const rs = await cmd({ cmd: 'deleteRoom', id });
                if (rs) { S.roomsState = rs; render(); }
            }
            break;
        }
        case 'roomRename': S.modal = 'roomRename'; S.modalId = id; render(); break;
        case 'roomRenameSave': {
            const v = ($('#renameRoomName') || {}).value || '';
            if (v.trim()) { const rs = await cmd({ cmd: 'renameRoom', id, name: v.trim() }); if (rs) S.roomsState = rs; }
            S.modal = null; render(); break;
        }
        case 'roomMove': S.modal = 'roomMove'; S.modalId = id; render(); break;
        case 'roomMoveSave': {
            const sec = ($('#moveRoomSection') || {}).value || 'inbox';
            const rs = await cmd({ cmd: 'moveRoom', id, sectionId: sec });
            if (rs) S.roomsState = rs;
            S.modal = null; render(); break;
        }

        case 'set': {
            const k = el.dataset.key, v = +el.dataset.val;
            if (k === 'theme') { S.theme = v; lsSet('theme', v); applyTheme(); render(); } else save({ [k]: v });
            break;
        }
        case 'accent': S.accent = +el.dataset.i; lsSet('accent', S.accent); applyTheme(); render(); break;
        case 'pickMpv': { const f = await cmd({ cmd: 'pickFile' }); if (f) save({ mpvPath: f }); break; }
        case 'logs': S.modal = 'logs'; render(); break;
        case 'closeModal': S.modal = null; S.modalId = null; render(); break;
        case 'logout': if (confirm('تسجيل الخروج؟ سيُحذف الربط مع واتساب.')) cmd({ cmd: 'logout' }); break;
        case 'switchMode': await cmd({ cmd: 'setMode', mode: null }); location.href = 'index.html?choose=1'; break;
        case 'quit': cmd({ cmd: 'quit' }); break;
        default: break;
    }
});

document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-set]'); if (!el) return;
    const k = el.dataset.set;
    if (el.type === 'checkbox') save({ [k]: el.checked });
    else if (el.type === 'number') save({ [k]: Math.max(0, parseInt(el.value, 10) || 0) });
    else save({ [k]: el.value });
});

// ───────────── البدء ─────────────
(async function init() {
    applyTheme();
    render();
    window.desktop.onEvent(onEvent);
    const st = await window.desktop.cmd({ cmd: 'getState' });
    S.ready = true;
    if (st) {
        S.conn = st.conn; S.registered = st.registered; S.code = st.code || ''; S.paused = !!st.paused;
        S.jobs = st.jobs || []; S.settings = st.settings || {}; S.stream = st.stream || null;
        S.mpv = st.mpv || S.mpv; S.fatal = st.fatal || ''; S.logs = st.logs || []; S.engineUp = true;
        if (st.roomsState) S.roomsState = st.roomsState;
    }
    // فحص الغرف المكتملة منتهية العشر ساعات عند فتح شاشة المشاهدة
    const rs = await window.desktop.cmd({ cmd: 'checkCleanup' });
    if (rs) S.roomsState = rs;
    render();
    // تحديث عدّاد المهلة المتبقية كل دقيقة
    setInterval(() => { if (S.tab === 0 && !showLogin()) render(); }, 60000);
})();

