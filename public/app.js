'use strict';
/* BotNest frontend: SPA بدون مكتبات. التوجيه بالـ hash، والـ token في localStorage. */
const $app = document.getElementById('app');
const state = { user: null, cfg: null, cleanup: null };

// ---------- أدوات ----------
const store = {
  get() { try { return localStorage.getItem('bn_token') || ''; } catch { return ''; } },
  set(t) { try { t ? localStorage.setItem('bn_token', t) : localStorage.removeItem('bn_token'); } catch { /* تمام */ } }
};

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICONS = {
  menu: 'M3 6h18M3 12h18M3 18h18',
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 4-6 8-6s8 2 8 6',
  console: 'M4 5l6 7-6 7M12 19h8',
  folder: 'M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V6z',
  play: 'M7 4l13 8-13 8V4z',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  plus: 'M12 5v14M5 12h14',
  users: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  cpu: 'M7 7h10v10H7zM9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3',
  clock: 'M12 7v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z',
  disk: 'M3 12h18M5 5h14l2 7v7H3v-7l2-7zM7 16h.01',
  ram: 'M3 8h18v8H3zM7 8v8M11 8v8M15 8v8M19 8v8',
  code: 'M8 6l-6 6 6 6M16 6l6 6-6 6',
  phone: 'M7 2h10a2 2 0 012 2v16a2 2 0 01-2 2H7a2 2 0 01-2-2V4a2 2 0 012-2zM11 18h2',
  refresh: 'M3 12a9 9 0 0115-6.7L21 8M21 3v5h-5M21 12a9 9 0 01-15 6.7L3 16M3 21v-5h5'
};
function icon(name, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ic' + (name === 'play' ? ' fill' : '') + (cls ? ' ' + cls : ''));
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name]); s.append(p);
  return s;
}

function toast(msg, bad) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), bad ? 5000 : 2800);
}

async function api(method, path, body, opts = {}) {
  const headers = {};
  const tk = store.get();
  if (tk) headers.Authorization = 'Bearer ' + tk;
  let payload = body;
  if (body !== undefined && !(body instanceof ArrayBuffer) && !(body instanceof Blob) && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(path, { method, headers, body: payload, signal: opts.signal }); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new Error('مفيش اتصال بالسيرفر'); }
  if (opts.raw) return res;
  let data = {};
  try { data = await res.json(); } catch { /* فاضي */ }
  if (!res.ok) {
    if (res.status === 401 && tk) { store.set(''); state.user = null; location.hash = '#/login'; }
    throw new Error(data.error || 'حصل خطأ (' + res.status + ')');
  }
  return data;
}

const go = (p) => { location.hash = p; };
const rtLabel = { node: 'Node.js', python: 'Python', php: 'PHP' };
const rtShort = { node: 'NODE', python: 'PY', php: 'PHP' };
const chip = (rt, pf) => h('span', { class: 'chip' }, pf === 'whatsapp' ? 'WA · ' : '', rtShort[rt] || rt);
const phaseInfo = {
  running: ['ok', 'شغّال'], starting: ['warn', 'بيشتغل...'], installing: ['warn', 'بيثبّت المكتبات...'],
  backoff: ['warn', 'بيعيد التشغيل'], crashed: ['bad', 'وقع'], failed: ['bad', 'فشل'], stopped: ['bad', 'واقف']
};
const fmtUp = (ts) => {
  if (!ts) return '';
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + ' ث';
  if (s < 3600) return Math.floor(s / 60) + ' د';
  if (s < 86400) return Math.floor(s / 3600) + ' س ' + Math.floor((s % 3600) / 60) + ' د';
  return Math.floor(s / 86400) + ' يوم';
};
const fmtAgo = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'من لحظات';
  if (s < 3600) return 'من ' + Math.floor(s / 60) + ' د';
  if (s < 86400) return 'من ' + Math.floor(s / 3600) + ' س';
  return 'من ' + Math.floor(s / 86400) + ' يوم';
};
const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB');
const siteName = () => (state.cfg && state.cfg.name) || 'vex-hosting';
const copyright = () => `${siteName()} © ${new Date().getFullYear()} • ${(state.cfg && state.cfg.owner) || 'Rinxvex'}`;
const randPass = () => Math.random().toString(36).slice(2, 7) + Math.random().toString(36).slice(2, 9).toUpperCase();

// ---------- الخلفية ----------
(function stars() {
  const box = document.getElementById('stars');
  for (let i = 0; i < 16; i++) {
    const d = document.createElement('i');
    d.style.cssText = `left:${Math.random() * 100}%;top:${Math.random() * 100}%;--x:${Math.round(Math.random() * 90 - 45)}px;--y:${Math.round(Math.random() * 90 - 45)}px;--d:${10 + Math.random() * 14}s;--w:-${Math.random() * 10}s`;
    box.append(d);
  }
})();
function decor(kind) {
  const d = document.getElementById('decor');
  d.replaceChildren();
  document.body.classList.toggle('theme-server', kind === 'server');
  if (kind === 'dash') d.append(h('div', { class: 'moon-line' }), h('div', { class: 'moon' }));
  if (kind === 'login') {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'wave'); svg.setAttribute('viewBox', '0 0 1440 120'); svg.setAttribute('preserveAspectRatio', 'none');
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', 'M0,70 C180,10 330,95 560,62 C760,30 900,18 1100,60 C1250,90 1360,40 1440,52 L1440,120 L0,120 Z');
    svg.append(p); d.append(svg);
  }
}

// ---------- القائمة الجانبية ----------
function closeDrawer() { document.body.classList.remove('drawer-open'); }
function drawerItems(ctx) {
  const u = state.user;
  const items = [];
  if (ctx && ctx.server) {
    items.push(h('h3', null, ctx.server.name));
    for (const [k, label, ic] of [['console', 'الكونسول', 'console'], ctx.server.platform === 'whatsapp' && ['whatsapp', 'ربط واتساب', 'phone'], ['files', 'الملفات', 'folder'], ['startup', 'التشغيل', 'play'], ['settings', 'الإعدادات', 'sliders']].filter(Boolean)) {
      items.push(h('a', { class: 'dnav' + (ctx.tab === k ? ' active' : ''), href: `#/server/${ctx.server.id}/${k}`, onclick: closeDrawer }, icon(ic), label));
    }
    items.push(h('div', { class: 'dsep' }));
  }
  items.push(h('h3', null, 'الحساب'));
  items.push(h('a', { class: 'dnav', href: '#/dash', onclick: closeDrawer }, icon('server'), 'السيرفرات'));
  items.push(h('a', { class: 'dnav', href: '#/account', onclick: closeDrawer }, icon('user'), 'حسابي'));
  if (u && (u.admin || (state.cfg && state.cfg.allowUserCreate))) items.push(h('a', { class: 'dnav', href: '#/create', onclick: closeDrawer }, icon('plus'), 'سيرفر جديد'));
  if (u && u.admin) {
    items.push(h('a', { class: 'dnav', href: '#/admin', onclick: closeDrawer }, icon('shield'), 'الإدارة'));
  }
  items.push(h('button', { class: 'dnav danger', onclick: () => { closeDrawer(); store.set(''); state.user = null; go('#/login'); } }, icon('logout'), 'خروج'));
  return items;
}
function mountDrawer(ctx) {
  document.getElementById('drawer-root') && document.getElementById('drawer-root').remove();
  const root = h('div', { id: 'drawer-root' },
    h('div', { class: 'drawer-bg', onclick: closeDrawer }),
    h('nav', { class: 'drawer', 'aria-label': 'القائمة' }, drawerItems(ctx)));
  document.body.append(root);
}
const openDrawer = () => document.body.classList.add('drawer-open');

function topbar() {
  return h('header', { class: 'topbar' },
    h('button', { class: 'iconbtn', 'aria-label': 'القائمة', onclick: openDrawer }, icon('menu')),
    h('a', { class: 'brand', href: '#/dash' }, h('i', null, icon('server')), siteName()));
}
function bottomNav(active) {
  return h('nav', { class: 'bottom-nav', 'aria-label': 'التنقل' },
    h('a', { class: 'bn' + (active === 'dash' ? ' active' : ''), href: '#/dash', 'aria-label': 'الرئيسية' }, icon('home')),
    h('a', { class: 'bn' + (active === 'account' ? ' active' : ''), href: '#/account', 'aria-label': 'حسابي' }, icon('user')),
    h('button', { class: 'bn', 'aria-label': 'القائمة', onclick: openDrawer }, icon('menu')));
}

function mount(node, kind, ctx) {
  document.title = siteName();
  closeDrawer();
  decor(kind);
  $app.replaceChildren(node);
  if (kind !== 'login') mountDrawer(ctx); else { const d = document.getElementById('drawer-root'); if (d) d.remove(); }
  window.scrollTo(0, 0);
}

// ---------- الدخول ----------
function viewLogin() {
  const err = h('p', { class: 'err', hidden: true, role: 'alert' });
  const email = h('input', { type: 'text', id: 'em', autocomplete: 'username', autocapitalize: 'none', required: true, class: 'ltr' });
  const pass = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', required: true, class: 'ltr' });
  const btn = h('button', { class: 'btn blue block', type: 'submit' }, 'دخول');
  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.hidden = true; btn.disabled = true;
    try {
      const r = await api('POST', '/api/auth/login', { email: email.value, password: pass.value });
      store.set(r.token); state.user = r.user; go('#/dash');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  } },
  err,
  h('div', { class: 'field' }, h('label', { for: 'em' }, 'اسم المستخدم أو الإيميل'), email),
  h('div', { class: 'field' }, h('label', { for: 'pw' }, 'كلمة السر'), pass),
  btn,
  state.cfg.allowSignup && h('a', { class: 'btn block', href: '#/register', style: 'margin-top:10px' }, 'إنشاء حساب جديد'),
  h('button', { type: 'button', class: 'link-muted', onclick: () => toast('كلّم صاحب الموقع عشان يغيّر لك كلمة السر') }, 'نسيت كلمة السر؟'));
  mount(h('div', { class: 'center' }, h('div', { class: 'auth' },
    h('h1', null, 'سجّل الدخول للمتابعة'), form, h('p', { class: 'copy' }, copyright()))), 'login');
}

function viewRegister() {
  if (!state.cfg.allowSignup) return go('#/login');
  const err = h('p', { class: 'err', hidden: true, role: 'alert' });
  const email = h('input', { type: 'text', id: 'rem', autocomplete: 'username', autocapitalize: 'none', required: true, class: 'ltr' });
  const pass = h('input', { type: 'password', id: 'rpw', autocomplete: 'new-password', required: true, class: 'ltr' });
  const btn = h('button', { class: 'btn blue block', type: 'submit' }, 'إنشاء الحساب');
  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true; btn.disabled = true;
    try {
      const r = await api('POST', '/api/auth/register', { email: email.value, password: pass.value });
      store.set(r.token); state.user = r.user; go('#/dash');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  } }, err,
  h('div', { class: 'field' }, h('label', { for: 'rem' }, 'اسم المستخدم أو الإيميل'), email),
  h('div', { class: 'field' }, h('label', { for: 'rpw' }, 'كلمة السر'), pass, h('small', null, '8 حروف على الأقل')),
  btn, h('a', { class: 'link-muted', href: '#/login', style: 'display:block;text-align:center;margin-top:12px' }, 'عندي حساب'));
  mount(h('div', { class: 'center' }, h('div', { class: 'auth' }, h('h1', null, 'حساب جديد'), form, h('p', { class: 'copy' }, copyright()))), 'login');
}

// ---------- لوحة السيرفرات ----------
async function viewDash() {
  if (!state.user) return go('#/login');
  const admin = state.user.admin;
  let alive = true, timer = null, servers = [];
  state.cleanup = () => { alive = false; clearInterval(timer); };
  const list = h('div');
  const draw = () => {
    if (!servers.length) {
      list.replaceChildren(h('div', { class: 'empty' }, 'مفيش سيرفرات لسه. اعمل أول سيرفر.'));
      return;
    }
    list.replaceChildren(...servers.map((b) => {
      const ph = b.status.phase, [cls, label] = phaseInfo[ph] || ['bad', ph];
      const on = ph !== 'stopped' && ph !== 'failed';
      return h('a', { class: 'srv', href: '#/server/' + b.id },
        h('div', { class: 'srv-head' },
          h('div', { class: 'srv-ic' }, icon('server')),
          h('div', { style: 'min-width:0;flex:1' },
            h('div', { class: 'srv-name' }, b.name, chip(b.runtime, b.platform)),
            h('div', { class: 'srv-sub' + (admin && b.owner ? '' : ' ar') }, admin && b.owner ? b.owner : (b.username ? '@' + b.username : label))),
          h('span', { class: 'dot ' + (cls === 'bad' && ph === 'stopped' ? '' : cls), title: label })),
        h('div', { class: 'pills' },
          h('div', { class: 'stat' }, icon('cpu'), (on ? (b.status.cpu || 0).toFixed(2) : '0.00') + ' %'),
          h('div', { class: 'stat' }, icon('ram'), (on ? b.status.rssMb || 0 : 0) + ' MB'),
          h('div', { class: 'stat' }, icon('clock'), ph === 'running' ? fmtUp(b.status.startedAt) : label)));
    }));
  };
  async function refresh() {
    try { servers = admin ? (await api('GET', '/api/admin/bots')).bots : (await api('GET', '/api/bots')).bots; if (alive) draw(); }
    catch (e) { if (alive) toast(e.message, true); }
  }
  await refresh();
  if (!alive) return;
  mount(h('div', { class: 'page' },
    h('div', { class: 'page-title' }, h('h1', null, 'السيرفرات')),
    list,
    (admin || state.cfg.allowUserCreate) && h('a', { class: 'add-card', href: '#/create' }, icon('plus'), 'سيرفر جديد'),
    h('p', { class: 'foot-copy' }, copyright()),
    bottomNav('dash')), 'dash');
  draw();
  timer = setInterval(refresh, 4000);
}

// ---------- الحساب ----------
async function viewAccount() {
  if (!state.user) return go('#/login');
  let me = state.user;
  try { me = { ...me, ...(await api('GET', '/api/me')) }; } catch { /* تمام */ }
  const cfg = state.cfg;
  const err = h('p', { class: 'err', hidden: true, role: 'alert' });
  const oldp = h('input', { type: 'password', id: 'op', autocomplete: 'current-password', class: 'ltr' });
  const newp = h('input', { type: 'password', id: 'np', autocomplete: 'new-password', class: 'ltr' });
  const tgBox = h('div');
  const drawTg = () => {
    tgBox.replaceChildren(me.tgLinked
      ? h('div', null, h('p', { class: 'ok-note' }, '✅ حسابك داخل في بوت تلجرم.'),
        h('button', { class: 'btn sm', onclick: async () => { try { await api('DELETE', '/api/me/tg-link'); me.tgLinked = false; drawTg(); } catch (e) { toast(e.message, true); } } }, 'تسجيل الخروج من البوت'))
      : h('p', { style: 'color:var(--muted);margin:0' }, cfg.controlBot
        ? ['افتح ', h('a', { href: 'https://t.me/' + cfg.controlBot, target: '_blank', rel: 'noopener', class: 'ltr', style: 'color:#93c5fd' }, '@' + cfg.controlBot), ' وابعت /login ودخّل نفس الإيميل وكلمة السر. وتقدر ترفع ملفاتك وتشغّل من هناك.']
        : 'بوت التحكم مش متفعّل على الموقع ده.'));
  };
  drawTg();
  mount(h('div', { class: 'page narrow' },
    h('div', { class: 'page-title' }, h('h1', null, 'حسابي')),
    h('div', { class: 'card' }, h('div', { class: 'lbl' }, 'الاسم'), h('div', { class: 'ltr', style: 'font-size:18px;margin-top:4px' }, me.email, me.admin ? '  ★' : '')),
    h('form', { class: 'card', novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); err.hidden = true;
      try { await api('POST', '/api/me/password', { old: oldp.value, password: newp.value }); toast('اتغيّرت كلمة السر'); oldp.value = ''; newp.value = ''; }
      catch (ex) { err.textContent = ex.message; err.hidden = false; }
    } },
    h('h2', null, 'تغيير كلمة السر'), err,
    h('div', { class: 'field' }, h('label', { for: 'op' }, 'كلمة السر الحالية'), oldp),
    h('div', { class: 'field' }, h('label', { for: 'np' }, 'كلمة السر الجديدة'), newp, h('small', null, '8 حروف على الأقل')),
    h('button', { class: 'btn blue', type: 'submit' }, 'حفظ')),
    h('div', { class: 'card' }, h('h2', null, 'بوت تلجرم'), tgBox),
    h('p', { class: 'foot-copy' }, copyright()),
    bottomNav('account')), 'dash');
}

// ---------- إنشاء سيرفر (للمدير) ----------
function viewCreate() {
  if (!state.user) return go('#/login');
  const isAdm = state.user.admin;
  if (!isAdm && !state.cfg.allowUserCreate) return go('#/dash');
  const rts = state.cfg.runtimes;
  const php = state.cfg.phpStatus || {};
  let chosen = 'node', platform = 'telegram';
  const err = h('p', { class: 'err', hidden: true, role: 'alert' });
  const name = h('input', { type: 'text', id: 'sn', maxlength: 32, autocomplete: 'off', required: true });
  const email = h('input', { type: 'text', id: 'se', autocomplete: 'off', autocapitalize: 'none', class: 'ltr', required: isAdm, placeholder: 'ahmed أو ahmed@mail.com' });
  const pass = h('input', { type: 'text', id: 'sp', autocomplete: 'off', class: 'ltr', value: randPass() });
  const token = h('input', { type: 'password', id: 'st', autocomplete: 'off', class: 'ltr', placeholder: '123456789:AA...' });
  const phpMode = h('select', { id: 'pm' },
    h('option', { value: 'webhook' }, 'شبه Webhook (الكود بيشتغل مع كل رسالة)'),
    h('option', { value: 'long' }, 'Long polling (سكربت شغال دايمًا)'));
  const phpField = h('div', { class: 'field', hidden: true }, h('label', { for: 'pm' }, 'وضع PHP'), phpMode);
  const sub = (r) => (r === 'php' && !rts.php.ok ? (php.state === 'installing' ? 'بيتثبت...' : 'هيتثبت تلقائي') : rts[r] && rts[r].ok ? 'v' + (rts[r].version || '') : 'مش متاح');
  const pick = h('div', { class: 'rt-pick', role: 'radiogroup', 'aria-label': 'اللغة' },
    ['node', 'python', 'php'].map((r) => h('label', { class: 'rt' },
      h('input', { type: 'radio', name: 'rt', value: r, checked: r === 'node', disabled: r === 'python' && !rts.python.ok, onchange: () => { chosen = r; phpField.hidden = r !== 'php' || platform === 'whatsapp'; } }),
      h('span', null, h('b', null, rtLabel[r]), h('small', null, sub(r))))));
  const tokenBox = h('details', { class: 'more' }, h('summary', null, 'توكن البوت (اختياري، تقدر تضيفه بعدين)'), h('div', { class: 'field', style: 'margin:0' }, token));
  const waNote = h('p', { class: 'note', hidden: true }, 'بوت واتساب (Baileys وغيره) من غير توكن. بعد الإنشاء ارفع الملفات وشغّله، وهيظهر لك الـ QR أو كود الربط في الكونسول.');
  const platPick = h('div', { class: 'rt-pick', role: 'radiogroup', 'aria-label': 'المنصة' },
    [['telegram', 'تلجرم', 'بوت بتوكن'], ['whatsapp', 'واتساب', 'ربط بـ QR أو كود']].map(([k, t, s2]) => h('label', { class: 'rt' },
      h('input', { type: 'radio', name: 'pf', value: k, checked: k === 'telegram', onchange: () => {
        platform = k; tokenBox.hidden = k === 'whatsapp'; waNote.hidden = k !== 'whatsapp';
        if (k === 'whatsapp') { phpField.hidden = true; }
        else phpField.hidden = chosen !== 'php';
      } }), h('span', null, h('b', null, t), h('small', null, s2)))));
  const btn = h('button', { class: 'btn blue block', type: 'submit' }, 'إنشاء السيرفر');
  const result = h('div');
  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true; btn.disabled = true; result.replaceChildren();
    try {
      const body = { name: name.value, runtime: chosen, platform, mode: phpMode.value, token: platform === 'whatsapp' ? '' : token.value.trim() };
      const r = isAdm ? await api('POST', '/api/admin/servers', { ...body, email: email.value, password: pass.value }) : await api('POST', '/api/bots', body);
      toast('اتعمل السيرفر');
      if (isAdm && r.accountCreated) {
        result.replaceChildren(h('div', { class: 'cred' }, 'الحساب: ' + email.value.trim().toLowerCase(), h('br'), 'كلمة السر: ' + pass.value),
          h('p', { class: 'note' }, 'انسخ البيانات وابعتها لصاحب الحساب. كلمة السر مش هتظهر تاني.'),
          h('a', { class: 'btn block', href: '#/server/' + r.id }, 'افتح السيرفر'));
        btn.hidden = true;
      } else go('#/server/' + r.id);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  } },
  err,
  h('div', { class: 'field' }, h('label', { for: 'sn' }, 'اسم السيرفر'), name),
  isAdm && h('div', { class: 'field' }, h('label', { for: 'se' }, 'الإيميل أو اسم المستخدم'), email, h('small', null, 'لو الحساب موجود هيتضاف له السيرفر. لو جديد هيتعمل بالباسورد اللي تحت.')),
  isAdm && h('div', { class: 'field' }, h('label', { for: 'sp' }, 'كلمة السر'), pass, h('small', null, 'اتولّدت تلقائي. بتتستخدم بس لو الحساب جديد.')),
  h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'المنصة'), platPick),
  h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'نوع الاستضافة'), pick),
  phpField, waNote,
  tokenBox,
  btn, result);
  mount(h('div', { class: 'center' }, h('div', { class: 'auth' },
    h('h1', null, 'سيرفر جديد'), form, h('p', { class: 'copy' }, copyright()))), 'dash');
  // الصفحة دي بتتعرض بنفس خلفية الدخول (من غير موجة)، مع القائمة الجانبية
  $app.prepend(topbar());
}

// ---------- صفحة السيرفر ----------
async function viewServer(id, tab) {
  if (!state.user) return go('#/login');
  tab = ['console', 'files', 'startup', 'settings', 'whatsapp'].includes(tab) ? tab : 'console';
  let bot;
  try { bot = await api('GET', '/api/bots/' + id); } catch (e) { toast(e.message, true); return go('#/dash'); }
  let alive = true, timer = null, abort = null, disk = bot.diskBytes || 0;
  const cpuS = [], memS = [];
  state.cleanup = () => { alive = false; clearInterval(timer); if (abort) abort.abort(); };

  const head = h('div', { class: 'shead' });
  const body = h('div');
  const reload = async () => { bot = Object.assign(bot, await api('GET', '/api/bots/' + id)); disk = bot.diskBytes || disk; drawHead(); };
  const act = async (what, btn) => {
    btn.disabled = true;
    try { Object.assign(bot, await api('POST', `/api/bots/${id}/${what}`)); drawHead(); }
    catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
  };
  function drawHead() {
    const ph = bot.status.phase, [cls, label] = phaseInfo[ph] || ['bad', ph];
    const on = ph !== 'stopped' && ph !== 'failed';
    head.replaceChildren(
      h('div', { class: 'nm' }, h('h1', null, bot.name), h('span', { class: 'badge ' + (cls === 'bad' ? '' : cls) }, h('span', { class: 'dot ' + (cls === 'bad' ? 'bad' : cls) }), label)),
      h('div', { class: 'acts' },
        h('button', { class: 'btn green', disabled: on, onclick: (e) => act('start', e.currentTarget) }, 'تشغيل'),
        h('button', { class: 'btn', disabled: !on, onclick: (e) => act('restart', e.currentTarget) }, 'إعادة'),
        h('button', { class: 'btn red', disabled: !on, onclick: (e) => act('stop', e.currentTarget) }, 'إيقاف')));
    if (bot.status.lastError && !on) head.append(h('p', { class: 'err', style: 'flex-basis:100%;margin:0' }, bot.status.lastError));
    updateTiles();
  }

  // --- الكونسول ---
  const tiles = h('div', { class: 'tiles' });
  function updateTiles() {
    const s = bot.status, on = s.phase !== 'stopped' && s.phase !== 'failed';
    const quota = (state.cfg.limits.maxUnzippedMb || 0) * 1048576;
    const t = (ic, label, val, red) => h('div', { class: 'tile' }, h('div', { class: 'ti' + (red ? ' red' : '') }, icon(ic)), h('div', { class: 'tx' }, h('small', null, label), h('b', null, val)));
    tiles.replaceChildren(
      t('code', 'اللغة', rtLabel[bot.runtime] + (bot.runtime === 'php' ? (bot.mode === 'long' ? ' · long' : ' · webhook') : '')),
      t('clock', 'مدة التشغيل', s.phase === 'running' ? fmtUp(s.startedAt) : 'متوقف', !on),
      t('cpu', 'المعالج', on ? (s.cpu || 0).toFixed(2) + ' %' : 'متوقف', !on),
      t('ram', 'الذاكرة', on ? `${s.rssMb || 0} MiB / ${state.cfg.limits.botMemMb || '∞'}${state.cfg.limits.botMemMb ? ' MiB' : ''}` : 'متوقف', !on),
      t('disk', 'القرص', fmtSize(disk) + ' / ' + (quota ? fmtSize(quota) : '∞')),
      t('refresh', 'إعادة التشغيل التلقائي', String(s.restarts || 0)));
  }
  function chartBox(title, series, max, unit) {
    const W = 300, H = 120, L = 34, B = 14;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', title);
    const el = (n, a) => { const e = document.createElementNS(NS, n); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); svg.append(e); return e; };
    for (let i = 0; i <= 2; i++) {
      const y = 6 + (H - B - 6) * (i / 2);
      el('line', { x1: L, x2: W, y1: y, y2: y, class: 'g' });
      const t = el('text', { x: L - 4, y: y + 3, class: 'ax', 'text-anchor': 'end' }); t.textContent = (max * (1 - i / 2)).toFixed(max <= 100 ? 0 : 0) + unit;
    }
    const n = series.length;
    if (n > 1) {
      const pts = series.map((v, i) => `${(L + (W - L) * (i / 59)).toFixed(1)},${(6 + (H - B - 6) * (1 - Math.min(v, max) / max)).toFixed(1)}`);
      el('polygon', { points: `${L},${H - B} ${pts.join(' ')} ${(L + (W - L) * ((n - 1) / 59)).toFixed(1)},${H - B}`, class: 'ar' });
      el('polyline', { points: pts.join(' '), class: 'ln' });
    }
    return h('div', { class: 'chart' }, h('h4', null, title), svg);
  }
  const charts = h('div', { class: 'charts' });
  function drawCharts() {
    charts.replaceChildren(chartBox('المعالج', cpuS, 100, '%'), chartBox('الذاكرة', memS, state.cfg.limits.botMemMb || Math.max(256, Math.ceil(Math.max(0, ...memS) * 1.3 / 64) * 64), 'MB'));
  }

  const pairBox = h('div', { class: 'pair', hidden: true });
  function showPair(c) {
    pairBox.replaceChildren(h('small', null, 'كود الربط. افتح واتساب > الأجهزة المرتبطة > ربط برقم الهاتف وادخله:'), h('b', { class: 'ltr' }, c));
    pairBox.hidden = false;
  }
  function tabConsole() {
    const pre = h('pre', { 'aria-live': 'off', tabindex: 0 });
    const copyBtn = h('button', { class: 'copy-logs', onclick: async () => {
      try { await navigator.clipboard.writeText(pre.innerText); toast('اتنسخ السجل'); } catch { toast('تعذّر النسخ', true); }
    } }, icon('copy'), 'نسخ السجل');
    const box = h('div', { class: 'console' }, copyBtn, pre, h('div', { class: 'bar' }, h('span', null, '»'), h('span', null, bot.status.phase === 'running' ? 'LIVE' : 'OFFLINE')));
    const ac = new AbortController(); abort = ac;
    (async () => {
      try {
        const res = await api('GET', `/api/bots/${id}/logs`, undefined, { raw: true, signal: ac.signal });
        if (!res.ok) throw new Error('تعذر فتح السجل');
        const rd = res.body.getReader(), dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const ev = buf.slice(0, i); buf = buf.slice(i + 2);
            if (!ev.startsWith('data: ')) continue;
            let line = '';
            try { line = JSON.parse(ev.slice(6)); } catch { continue; }
            const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
            const isQr = /[█▀▄]{4}/.test(line);
            const code = line.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
            if (code && /pair|code|كود|ربط/i.test(line) && bot.platform === 'whatsapp') showPair(code[1]);
            pre.append(h('div', { class: isQr ? 'qr' : /^\[(botnest|platform)/i.test(line) ? 'sysl' : '' }, line || ' '));
            while (pre.childElementCount > 800) pre.firstChild.remove();
            if (stick) pre.scrollTop = pre.scrollHeight;
          }
        }
      } catch (e) { if (e.name !== 'AbortError') pre.append(h('div', { class: 'sysl' }, '— انقطع السجل: ' + e.message)); }
    })();
    updateTiles(); drawCharts();
    return h('div', { style: 'display:flex;flex-direction:column;gap:14px' }, pairBox, box, tiles, charts);
  }

  // --- الملفات ---
  function tabFiles() {
    let dir = '', items = [], used = 0, q = '';
    const sel = new Set();
    let dirty = false;
    const crumbs = h('div', { class: 'crumbs' });
    const listEl = h('div', { role: 'list' });
    const usage = h('small', { class: 'fm-use' });
    const editorBox = h('div', { class: 'fedit', hidden: true });
    const join = (a, b) => (a ? a + '/' + b : b);
    const enc = encodeURIComponent;
    const status = h('small', { class: 'fm-status', 'aria-live': 'polite' });

    const search = h('input', { type: 'search', placeholder: 'بحث', 'aria-label': 'بحث في الملفات', oninput: (e) => { q = e.target.value.trim().toLowerCase(); draw(); } });
    const delBtn = h('button', { class: 'btn sm red', disabled: true, onclick: async () => {
      if (!sel.size || !confirm('تحذف ' + sel.size + ' عنصر؟')) return;
      try { await api('POST', `/api/bots/${id}/delete`, { names: [...sel].map((n) => join(dir, n)) }); sel.clear(); await load(); toast('اتحذف'); } catch (e) { toast(e.message, true); }
    } }, 'حذف');
    const pickFiles = h('input', { type: 'file', multiple: true, hidden: true });
    const pickFolder = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true });
    const pickZip = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true });

    // رفع بـ XHR عشان نعرض نسبة التقدم والسرعة
    function xhrSend(method, url, blob, onProg) {
      return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open(method, url);
        const tk = store.get(); if (tk) x.setRequestHeader('Authorization', 'Bearer ' + tk);
        if (onProg) x.upload.onprogress = (e) => e.lengthComputable && onProg(e.loaded, e.total);
        x.onload = () => {
          let d = {}; try { d = JSON.parse(x.responseText); } catch { /* فاضي */ }
          x.status >= 200 && x.status < 300 ? resolve(d) : reject(new Error(d.error || 'حصل خطأ (' + x.status + ')'));
        };
        x.onerror = () => reject(new Error('انقطع الاتصال أثناء الرفع'));
        x.send(blob);
      });
    }
    async function uploadMany(files, useRel) {
      const arr = [...files];
      if (!arr.length) return;
      let ok = 0, doneBytes = 0; const bad = [];
      const total = arr.reduce((n, f) => n + f.size, 0) || 1;
      const part = new Map(); const t0 = Date.now();
      const show = () => {
        const sent = doneBytes + [...part.values()].reduce((n, v) => n + v, 0);
        const sp = sent / Math.max(1, (Date.now() - t0) / 1000);
        status.textContent = `بيرفع ${ok}/${arr.length} · ${Math.min(100, Math.round(sent * 100 / total))}% · ${fmtSize(sp)}/ث`;
      };
      let idx = 0, stop = false;
      const worker = async () => {
        while (!stop && idx < arr.length) {
          const f = arr[idx++];
          const rel = useRel && f.webkitRelativePath ? f.webkitRelativePath : f.name;
          try {
            const r = await xhrSend('POST', `/api/bots/${id}/upload?name=${enc(join(dir, rel))}`, f, (l) => { part.set(f, l); show(); });
            if (r.switched) toast('اللغة اتعرّفت: ' + rtLabel[r.runtime]);
            ok++;
          } catch (e) { bad.push(rel + ': ' + e.message); if (/المساحة|كبير/.test(e.message)) stop = true; }
          part.delete(f); doneBytes += f.size; show();
        }
      };
      // 5 ملفات في نفس الوقت
      await Promise.all(Array.from({ length: Math.min(5, arr.length) }, worker));
      status.textContent = '';
      toast(`اترفع ${ok} من ${arr.length}`, bad.length > 0);
      if (bad.length) toast(bad[0], true);
      await load(); await reload();
    }
    pickFiles.addEventListener('change', async () => { await uploadMany(pickFiles.files, false); pickFiles.value = ''; });
    pickFolder.addEventListener('change', async () => { await uploadMany(pickFolder.files, true); pickFolder.value = ''; });
    pickZip.addEventListener('change', async () => {
      const f = pickZip.files[0]; pickZip.value = '';
      if (!f) return;
      if (bot.status.phase !== 'stopped') return toast('وقّف السيرفر الأول', true);
      const clean = confirm('تمسح الملفات القديمة قبل فك الضغط؟\nموافق = امسح، إلغاء = خليهم');
      status.textContent = 'بيرفع 0%';
      const t0 = Date.now();
      try {
        const r = await xhrSend('PUT', `/api/bots/${id}/files${clean ? '?clean=1' : ''}`, f, (l, t) => {
          status.textContent = l >= t ? 'اترفع. بيفك الضغط...' : `بيرفع ${Math.round(l * 100 / t)}% · ${fmtSize(l / Math.max(1, (Date.now() - t0) / 1000))}/ث`;
        });
        toast(`اتفك ${r.files} ملف. اللغة: ${rtLabel[r.runtime]}${r.switched ? ' (اتبدّلت)' : ''}`);
      } catch (e) { toast(e.message, true); }
      status.textContent = ''; await load(); await reload();
    });

    const bar = h('div', { class: 'fm-bar' }, search, delBtn,
      h('button', { class: 'btn sm', onclick: async () => {
        const n = prompt('اسم المجلد'); if (!n) return;
        try { await api('POST', `/api/bots/${id}/mkdir?name=${enc(join(dir, n.trim()))}`); await load(); } catch (e) { toast(e.message, true); }
      } }, '+ مجلد'),
      h('button', { class: 'btn sm', onclick: async () => {
        const n = prompt('اسم الملف الجديد (مثال: bot.js أو bot.py أو bot.php)'); if (!n) return;
        const p = join(dir, n.trim());
        try { await api('POST', `/api/bots/${id}/upload?name=${enc(p)}`, new Blob([''])); await load(); await reload(); await openFile(p); } catch (e) { toast(e.message, true); }
      } }, '+ ملف'),
      h('button', { class: 'btn sm', onclick: () => pickFiles.click() }, '⬆ رفع ملفات'),
      h('button', { class: 'btn sm', onclick: () => pickFolder.click() }, '⬆ رفع مجلد'),
      h('button', { class: 'btn sm blue', onclick: () => pickZip.click() }, '⬆ ZIP وفك الضغط'),
      pickFiles, pickFolder, pickZip);

    async function load() {
      try {
        const r = await api('GET', `/api/bots/${id}/ls?dir=${enc(dir)}`);
        items = r.items; used = r.used; drawCrumbs(); draw();
      } catch (e) { toast(e.message, true); if (dir) { dir = ''; load(); } }
    }
    function drawCrumbs() {
      const parts = dir ? dir.split('/') : [];
      crumbs.replaceChildren(h('button', { onclick: () => go2('') }, '/ home'), ...parts.map((p, i) => h('button', { onclick: () => go2(parts.slice(0, i + 1).join('/')) }, '/ ' + p)));
      usage.textContent = `المساحة المستخدمة: ${fmtSize(used)}`;
    }
    function go2(d) { dir = d; sel.clear(); load(); }
    function draw() {
      delBtn.disabled = sel.size === 0;
      const shown = items.filter((i) => !q || i.name.toLowerCase().includes(q));
      const rows = [];
      if (dir) rows.push(h('div', { class: 'fm-row', role: 'listitem' }, h('span'), h('button', { class: 'fm-name dir', onclick: () => go2(dir.split('/').slice(0, -1).join('/')) }, '📁 ..'), h('span'), h('span'), h('span')));
      for (const it of shown) {
        const isDir = it.type === 'dir';
        const cb = h('input', { type: 'checkbox', 'aria-label': 'تحديد ' + it.name, disabled: it.hidden, checked: sel.has(it.name), onchange: (e) => { e.target.checked ? sel.add(it.name) : sel.delete(it.name); delBtn.disabled = sel.size === 0; } });
        const nameBtn = h('button', { class: 'fm-name' + (isDir ? ' dir' : ''), title: it.name,
          onclick: () => (it.hidden ? toast('مجلد تعتمد عليه المنصة، مش بيتعدّل من هنا', true) : isDir ? go2(join(dir, it.name)) : openFile(join(dir, it.name))) }, (isDir ? '📁 ' : '📄 ') + it.name);
        const more = it.hidden ? h('span') : h('span', { class: 'fm-acts' },
          h('button', { class: 'btn sm', title: 'إعادة تسمية', onclick: () => rename(it) }, '✎'),
          !isDir && h('button', { class: 'btn sm', title: 'تنزيل', onclick: () => download(join(dir, it.name)) }, '⬇'));
        rows.push(h('div', { class: 'fm-row', role: 'listitem' }, cb, nameBtn, h('span', { class: 'fm-size' }, isDir ? '' : fmtSize(it.size)), h('span', { class: 'fm-date' }, fmtAgo(it.mtime)), more));
      }
      if (!shown.length) rows.push(h('div', { class: 'empty', style: 'border:0' }, q ? 'مفيش نتائج.' : 'المجلد فاضي. ارفع ملفات (Node.js أو Python أو PHP) أو اعمل ملف جديد.'));
      listEl.replaceChildren(...rows);
    }
    async function rename(it) {
      const n = prompt('الاسم الجديد', it.name);
      if (!n || n === it.name) return;
      try { await api('POST', `/api/bots/${id}/rename`, { from: join(dir, it.name), to: join(dir, n.trim()) }); await load(); await reload(); } catch (e) { toast(e.message, true); }
    }
    async function download(p) {
      try {
        const res = await api('GET', `/api/bots/${id}/download?name=${enc(p)}`, undefined, { raw: true });
        if (!res.ok) throw new Error('تعذر التنزيل');
        const url = URL.createObjectURL(await res.blob());
        const a = h('a', { href: url, download: p.split('/').pop() }); document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (e) { toast(e.message, true); }
    }
    async function openFile(p) {
      if (dirty && !confirm('في تعديلات مش محفوظة. تتجاهلها؟')) return;
      try {
        const f = await api('GET', `/api/bots/${id}/file?name=${enc(p)}`);
        dirty = false;
        const ta = h('textarea', { spellcheck: 'false', 'aria-label': 'محتوى الملف', value: f.content });
        const save = h('button', { class: 'btn sm blue', disabled: true }, 'حفظ');
        ta.addEventListener('input', () => { dirty = true; save.disabled = false; });
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); dirty = true; save.disabled = false; }
          if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save.click(); }
        });
        save.addEventListener('click', async () => {
          try {
            const r = await api('PUT', `/api/bots/${id}/file?name=${enc(p)}`, ta.value);
            dirty = false; save.disabled = true;
            toast('اتحفظ' + (r.switched ? ' (اللغة اتبدّلت لـ ' + rtLabel[r.runtime] + ')' : '') + (bot.status.phase !== 'stopped' ? '. أعد التشغيل عشان يطبّق' : ''));
            await load(); await reload();
          } catch (e) { toast(e.message, true); }
        });
        const close = h('button', { class: 'btn sm', onclick: () => { if (dirty && !confirm('في تعديلات مش محفوظة. تقفل؟')) return; dirty = false; editorBox.hidden = true; } }, 'قفل');
        editorBox.replaceChildren(h('div', { class: 'head' }, h('span', null, p), h('span', { class: 'row' }, close, save)), ta);
        editorBox.hidden = false;
        editorBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch (e) { toast(e.message, true); }
    }
    load();
    return h('div', null, bar, status, h('div', { class: 'fm-box' }, crumbs, listEl), usage, editorBox);
  }

  // --- التشغيل (ملف التشغيل + المتغيرات) ---
  function tabStartup() {
    const entry = h('input', { type: 'text', class: 'ltr', value: bot.entry, placeholder: bot.detectedEntry || 'اتحدد تلقائي' });
    const saveEntry = h('button', { class: 'btn sm blue', onclick: async () => {
      try { Object.assign(bot, await api('PATCH', '/api/bots/' + id, { entry: entry.value.trim() })); toast('اتحفظ'); drawHead(); } catch (e) { toast(e.message, true); }
    } }, 'حفظ');
    const mode = bot.runtime === 'php' && bot.platform !== 'whatsapp' ? h('div', { class: 'field' }, h('label', { for: 'md' }, 'وضع PHP'),
      h('select', { id: 'md', onchange: async (e) => {
        try { Object.assign(bot, await api('PATCH', '/api/bots/' + id, { mode: e.target.value })); toast('اتحفظ' + (bot.needsRestart ? '. أعد التشغيل' : '')); drawHead(); } catch (x) { toast(x.message, true); }
      } },
      h('option', { value: 'webhook', selected: bot.mode === 'webhook' }, 'شبه Webhook (الكود بيشتغل مع كل رسالة)'),
      h('option', { value: 'long', selected: bot.mode === 'long' }, 'Long polling (سكربت شغال دايمًا)'))) : null;
    const envBox = h('div');
    function drawEnv() {
      envBox.replaceChildren(...bot.envKeys.map((k) => h('div', { class: 'kv' }, h('code', null, k), h('span', { class: 'val' }, '••••••••'),
        h('button', { class: 'btn sm red', onclick: async () => {
          try { Object.assign(bot, await api('PATCH', '/api/bots/' + id, { env: { [k]: null } })); drawEnv(); } catch (e) { toast(e.message, true); }
        } }, 'حذف'))));
      if (!bot.envKeys.length) envBox.append(h('p', { style: 'color:var(--muted);font-size:14px;margin:0 0 10px' }, 'مفيش متغيرات.'));
    }
    const ek = h('input', { type: 'text', placeholder: 'NAME', class: 'ltr', autocapitalize: 'characters', autocomplete: 'off' });
    const ev = h('input', { type: 'text', placeholder: 'value', class: 'ltr', autocomplete: 'off' });
    const addEnv = h('button', { class: 'btn sm blue', onclick: async () => {
      if (!ek.value.trim()) return;
      try { Object.assign(bot, await api('PATCH', '/api/bots/' + id, { env: { [ek.value.trim()]: ev.value } })); ek.value = ''; ev.value = ''; drawEnv(); toast('اتضاف' + (bot.needsRestart ? '. أعد التشغيل' : '')); }
      catch (e) { toast(e.message, true); }
    } }, 'إضافة');
    drawEnv();
    return h('div', null,
      h('div', { class: 'card' }, h('h2', null, 'ملف التشغيل'),
        h('div', { class: 'field' }, h('div', { class: 'kv' }, entry, saveEntry),
          h('small', null, 'سيبه فاضي وهيتحدد تلقائي' + (bot.detectedEntry ? ' (' + bot.detectedEntry + ')' : '') + '. اللغة الحالية: ' + rtLabel[bot.runtime] + '، وبتتبدّل تلقائي لما ترفع ملفات بلغة تانية.')),
        mode),
      h('div', { class: 'card' }, h('h2', null, 'متغيرات البيئة'), envBox, h('div', { class: 'kv' }, ek, ev, addEnv),
        h('small', { style: 'color:var(--dim)' }, 'التوكن متاح للبوت كمتغير BOT_TOKEN. تغيير المتغيرات محتاج إعادة تشغيل.')));
  }

  // --- ربط واتساب ---
  function tabWhatsapp() {
    const envNow = () => bot.envKeys.includes('PHONE_NUMBER');
    const num = h('input', { type: 'tel', class: 'ltr', inputmode: 'numeric', placeholder: '201012345678', autocomplete: 'off' });
    const save = h('button', { class: 'btn sm blue', onclick: async () => {
      const v = num.value.replace(/\D/g, '');
      if (v.length < 8) return toast('اكتب الرقم بالكود الدولي من غير + (مثال 201012345678)', true);
      try { Object.assign(bot, await api('PATCH', '/api/bots/' + id, { env: { PHONE_NUMBER: v, WA_NUMBER: v, BOT_NUMBER: v } })); toast('اتحفظ الرقم. أعد التشغيل' + (bot.status.phase !== 'stopped' ? '' : ' / شغّل')); } catch (e) { toast(e.message, true); }
    } }, 'حفظ الرقم');
    const state = h('p', { class: 'ok-note' });
    const drawState = () => { state.textContent = bot.waSession ? '✅ فيه جلسة واتساب محفوظة (البوت مربوط).' : '⚠️ مفيش جلسة محفوظة لسه. شغّل البوت وامسح الـ QR أو ادخل كود الربط.'; state.className = bot.waSession ? 'ok-note' : 'note'; };
    drawState();
    const reset = h('button', { class: 'btn sm red', onclick: async () => {
      if (!confirm('هتتمسح جلسة واتساب وتحتاج تربط من جديد. متأكد؟')) return;
      try { await api('POST', `/api/bots/${id}/wa-reset`); bot.waSession = false; drawState(); toast('اتمسحت الجلسة'); } catch (e) { toast(e.message, true); }
    } }, 'مسح الجلسة (ربط من جديد)');
    return h('div', null,
      h('div', { class: 'card' }, h('h2', null, 'حالة الربط'), state, reset,
        h('small', { style: 'color:var(--dim);display:block;margin-top:8px' }, 'الجلسة بتتحفظ في ملفات السيرفر، فالبوت بيرجع يشتغل لوحده بعد أي إعادة تشغيل من غير QR.')),
      h('div', { class: 'card' }, h('h2', null, 'الربط بكود (اختياري)'),
        h('div', { class: 'kv' }, num, save),
        h('small', { style: 'color:var(--dim)' }, 'بيتبعت للبوت كمتغيرات PHONE_NUMBER وWA_NUMBER وBOT_NUMBER. لو كود بوتك بيدعم pairing code هيطلّع الكود في الكونسول. من غير رقم بيظهر QR.')),
      h('div', { class: 'card' }, h('h2', null, 'ازاي أشغّل بوتي؟'),
        h('ol', { style: 'margin:0;padding-inline-start:20px;color:var(--muted);line-height:1.9' },
          h('li', null, 'ارفع ملفات البوت (ZIP فيه package.json) من تبويب الملفات.'),
          h('li', null, 'اضغط تشغيل، واستنى تثبيت المكتبات.'),
          h('li', null, 'افتح الكونسول: امسح الـ QR من واتساب > الأجهزة المرتبطة، أو ادخل كود الربط.'),
          h('li', null, 'بعد الربط الجلسة بتتحفظ لوحدها.'))));
  }

  // --- الإعدادات ---
  function tabSettings() {
    const nm = h('input', { type: 'text', value: bot.name, maxlength: 32 });
    const nmBtn = h('button', { class: 'btn sm blue', onclick: async () => {
      try { Object.assign(bot, await api('PATCH', '/api/bots/' + id, { name: nm.value })); toast('اتغيّر الاسم'); drawHead(); } catch (e) { toast(e.message, true); }
    } }, 'حفظ');
    const tok = h('input', { type: 'password', class: 'ltr', autocomplete: 'off', placeholder: bot.tokenMasked || '123456789:AA...' });
    const tokBtn = h('button', { class: 'btn sm blue', onclick: async () => {
      if (!tok.value.trim()) return;
      try { Object.assign(bot, await api('PATCH', '/api/bots/' + id, { token: tok.value.trim() })); tok.value = ''; toast('اتحفظ التوكن' + (bot.needsRestart ? '. أعد التشغيل' : '')); drawHead(); tok.placeholder = bot.tokenMasked; }
      catch (e) { toast(e.message, true); }
    } }, 'حفظ');
    const kill = state.user.admin ? h('div', { class: 'card' }, h('h2', null, 'منطقة الخطر'),
      h('button', { class: 'btn red', onclick: async () => {
        if (!confirm('هيتمسح السيرفر وكل ملفاته نهائيًا. متأكد؟')) return;
        try { await api('DELETE', '/api/bots/' + id); toast('اتحذف'); go('#/dash'); } catch (e) { toast(e.message, true); }
      } }, 'حذف السيرفر')) : null;
    return h('div', null,
      h('div', { class: 'card' }, h('h2', null, 'اسم السيرفر'), h('div', { class: 'kv' }, nm, nmBtn)),
      bot.platform === 'whatsapp' ? null : h('div', { class: 'card' }, h('h2', null, 'توكن البوت'), h('div', { class: 'kv' }, tok, tokBtn),
        h('small', { style: 'color:var(--dim)' }, bot.username ? 'البوت الحالي: @' + bot.username : 'من @BotFather. بيتخزن متشفّر.')),
      kill);
  }

  async function poll() {
    try {
      const s = await api('GET', `/api/bots/${id}/stats`);
      if (!alive) return;
      bot.status = s.status; bot.desired = s.desired; disk = s.diskBytes; bot.waSession = s.waSession;
      const on = s.status.phase !== 'stopped' && s.status.phase !== 'failed';
      cpuS.push(on ? s.status.cpu || 0 : 0); memS.push(on ? s.status.rssMb || 0 : 0);
      if (cpuS.length > 60) { cpuS.shift(); memS.shift(); }
      drawHead();
      if (tab === 'console') drawCharts();
    } catch { /* تمام */ }
  }

  drawHead();
  body.append(tab === 'console' ? tabConsole() : tab === 'files' ? tabFiles() : tab === 'startup' ? tabStartup() : tab === 'whatsapp' && bot.platform === 'whatsapp' ? tabWhatsapp() : tabSettings());
  mount(h('div', null, topbar(), h('div', { class: 'shell' }, head, body)), 'server', { server: bot, tab });
  timer = setInterval(poll, 3000);
}

// ---------- الإدارة ----------
async function viewAdmin() {
  if (!state.user || !state.user.admin) return go('#/dash');
  let ov, bots, users;
  try { [ov, bots, users] = await Promise.all([api('GET', '/api/admin/overview'), api('GET', '/api/admin/bots'), api('GET', '/api/admin/users')]); }
  catch (e) { toast(e.message, true); return go('#/dash'); }
  const php = state.cfg.phpStatus || {};
  const rts = state.cfg.runtimes;
  const urows = h('tbody');
  const drawUsers = () => urows.replaceChildren(...users.users.map((u) => h('tr', null,
    h('td', { class: 'ltr' }, u.email, u.admin ? ' ★' : ''), h('td', null, `${u.bots}/${u.maxBots}`), h('td', null, u.tgLinked ? 'في تلجرم' : '-'),
    h('td', null, h('div', { class: 'row' },
      h('button', { class: 'btn sm', onclick: async () => {
        const pw = prompt('كلمة السر الجديدة لـ ' + u.email + ' (8 حروف على الأقل)');
        if (!pw) return;
        try { await api('POST', `/api/admin/users/${u.id}/password`, { password: pw }); toast('اتغيّرت كلمة السر'); } catch (e) { toast(e.message, true); }
      } }, 'كلمة السر'),
      !u.admin && h('button', { class: 'btn sm red', onclick: async () => {
        if (!confirm('حذف ' + u.email + ' وكل سيرفراته؟')) return;
        try { await api('DELETE', '/api/admin/users/' + u.id); toast('اتحذف'); location.reload(); } catch (e) { toast(e.message, true); }
      } }, 'حذف'))))));
  drawUsers();
  const brows = h('tbody');
  brows.replaceChildren(...bots.bots.map((b) => h('tr', null,
    h('td', null, h('a', { href: '#/server/' + b.id, style: 'color:#93c5fd' }, b.name)), h('td', { class: 'ltr' }, b.owner), h('td', null, chip(b.runtime, b.platform)),
    h('td', null, (phaseInfo[b.status.phase] || ['', b.status.phase])[1]), h('td', { class: 'ltr' }, (b.status.rssMb || 0) + ' MB'),
    h('td', null, h('div', { class: 'row' },
      h('button', { class: 'btn sm', onclick: async () => { try { await api('POST', `/api/admin/bots/${b.id}/stop`); toast('اتوقف'); location.reload(); } catch (e) { toast(e.message, true); } } }, 'إيقاف'),
      h('button', { class: 'btn sm red', onclick: async () => { if (!confirm('حذف ' + b.name + '؟')) return; try { await api('DELETE', '/api/admin/bots/' + b.id); toast('اتحذف'); location.reload(); } catch (e) { toast(e.message, true); } } }, 'حذف'))))));
  const phpLine = rts.php.ok ? `PHP ${rts.php.version} (${rts.php.source === 'system' ? 'السيرفر' : rts.php.source === 'static' ? 'نسخة ثابتة' : 'FrankenPHP'})`
    : php.state === 'installing' ? 'PHP بيتثبت دلوقتي...' : php.state === 'failed' ? 'PHP فشل تثبيته: ' + php.error : 'PHP مش متثبّت';
  mount(h('div', null, topbar(), h('div', { class: 'page', style: 'padding-bottom:60px' },
    h('div', { class: 'page-title' }, h('h1', null, 'الإدارة'), h('a', { class: 'btn blue sm', href: '#/create' }, '+ سيرفر جديد')),
    h('div', { class: 'meters' },
      h('span', { class: 'meter' }, 'USERS ', h('b', null, ov.users)), h('span', { class: 'meter' }, 'SERVERS ', h('b', null, ov.bots)),
      h('span', { class: 'meter' }, 'RUNNING ', h('b', null, `${ov.running}/${ov.maxRunning}`)),
      h('span', { class: 'meter' }, 'RAM ', h('b', null, ov.serverRssMb + ' MB')), h('span', { class: 'meter' }, 'FREE ', h('b', null, ov.freeMemMb + ' MB'))),
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'grow' }, phpLine),
      !rts.php.ok && php.state !== 'installing' && h('button', { class: 'btn sm blue', onclick: async () => { try { await api('POST', '/api/admin/php/install'); toast('بدأ تثبيت PHP، استنى دقيقة وحدّث الصفحة'); } catch (e) { toast(e.message, true); } } }, 'تثبيت PHP'))),
    h('h2', { class: 'sect-title', style: 'margin-top:22px' }, 'الحسابات'),
    h('div', { class: 'card tbl' }, h('table', null, h('thead', null, h('tr', null, ['الحساب', 'السيرفرات', 'تلجرم', ''].map((t) => h('th', null, t)))), urows)),
    h('h2', { class: 'sect-title', style: 'margin-top:22px' }, 'كل السيرفرات'),
    h('div', { class: 'card tbl' }, h('table', null, h('thead', null, h('tr', null, ['السيرفر', 'المالك', 'اللغة', 'الحالة', 'الذاكرة', ''].map((t) => h('th', null, t)))), brows)),
    h('p', { class: 'foot-copy' }, copyright()))), 'dash');
}

// ---------- التوجيه ----------
async function route() {
  if (state.cleanup) { state.cleanup(); state.cleanup = null; }
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);
  if (!state.cfg || (state.cfg.phpStatus && state.cfg.phpStatus.state === 'installing')) {
    try { state.cfg = await api('GET', '/api/config'); } catch (e) { $app.replaceChildren(h('p', { style: 'padding:24px' }, e.message)); return; }
  }
  if (!state.user && store.get()) { try { state.user = await api('GET', '/api/me'); } catch { /* التوكن منتهي */ } }
  const [a, b, c] = parts;
  if (!a) return state.user ? go('#/dash') : go('#/login');
  if (a === 'register') return state.user ? go('#/dash') : viewRegister();
  if (a === 'login') return state.user ? go('#/dash') : viewLogin();
  if (!state.user) return go('#/login');
  if (a === 'dash') return viewDash();
  if (a === 'account') return viewAccount();
  if (a === 'create') return viewCreate();
  if (a === 'server' && b) return viewServer(b, c);
  if (a === 'bot' && b) return go('#/server/' + b);
  if (a === 'admin') return viewAdmin();
  go('#/dash');
}
window.addEventListener('hashchange', route);
route();
