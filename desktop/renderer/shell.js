'use strict';
// صفحة البداية: ① تسجيل الرقم مرة واحدة  ② اختيار الوضع (مشاهدة / تحميل).
// بعد ذلك الرقم نفسه يُستخدم في الوضعين، ويمكن التبديل بينهما في أي وقت.
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

const THEMES = [
    { name: 'ليلي عصري', bg: '#0A1224', surface: '#111D38', surface2: '#1B2B4D', text: '#EAF1FF', sub: '#8FA3C7', accent: '#3D8BFF', dark: true },
    { name: 'نهاري', bg: '#F3F5F9', surface: '#FFFFFF', surface2: '#E8ECF3', text: '#14171F', sub: '#5B6475', accent: '#2563EB', dark: false },
    { name: 'AMOLED', bg: '#000000', surface: '#0D0D0F', surface2: '#1A1A1F', text: '#FFFFFF', sub: '#8A8F9C', accent: '#3D8BFF', dark: true },
    { name: 'بنفسجي', bg: '#160B2A', surface: '#22123F', surface2: '#301A5C', text: '#F3EDFF', sub: '#B3A1D9', accent: '#8B5CF6', dark: true },
    { name: 'زمردي', bg: '#071A13', surface: '#0C2B20', surface2: '#143A2C', text: '#E9FFF6', sub: '#93C4AE', accent: '#10B981', dark: true }
];
const ACCENTS = ['#3D8BFF', '#8B5CF6', '#10B981', '#F59E0B', '#EF4444', '#EC4899'];
const ls = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } };
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

let curTheme = initialTheme();
function applyTheme() {
    const t = THEMES[curTheme];
    const av = ls('accent', null);
    const a = av === null ? t.accent : ACCENTS[Math.min(ACCENTS.length - 1, parseInt(av, 10) || 0)];
    const r = document.documentElement.style;
    r.setProperty('--bg', t.bg); r.setProperty('--surface', t.surface); r.setProperty('--surface2', t.surface2);
    r.setProperty('--text', t.text); r.setProperty('--sub', t.sub); r.setProperty('--accent', a);
    r.colorScheme = t.dark ? 'dark' : 'light';
}
applyTheme();

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cmd = (c) => window.desktop.cmd(c);

const S = { conn: 'idle', registered: false, code: '', err: '', pairing: false, engineUp: false, ready: false, phone: '', logs: [], remember: false, fatal: '' };

const connText = (c) => ({
    open: 'متصل', connecting: 'جارٍ الاتصال…', reconnecting: 'إعادة الاتصال…', pairing: 'بانتظار إدخال الرمز',
    replaced: 'فُتحت جلسة أخرى بنفس الحساب', needpair: 'غير مسجّل', loggedout: 'غير مسجّل'
}[c] || 'تشغيل المحرك…');

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
          <div class="sub">أدخل رقمك مرة واحدة مع رمز الدولة بدون + (يُستخدم في المشاهدة والتحميل)</div>
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
    return `<div class="login"><div class="logo">⬡</div><h1>WA Hub 3</h1>
      <div class="sub">سجّل الدخول مرة واحدة وتُحفظ الجلسة</div>${card}${diag}</div>`;
}

function chooserHTML() {
    return `
      <div class="login">
        <div class="logo">⬡</div>
        <h1>WA Hub 3</h1>
        <div class="sub">اختر ما تريد فعله</div>
        <div class="card click choice" data-mode="watch">
          <div class="ico">▶</div>
          <div><b>مشاهدة</b><div class="sub">استقبال الأجزاء من الشات وحفظها في غرف منظمة للتشغيل عند الطلب</div></div></div>
        <div class="card click choice" data-mode="download">
          <div class="ico">⬇</div>
          <div><b>تحميل</b><div class="sub">تحميل الملفات التي تصل إلى الشات وحفظها في مجلدك</div></div></div>
        <div class="card"><div class="title">المظهر</div>
          <div class="chips">${THEMES.map((t, i) => `<div class="chip ${i === curTheme ? 'on' : ''}" data-act="theme" data-i="${i}">${esc(t.name)}</div>`).join('')}</div></div>
        <div class="toggle"><span class="sub" style="font-size:13px">تذكّر اختياري ولا تسأل مجدداً</span>
          <label class="switch"><input type="checkbox" id="rem" ${S.remember ? 'checked' : ''}><b></b></label></div>
        <div class="row" style="margin-top:14px;justify-content:center">
          <span class="pill ${S.conn === 'open' ? 'green' : 'amber'}">${connText(S.conn)}</span>
          <button class="text red" data-act="logout">تسجيل الخروج</button></div>
      </div>`;
}

function render() {
    const app = $('#app'); if (!app || !S.ready) return;
    const banner = S.fatal ? `<div class="banner" data-act="copyFatal">${esc(S.fatal)}\n(اضغط للنسخ)</div>` : '';
    app.innerHTML = banner + (showLogin() ? loginHTML() : chooserHTML());
    const ph = $('#phone'); if (ph) ph.addEventListener('input', () => { S.phone = ph.value.replace(/[^0-9]/g, ''); });
}

function onEvent(o) {
    switch (o.t) {
        case 'state':
            S.conn = o.conn; S.registered = !!o.registered; S.engineUp = true;
            if (o.conn === 'open') { S.pairing = false; S.code = ''; S.err = ''; }
            if (o.conn === 'needpair' || o.conn === 'loggedout') { S.pairing = false; S.code = ''; }
            render(); break;
        case 'code': S.code = o.code; render(); break;
        case 'error': S.err = o.msg; S.pairing = false; render(); break;
        case 'log': S.logs.push(o.msg); if (S.logs.length > 150) S.logs.shift(); if (showLogin()) render(); break;
        default: break;
    }
}

document.addEventListener('click', async (e) => {
    const modeEl = e.target.closest('[data-mode]');
    if (modeEl) {
        const rem = $('#rem');
        await cmd({ cmd: 'setMode', mode: modeEl.dataset.mode, remember: rem ? rem.checked : false });
        location.href = modeEl.dataset.mode + '.html' + location.search.replace(/[?&]choose=1/, '');
        return;
    }
    const el = e.target.closest('[data-act]'); if (!el) return;
    switch (el.dataset.act) {
        case 'pair': {
            const ph = $('#phone'); if (ph) S.phone = ph.value.replace(/[^0-9]/g, '');
            if (S.phone.length < 8) { S.err = 'أدخل رقماً صحيحاً مع رمز الدولة'; render(); break; }
            S.pairing = true; S.err = ''; S.code = ''; render();
            cmd({ cmd: 'pair', phone: S.phone }); break;
        }
        case 'cancelPair': S.pairing = false; S.code = ''; render(); cmd({ cmd: 'logout' }); break;
        case 'copyCode': try { await navigator.clipboard.writeText(S.code.replace('-', '')); } catch (_) {} break;
        case 'copyFatal': try { await navigator.clipboard.writeText(S.fatal); } catch (_) {} break;
        case 'diag': S.logs.push('…بدء الفحص'); render(); cmd({ cmd: 'diag' }); break;
        case 'theme': curTheme = +el.dataset.i; try { localStorage.setItem('theme', String(curTheme)); } catch (_) {} applyTheme(); render(); break;
        case 'logout': if (confirm('تسجيل الخروج؟ سيُحذف الربط مع واتساب.')) cmd({ cmd: 'logout' }); break;
        default: break;
    }
});

(async function init() {
    window.desktop.onEvent(onEvent);
    const st = await cmd({ cmd: 'getState' });
    const m = await cmd({ cmd: 'getMode' });
    S.ready = true;
    if (st) { S.conn = st.conn; S.registered = st.registered; S.code = st.code || ''; S.logs = st.logs || []; S.fatal = st.fatal || ''; S.engineUp = true; }
    S.remember = !!(m && m.remember);
    render();
})();
