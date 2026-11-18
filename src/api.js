const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const store = require('./store');
const runtimes = require('./runtimes');
const manager = require('./manager');
const tg = require('./telegram');
const { safePath, SKIP_DIRS } = require('./files');
const accounts = require('./accounts');
const { applyZip, applyFile } = require('./upload');
const { json, readBody, readJson, createRouter } = require('./http');
const {
  HttpError, randomId, safeEqual, hashPassword, verifyPassword, signToken, verifyToken, encrypt, decrypt, rateLimit
} = require('./util');

const router = createRouter();
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RUNTIMES = ['node', 'python', 'php'];
const DUMMY_HASH = 's1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const isAdmin = (user) => Boolean(config.adminEmail) && user.email === config.adminEmail;
const ipOf = (req) => (config.trustProxy && req.headers['x-forwarded-for']
  ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';

function authUser(req) {
  const h = req.headers.authorization || '';
  const p = h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null;
  const user = p && store.users.find((u) => u.id === p.uid);
  if (!user) throw new HttpError(401, 'سجّل دخول الأول');
  return user;
}

function ownBot(user, id) {
  const bot = store.bots.find((b) => b.id === id && (b.userId === user.id || isAdmin(user)));
  if (!bot) throw new HttpError(404, 'البوت مش موجود');
  return bot;
}

function viewBot(bot, extra = {}) {
  const secrets = decrypt(bot.secretsEnc) || {};
  return {
    id: bot.id, name: bot.name, platform: bot.platform || 'telegram', runtime: bot.runtime, mode: bot.mode, entry: bot.entry || '',
    detectedEntry: manager.defaultEntry(bot), username: bot.username || '',
    tokenMasked: tg.maskToken(secrets.token), envKeys: Object.keys(secrets.env || {}),
    desired: bot.desired, createdAt: bot.createdAt, status: manager.status(bot.id), ...extra
  };
}


// بيتأكد إن حساب المدير موجود (عشان محدش يتقفل برا الموقع)
async function ensureAdmin() {
  if (store.users.some((u) => u.email === config.adminEmail)) return;
  let pw = config.adminPassword;
  let generated = false;
  if (!pw || pw.length < 8) { pw = require('crypto').randomBytes(9).toString('base64url'); generated = true; }
  store.users.push({ id: randomId(6), email: config.adminEmail, pass: await hashPassword(pw), createdAt: Date.now() });
  store.save();
  console.log(`حساب المدير اتعمل: ${config.adminEmail}${generated ? ` | كلمة السر: ${pw} (غيّرها من صفحة الإدارة، أو حط ADMIN_PASSWORD في .env)` : ''}`);
}

// ---------------- عام ----------------
router.add('GET', '/api/health', (_req, res) => json(res, 200, { ok: true }));

router.add('GET', '/api/config', (_req, res) => {
  const r = runtimes.detect();
  json(res, 200, {
    controlBot: require('./control').username(),
    owner: config.ownerName, name: config.siteName,
    allowSignup: config.allowSignup, allowUserCreate: config.allowUserCreate,
    phpStatus: runtimes.phpStatus(),
    runtimes: { node: r.node, python: r.python, php: r.php, pip: r.pip, composer: r.composer },
    limits: {
      maxBots: fin(config.maxBotsPerUser), maxRunning: fin(config.maxRunning), botMemMb: fin(config.botMemMb),
      maxUploadMb: fin(config.maxUploadMb), maxUnzippedMb: fin(config.maxUnzippedMb)
    }
  });
});

// ---------------- الحساب ----------------
router.add('POST', '/api/auth/login', async (req, res) => {
  const ip = ipOf(req);
  if (!rateLimit(`login:${ip}`, 12, 15 * 60 * 1000)) throw new HttpError(429, 'محاولات كتير، جرّب بعد شوية');
  const { email, password } = await readJson(req);
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const user = store.users.find((u) => u.email === e);
  const ok = await verifyPassword(typeof password === 'string' ? password : '', user ? user.pass : DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'الإيميل أو كلمة السر غلط');
  json(res, 200, { token: signToken({ uid: user.id }), user: { email: user.email, admin: isAdmin(user) } });
});

router.add('POST', '/api/auth/register', async (req, res) => {
  if (!config.allowSignup) throw new HttpError(403, 'التسجيل مقفول. كلّم صاحب الموقع');
  const ip = ipOf(req);
  if (!rateLimit(`reg:${ip}`, 5, 60 * 60 * 1000)) throw new HttpError(429, 'حسابات كتير من نفس الجهاز، جرّب بعد ساعة');
  const { email, password } = await readJson(req);
  const user = await accounts.createUser({ email, password });
  json(res, 201, { token: signToken({ uid: user.id }), user: { email: user.email, admin: false } });
});

router.add('GET', '/api/me', (req, res) => {
  const user = authUser(req);
  json(res, 200, { email: user.email, admin: isAdmin(user), tgLinked: Boolean(user.tgId), maxBots: user.maxBots || config.maxBotsPerUser });
});

router.add('POST', '/api/me/password', async (req, res) => {
  const user = authUser(req);
  const { old, password } = await readJson(req);
  if (!(await verifyPassword(typeof old === 'string' ? old : '', user.pass))) throw new HttpError(403, 'كلمة السر الحالية غلط');
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new HttpError(400, 'كلمة السر الجديدة لازم تكون من 8 حروف لـ 128');
  user.pass = await hashPassword(password);
  store.save();
  json(res, 200, { ok: true });
});

router.add('DELETE', '/api/me/tg-link', (req, res) => {
  const user = authUser(req);
  delete user.tgId;
  store.save();
  json(res, 200, { ok: true });
});

// ---------------- البوتات ----------------
router.add('GET', '/api/bots', (req, res) => {
  const user = authUser(req);
  json(res, 200, { bots: store.bots.filter((b) => b.userId === user.id).map((b) => viewBot(b)) });
});

router.add('POST', '/api/bots', async (req, res) => {
  const user = authUser(req);
  if (!isAdmin(user) && !config.allowUserCreate) throw new HttpError(403, 'إنشاء السيرفرات مقفول حالياً');
  const bot = await accounts.createServer(user, await readJson(req));
  json(res, 201, viewBot(bot));
});

router.add('GET', '/api/bots/:id', (req, res, { params }) => {
  const bot = ownBot(authUser(req), params.id);
  json(res, 200, viewBot(bot, { files: manager.listFiles(bot), diskBytes: dirSize(manager.dirOf(bot.id)), waSession: waSessions(bot).length > 0 }));
});

// جلسات واتساب: أي مجلد فيه creds.json (Baileys) أو فيه ملفات جلسة معروفة
function waSessions(bot) {
  const base = manager.dirOf(bot.id), out = [];
  const walk = (d, depth) => {
    let items; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (items.some((i) => i.isFile() && i.name === 'creds.json')) { out.push(d); return; }
    if (depth >= 2) return;
    for (const i of items) {
      if (i.isDirectory() && i.name !== 'node_modules' && !i.name.startsWith('.botnest-')) walk(path.join(d, i.name), depth + 1);
      if (i.isDirectory() && i.name === '.wwebjs_auth') out.push(path.join(d, i.name));
    }
  };
  walk(base, 0);
  return out;
}

router.add('POST', '/api/bots/:id/wa-reset', async (req, res, { params }) => {
  const bot = ownBot(authUser(req), params.id);
  if (manager.status(bot.id).phase !== 'stopped') throw new HttpError(409, 'وقّف السيرفر الأول');
  const dirs = waSessions(bot);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  json(res, 200, { ok: true, removed: dirs.length });
});

router.add('GET', '/api/bots/:id/stats', (req, res, { params }) => {
  const bot = ownBot(authUser(req), params.id);
  json(res, 200, { status: manager.status(bot.id), desired: bot.desired, diskBytes: dirSize(manager.dirOf(bot.id)), waSession: waSessions(bot).length > 0 });
});

router.add('PATCH', '/api/bots/:id', async (req, res, { params }) => {
  const bot = ownBot(authUser(req), params.id);
  const body = await readJson(req);
  const secrets = decrypt(bot.secretsEnc) || { token: '', env: {} };
  secrets.env = secrets.env || {};

  if (body.name !== undefined) {
    const n = typeof body.name === 'string' ? body.name.trim() : '';
    if (!accounts.NAME_RE.test(n)) throw new HttpError(400, 'اسم السيرفر من 2 لـ 32 حرف');
    if (store.bots.some((b) => b !== bot && b.userId === bot.userId && b.name.toLowerCase() === n.toLowerCase())) throw new HttpError(409, 'عندك سيرفر بنفس الاسم');
    bot.name = n;
  }
  if (body.entry !== undefined) {
    if (body.entry !== '' && !manager.validEntryName(bot.runtime, body.entry)) {
      throw new HttpError(400, `ملف التشغيل لازم ينتهي بـ ${bot.runtime === 'node' ? '.js' : bot.runtime === 'python' ? '.py' : '.php'}`);
    }
    bot.entry = body.entry;
  }
  if (body.mode !== undefined) {
    if (bot.runtime !== 'php') throw new HttpError(400, 'الوضع ده لـ PHP بس');
    if (!['webhook', 'long'].includes(body.mode)) throw new HttpError(400, 'وضع غير صالح');
    bot.mode = body.mode;
  }
  if (body.token !== undefined) {
    const me = body.token === '' ? { username: '' } : await accounts.checkToken(body.token);
    secrets.token = body.token;
    bot.username = me.username;
  }
  if (body.env !== undefined) {
    if (typeof body.env !== 'object' || body.env === null || Array.isArray(body.env)) throw new HttpError(400, 'المتغيرات غير صالحة');
    for (const [k, v] of Object.entries(body.env)) {
      if (!ENV_KEY_RE.test(k)) throw new HttpError(400, `اسم المتغير ${k} غير صالح`);
      if (manager.BLOCKED_ENV.test(k)) throw new HttpError(400, `المتغير ${k} محجوز للمنصة`);
      if (v === null) delete secrets.env[k];
      else if (typeof v === 'string' && v.length <= 2000) secrets.env[k] = v;
      else throw new HttpError(400, `قيمة ${k} غير صالحة (أقصى 2000 حرف)`);
    }
    if (Object.keys(secrets.env).length > 30) throw new HttpError(400, 'أقصى عدد متغيرات 30');
  }
  bot.secretsEnc = encrypt(secrets);
  store.save();
  json(res, 200, viewBot(bot, { needsRestart: manager.status(bot.id).phase !== 'stopped' }));
});

router.add('DELETE', '/api/bots/:id', async (req, res, { params }) => {
  const me = authUser(req);
  if (!isAdmin(me) && !config.allowUserCreate) throw new HttpError(403, 'حذف السيرفرات مقفول حالياً');
  const bot = ownBot(me, params.id);
  await manager.destroy(bot);
  store.bots.splice(store.bots.indexOf(bot), 1);
  store.save();
  json(res, 200, { ok: true });
});

// رفع ZIP (أي لغة: السيرفر بيتبدّل تلقائي لو لغة الملفات مختلفة)
router.add('PUT', '/api/bots/:id/files', async (req, res, { params, query }) => {
  const bot = ownBot(authUser(req), params.id);
  if (manager.status(bot.id).phase !== 'stopped') throw new HttpError(409, 'وقّف البوت الأول قبل رفع ملفات جديدة');
  const buf = await readBody(req, config.maxUploadMb * 1024 * 1024);
  if (!buf.length) throw new HttpError(400, 'مفيش ملف');
  const r = await applyZip(bot, buf, { clean: query.get('clean') === '1' });
  store.save();
  json(res, 200, { ...r, detectedEntry: manager.defaultEntry(bot), runtime: bot.runtime });
});

// تحرير ملف واحد (للي مش عنده كمبيوتر)
const filePath = safePath;

router.add('GET', '/api/bots/:id/file', (req, res, { params, query }) => {
  const bot = ownBot(authUser(req), params.id);
  const full = filePath(bot, query.get('name'));
  let st;
  try { st = fs.statSync(full); } catch { throw new HttpError(404, 'الملف مش موجود'); }
  if (!st.isFile()) throw new HttpError(404, 'الملف مش موجود');
  if (st.size > 512 * 1024) throw new HttpError(413, 'الملف كبير على المحرر');
  const buf = fs.readFileSync(full);
  if (buf.includes(0)) throw new HttpError(415, 'ملف غير نصي');
  json(res, 200, { name: query.get('name'), content: buf.toString('utf8') });
});

router.add('PUT', '/api/bots/:id/file', async (req, res, { params, query }) => {
  const bot = ownBot(authUser(req), params.id);
  const full = filePath(bot, query.get('name'));
  const buf = await readBody(req, 512 * 1024);
  const r = applyFile(bot, query.get('name'), buf);
  store.save();
  json(res, 200, { ok: true, entry: r.entry, detectedEntry: manager.defaultEntry(bot), switched: r.switched, runtime: bot.runtime });
});

router.add('DELETE', '/api/bots/:id/file', (req, res, { params, query }) => {
  const bot = ownBot(authUser(req), params.id);
  fs.rmSync(filePath(bot, query.get('name')), { force: true });
  json(res, 200, { ok: true });
});

// ---------------- مدير الملفات (مجلدات + رفع متعدد) ----------------
const fin = (x) => (Number.isFinite(x) ? x : null);
// حجم المجلد بيتحسب مرة كل 20 ثانية (بدل كل طلب) عشان الموقع يفضل سريع
const sizeCache = new Map();
function dirSize(d) {
  const c = sizeCache.get(d);
  if (c && Date.now() - c.t < 20000) return c.v;
  const v = dirSizeRaw(d);
  sizeCache.set(d, { v, t: Date.now() });
  if (sizeCache.size > 500) sizeCache.delete(sizeCache.keys().next().value);
  return v;
}
function dirSizeRaw(d, depth = 0) {
  let t = 0;
  let items = [];
  try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return 0; }
  for (const it of items) {
    if (SKIP_DIRS.test(it.name + '/')) continue;
    const f = path.join(d, it.name);
    if (it.isDirectory()) { if (depth < 8) t += dirSizeRaw(f, depth + 1); }
    else if (it.isFile()) { try { t += fs.statSync(f).size; } catch { /* تمام */ } }
  }
  return t;
}

router.add('GET', '/api/bots/:id/ls', (req, res, { params, query }) => {
  const bot = ownBot(authUser(req), params.id);
  const rel = (query.get('dir') || '').replace(/^\/+|\/+$/g, '');
  const base = manager.dirOf(bot.id);
  let full = base;
  if (rel) full = filePath(bot, rel);
  let items;
  try { items = fs.readdirSync(full, { withFileTypes: true }); } catch { throw new HttpError(404, 'المجلد مش موجود'); }
  const out = [];
  for (const it of items) {
    if (it.name.startsWith('.botnest-')) continue;
    const f = path.join(full, it.name);
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (it.isDirectory()) out.push({ name: it.name, type: 'dir', size: 0, mtime: st.mtimeMs, hidden: SKIP_DIRS.test(it.name + '/') });
    else if (it.isFile()) out.push({ name: it.name, type: 'file', size: st.size, mtime: st.mtimeMs });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  json(res, 200, { dir: rel, items: out.slice(0, 500), used: dirSize(base) });
});

// رفع ملف واحد (أي نوع) في أي مسار. الواجهة بتبعت الملفات المتعددة واحد ورا التاني
router.add('POST', '/api/bots/:id/upload', async (req, res, { params, query }) => {
  const bot = ownBot(authUser(req), params.id);
  const name = query.get('name');
  const full = filePath(bot, name);
  const buf = await readBody(req, config.maxUploadMb * 1024 * 1024);
  const base = manager.dirOf(bot.id);
  let old = 0; try { old = fs.statSync(full).size; } catch { /* جديد */ }
  if (Number.isFinite(config.maxUnzippedMb) && dirSizeRaw(base) - old + buf.length > config.maxUnzippedMb * 1024 * 1024) {
    throw new HttpError(413, `المساحة خلصت (الحد ${config.maxUnzippedMb}MB لكل بوت)`);
  }
  const r = applyFile(bot, name, buf);
  sizeCache.delete(base);
  store.save();
  json(res, 200, { ok: true, size: buf.length, entry: r.entry, switched: r.switched, runtime: bot.runtime });
});

router.add('POST', '/api/bots/:id/mkdir', (req, res, { params, query }) => {
  const bot = ownBot(authUser(req), params.id);
  fs.mkdirSync(filePath(bot, query.get('name')), { recursive: true });
  json(res, 200, { ok: true });
});

router.add('POST', '/api/bots/:id/delete', async (req, res, { params }) => {
  const bot = ownBot(authUser(req), params.id);
  const { names } = await readJson(req);
  if (!Array.isArray(names) || !names.length || names.length > 200) throw new HttpError(400, 'مفيش حاجة للحذف');
  for (const n of names) fs.rmSync(filePath(bot, n), { recursive: true, force: true });
  json(res, 200, { ok: true, deleted: names.length });
});

router.add('POST', '/api/bots/:id/rename', async (req, res, { params }) => {
  const bot = ownBot(authUser(req), params.id);
  const { from, to } = await readJson(req);
  const a = filePath(bot, from), b = filePath(bot, to);
  if (!fs.existsSync(a)) throw new HttpError(404, 'مش موجود');
  if (fs.existsSync(b)) throw new HttpError(409, 'الاسم ده موجود');
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.renameSync(a, b);
  json(res, 200, { ok: true });
});

router.add('GET', '/api/bots/:id/download', (req, res, { params, query }) => {
  const bot = ownBot(authUser(req), params.id);
  const full = filePath(bot, query.get('name'));
  let st; try { st = fs.statSync(full); } catch { throw new HttpError(404, 'الملف مش موجود'); }
  if (!st.isFile()) throw new HttpError(404, 'الملف مش موجود');
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': 'attachment; filename="' + path.basename(full).replace(/[^\w.-]/g, '_') + '"' });
  fs.createReadStream(full).pipe(res);
});

// تحكم
router.add('POST', '/api/bots/:id/start', async (req, res, { params }) => {
  const bot = ownBot(authUser(req), params.id);
  await manager.start(bot);
  bot.desired = 'running';
  store.save();
  json(res, 200, viewBot(bot));
});
router.add('POST', '/api/bots/:id/stop', async (req, res, { params }) => {
  const bot = ownBot(authUser(req), params.id);
  bot.desired = 'stopped';
  store.save();
  await manager.stop(bot.id);
  json(res, 200, viewBot(bot));
});
router.add('POST', '/api/bots/:id/restart', async (req, res, { params }) => {
  const bot = ownBot(authUser(req), params.id);
  await manager.stop(bot.id);
  await manager.start(bot);
  bot.desired = 'running';
  store.save();
  json(res, 200, viewBot(bot));
});

router.add('GET', '/api/bots/:id/logs', (req, res, { params }) => {
  const bot = ownBot(authUser(req), params.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const stream = manager.logStream(bot.id);
  let buf = '';
  stream.on('data', (c) => {
    buf += c.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) res.write(`data: ${JSON.stringify(l)}\n\n`);
  });
  const beat = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(beat); stream.destroy(); });
});

// ---------------- المدير ----------------
const needAdmin = (req) => {
  const user = authUser(req);
  if (!isAdmin(user)) throw new HttpError(403, 'للمدير بس');
  return user;
};

router.add('GET', '/api/admin/overview', (req, res) => {
  needAdmin(req);
  const m = process.memoryUsage();
  json(res, 200, {
    users: store.users.length, bots: store.bots.length, running: manager.activeCount(),
    maxRunning: config.maxRunning, serverRssMb: Math.round(m.rss / 1048576),
    freeMemMb: Math.round(os.freemem() / 1048576), uptimeSec: Math.round(process.uptime())
  });
});

router.add('GET', '/api/admin/bots', (req, res) => {
  needAdmin(req);
  json(res, 200, {
    bots: store.bots.map((b) => {
      const owner = store.users.find((u) => u.id === b.userId);
      return { ...viewBot(b), owner: owner ? owner.email : '?' };
    })
  });
});

router.add('POST', '/api/admin/bots/:id/stop', async (req, res, { params }) => {
  needAdmin(req);
  const bot = store.bots.find((b) => b.id === params.id);
  if (!bot) throw new HttpError(404, 'البوت مش موجود');
  bot.desired = 'stopped';
  store.save();
  await manager.stop(bot.id);
  json(res, 200, { ok: true });
});

router.add('DELETE', '/api/admin/bots/:id', async (req, res, { params }) => {
  needAdmin(req);
  const bot = store.bots.find((b) => b.id === params.id);
  if (!bot) throw new HttpError(404, 'البوت مش موجود');
  await manager.destroy(bot);
  store.bots.splice(store.bots.indexOf(bot), 1);
  store.save();
  json(res, 200, { ok: true });
});

router.add('GET', '/api/admin/users', (req, res) => {
  needAdmin(req);
  json(res, 200, {
    users: store.users.map((u) => ({
      id: u.id, email: u.email, admin: isAdmin(u), tgLinked: Boolean(u.tgId), createdAt: u.createdAt,
      bots: store.bots.filter((b) => b.userId === u.id).length, maxBots: u.maxBots || config.maxBotsPerUser
    }))
  });
});

router.add('POST', '/api/admin/users', async (req, res) => {
  needAdmin(req);
  const user = await accounts.createUser(await readJson(req));
  json(res, 201, { id: user.id, email: user.email });
});

// إنشاء سيرفر لحساب (لو الإيميل مش موجود بيتعمل له حساب بالباسورد)
router.add('POST', '/api/admin/servers', async (req, res) => {
  needAdmin(req);
  const body = await readJson(req);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  let user = store.users.find((u) => u.email === email);
  let created = false;
  if (!user) { user = await accounts.createUser({ email, password: body.password, maxBots: body.maxBots }); created = true; }
  const bot = await accounts.createServer(user, body, { force: true });
  json(res, 201, { ...viewBot(bot), owner: user.email, accountCreated: created });
});

router.add('POST', '/api/admin/php/install', async (req, res) => {
  needAdmin(req);
  runtimes.installPhp();
  json(res, 202, { phpStatus: runtimes.phpStatus() });
});

router.add('POST', '/api/admin/users/:id/password', async (req, res, { params }) => {
  needAdmin(req);
  const { password } = await readJson(req);
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new HttpError(400, 'كلمة السر لازم تكون من 8 حروف لـ 128');
  const user = store.users.find((u) => u.id === params.id);
  if (!user) throw new HttpError(404, 'المستخدم مش موجود');
  user.pass = await hashPassword(password);
  store.save();
  json(res, 200, { ok: true });
});

router.add('DELETE', '/api/admin/users/:id', async (req, res, { params }) => {
  const me = needAdmin(req);
  const user = store.users.find((u) => u.id === params.id);
  if (!user) throw new HttpError(404, 'المستخدم مش موجود');
  if (user.id === me.id) throw new HttpError(400, 'مينفعش تحذف حسابك');
  for (const b of store.bots.filter((x) => x.userId === user.id)) {
    await manager.destroy(b);
    store.bots.splice(store.bots.indexOf(b), 1);
  }
  store.users.splice(store.users.indexOf(user), 1);
  store.save();
  json(res, 200, { ok: true });
});

module.exports = { router, ensureAdmin };
