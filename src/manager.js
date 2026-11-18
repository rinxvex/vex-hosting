/**
 * مدير تشغيل البوتات: كل بوت عملية منفصلة (Node أو Python أو PHP).
 * - تثبيت الحزم تلقائيًا (npm / pip / composer) مع حفظ بصمة عشان ما يتكررش.
 * - إعادة تشغيل تلقائية مع تهدئة بعد الأعطال.
 * - مراقب رام: أي بوت يعدّي الحد بيتقتل.
 * - وضع PHP webhook: المنصة بتسحب التحديثات وتشغّل السكربت مرة لكل تحديث.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const config = require('./config');
const runtimes = require('./runtimes');
const tg = require('./telegram');
const { stripAnsi, decrypt, HttpError } = require('./util');

const botsDir = path.join(config.dataDir, 'bots');
const tmpDir = path.join(config.dataDir, 'tmp');
const npmCache = path.join(config.dataDir, 'npm-cache');
const PREPEND = path.resolve(__dirname, '..', 'runtime', 'php-prepend.php');
for (const d of [botsDir, tmpDir, npmCache]) fs.mkdirSync(d, { recursive: true });

const ACTIVE = new Set(['starting', 'installing', 'running', 'backoff']);
const MAX_RESTARTS = 5;
const BLOCKED_ENV = /^(PATH|HOME|LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PHP_INI_SCAN_DIR|PHPRC|SECRET|BOT_TOKEN|TELEGRAM_BOT_TOKEN|VEX_UPDATE_FILE)$/i;

const ENTRY_CANDIDATES = {
  node: ['index.js', 'bot.js', 'main.js', 'app.js', 'index.mjs', 'index.cjs'],
  python: ['main.py', 'bot.py', 'app.py', 'index.py', 'run.py'],
  php: ['bot.php', 'index.php', 'main.php', 'webhook.php']
};
const ENTRY_EXT = { node: /\.(c|m)?js$/, python: /\.py$/, php: /\.php$/ };

const procs = new Map();
const dirOf = (id) => path.join(botsDir, id);
const sleepRaw = (ms) => new Promise((r) => setTimeout(r, ms));

function newP() {
  return {
    phase: 'stopped', run: 0, manual: false, child: null, ctl: null, wake: null,
    lines: [], subs: new Set(), restarts: 0, startedAt: 0, runStartedAt: 0,
    lastError: '', rss: 0, handled: 0
  };
}
const getP = (id) => { let p = procs.get(id); if (!p) { p = newP(); procs.set(id, p); } return p; };

// ---------- السجلات ----------
function push(p, text) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = stripAnsi(raw).trimEnd();
    if (!line) continue;
    const l = line.length > 2000 ? `${line.slice(0, 2000)}…` : line;
    p.lines.push(l);
    if (p.lines.length > 500) p.lines.shift();
    for (const s of p.subs) s.write(`${l}\n`);
  }
}
const sys = (p, t) => push(p, `[botnest] ${t}`);

function pipe(p, stream) {
  let buf = '';
  stream.on('data', (c) => {
    buf += c.toString('utf8');
    const parts = buf.split(/\r?\n/);
    buf = parts.pop();
    if (buf.length > 8000) { push(p, buf); buf = ''; }
    for (const l of parts) push(p, l);
  });
  stream.on('end', () => { if (buf) push(p, buf); });
}

// ---------- العمليات ----------
function killGroup(c, sig) {
  if (!c || !c.pid) return;
  try { process.kill(-c.pid, sig); } catch { try { c.kill(sig); } catch { /* مات */ } }
}

function runCmd(p, cmd, args, { cwd, env, timeoutMs = 0 }) {
  return new Promise((resolve) => {
    let c;
    try {
      c = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) { push(p, `[botnest] ${e.message}`); return resolve(-1); }
    p.child = c;
    pipe(p, c.stdout);
    pipe(p, c.stderr);
    const timer = timeoutMs ? setTimeout(() => { sys(p, 'انتهت المهلة، هنقفل العملية'); killGroup(c, 'SIGKILL'); }, timeoutMs) : null;
    c.on('error', (e) => { if (timer) clearTimeout(timer); if (p.child === c) p.child = null; sys(p, e.message); resolve(-1); });
    c.on('close', (code) => { if (timer) clearTimeout(timer); if (p.child === c) p.child = null; resolve(code === null ? -1 : code); });
  });
}

function sleep(p, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { p.wake = null; resolve(); }, ms);
    p.wake = () => { clearTimeout(t); p.wake = null; resolve(); };
  });
}

async function halt(p) {
  p.manual = true;
  p.run += 1;
  if (p.wake) p.wake();
  if (p.ctl) p.ctl.abort();
  const c = p.child;
  if (c) {
    killGroup(c, 'SIGTERM');
    for (let i = 0; i < 80 && p.child === c; i++) await sleepRaw(100);
    if (p.child === c) { killGroup(c, 'SIGKILL'); for (let i = 0; i < 20 && p.child === c; i++) await sleepRaw(100); }
  }
}

// ---------- التجهيز ----------
function buildEnv(bot, secrets, dir) {
  const env = {
    PATH: process.env.PATH, HOME: dir, TZ: process.env.TZ || 'UTC', LANG: 'C.UTF-8', NODE_ENV: 'production',
    TELEGRAM_API: config.telegramApi
  };
  for (const [k, v] of Object.entries(secrets.env || {})) {
    if (!BLOCKED_ENV.test(k)) env[k] = String(v);
  }
  if (bot.platform === 'whatsapp') env.WA_SESSION_DIR = path.join(dir, 'session');
  env.BOT_TOKEN = secrets.token || '';
  env.TELEGRAM_BOT_TOKEN = secrets.token || '';
  return env;
}

function safeEntry(dir, entry) {
  if (typeof entry !== 'string' || !entry || entry.includes('\0') || path.isAbsolute(entry)) return null;
  const full = path.resolve(dir, entry);
  if (!full.startsWith(dir + path.sep)) return null;
  return full;
}

function defaultEntry(bot) {
  const dir = dirOf(bot.id);
  if (bot.runtime === 'node') {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (typeof pkg.main === 'string' && fs.existsSync(path.join(dir, pkg.main))) return pkg.main;
    } catch { /* مفيش package.json */ }
  }
  return (ENTRY_CANDIDATES[bot.runtime] || []).find((f) => fs.existsSync(path.join(dir, f))) || '';
}

function validEntryName(runtime, entry) {
  return typeof entry === 'string' && entry.length <= 120 && !entry.startsWith('/') && !entry.includes('..') &&
    ENTRY_EXT[runtime] && ENTRY_EXT[runtime].test(entry);
}

function hashFiles(dir, names) {
  const h = crypto.createHash('sha256');
  for (const n of names) { try { h.update(fs.readFileSync(path.join(dir, n))); } catch { h.update('-'); } }
  return h.digest('hex');
}

async function installDeps(bot, p, run, dir, env) {
  const rts = runtimes.detect();
  let spec = null;
  if (bot.runtime === 'node' && fs.existsSync(path.join(dir, 'package.json'))) {
    if (!rts.npm.ok) { sys(p, 'npm مش موجود على السيرفر'); return false; }
    spec = {
      files: ['package.json', 'package-lock.json'], made: 'node_modules', cmd: rts.npm.cmd,
      args: ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-progress'],
      env: { npm_config_cache: npmCache, npm_config_update_notifier: 'false' }
    };
  } else if (bot.runtime === 'python' && fs.existsSync(path.join(dir, 'requirements.txt'))) {
    if (!rts.python.ok || !rts.pip.ok) { sys(p, 'pip مش متاح على السيرفر، مش هينفع نثبّت requirements.txt'); return false; }
    spec = {
      files: ['requirements.txt'], made: '.pydeps', cmd: rts.python.cmd,
      args: ['-m', 'pip', 'install', '-r', 'requirements.txt', '--target', '.pydeps', '--no-cache-dir',
        '--disable-pip-version-check', '--no-input', '-q'],
      env: {}
    };
  } else if (bot.runtime === 'php' && fs.existsSync(path.join(dir, 'composer.json'))) {
    if (!rts.composer.ok) {
      sys(p, 'composer مش موجود، بنحاول ننزّله...');
      await runtimes.ensureComposer();
    }
    const comp = runtimes.detect().composer;
    if (!comp.ok) { sys(p, 'composer مش متاح، هنشغّل من غير تثبيت حزم'); return true; }
    spec = {
      files: ['composer.json', 'composer.lock'], made: 'vendor', cmd: comp.cmd,
      args: [...(comp.pre || []), 'install', '--no-dev', '--no-interaction', '--no-progress', '--prefer-dist'],
      env: { COMPOSER_HOME: path.join(dir, '.composer'), COMPOSER_ALLOW_SUPERUSER: '1' }
    };
  }
  if (!spec) return true;

  const marker = path.join(dir, '.botnest-deps');
  const hash = hashFiles(dir, spec.files);
  let saved = '';
  try { saved = fs.readFileSync(marker, 'utf8'); } catch { /* أول مرة */ }
  if (saved === hash && fs.existsSync(path.join(dir, spec.made))) return true;

  p.phase = 'installing';
  sys(p, 'بنثبّت الحزم... ممكن ياخد دقايق');
  const code = await runCmd(p, spec.cmd, spec.args, { cwd: dir, env: { ...env, ...spec.env }, timeoutMs: 15 * 60 * 1000 });
  if (p.run !== run || p.manual) return false;
  if (code !== 0) { sys(p, `فشل تثبيت الحزم (كود ${code})`); p.lastError = 'فشل تثبيت الحزم'; return false; }
  fs.writeFileSync(marker, hash);
  sys(p, 'اتثبّتت الحزم');
  return true;
}

function longSpec(bot, entry) {
  const rts = runtimes.detect();
  const mem = Math.max(32, Math.floor(config.botMemMb * 0.8));
  if (bot.runtime === 'node') {
    return { cmd: process.execPath, args: [entry], extra: Number.isFinite(mem) ? { NODE_OPTIONS: `--max-old-space-size=${mem}` } : {} };
  }
  if (bot.runtime === 'python') {
    return { cmd: rts.python.cmd, args: ['-u', entry], extra: { PYTHONUNBUFFERED: '1', PYTHONPATH: '.pydeps', PYTHONDONTWRITEBYTECODE: '1' } };
  }
  return { cmd: rts.php.cmd, args: [...(rts.php.pre || []), '-d', `memory_limit=${Number.isFinite(mem) ? mem + 'M' : '-1'}`, entry], extra: {} };
}

async function runLoop(bot, p, run, dir, env, entry) {
  const alive = () => p.run === run && !p.manual;
  const spec = longSpec(bot, entry);
  while (alive()) {
    p.phase = 'running';
    p.runStartedAt = Date.now();
    p.startedAt = p.startedAt || p.runStartedAt;
    sys(p, `شغّلنا ${entry}`);
    const code = await runCmd(p, spec.cmd, spec.args, { cwd: dir, env: { ...env, ...spec.extra } });
    if (!alive()) return;
    p.rss = 0;
    if (Date.now() - p.runStartedAt > 60000) p.restarts = 0;
    if (code === 0 && !p.memKilled) { sys(p, 'البوت خلّص شغله (كود 0)'); p.phase = 'exited'; return; }
    p.lastError = p.memKilled ? 'عدّى حد الرام' : `وقف بكود ${code}`;
    p.memKilled = false;
    sys(p, p.lastError);
    if (p.restarts >= MAX_RESTARTS) {
      p.phase = 'crashed';
      sys(p, 'وقفنا الإعادة التلقائية بعد تكرار الأعطال. راجع السجلات وأعد التشغيل يدويًا');
      return;
    }
    p.restarts += 1;
    const wait = Math.min(30000, 2000 * p.restarts);
    p.phase = 'backoff';
    sys(p, `هنعيد التشغيل بعد ${wait / 1000} ثانية (${p.restarts}/${MAX_RESTARTS})`);
    await sleep(p, wait);
  }
}

// ---------- PHP على طريقة الـ webhook ----------
async function runPhpOnce(bot, p, dir, env, entry, update) {
  const rts = runtimes.detect();
  const file = path.join(tmpDir, `${bot.id}-${update.update_id}.json`);
  fs.writeFileSync(file, JSON.stringify(update), { mode: 0o600 });
  const mem = Math.max(32, Math.floor(config.botMemMb * 0.8));
  const started = Date.now();
  const code = await runCmd(p, rts.php.cmd,
    [...(rts.php.pre || []), '-d', `auto_prepend_file=${PREPEND}`, '-d', `memory_limit=${mem}M`, '-d', 'max_execution_time=25', entry],
    { cwd: dir, env: { ...env, VEX_UPDATE_FILE: file }, timeoutMs: 30000 });
  fs.rm(file, { force: true }, () => {});
  p.handled += 1;
  if (code !== 0) sys(p, `تحديث ${update.update_id}: السكربت وقف بكود ${code} (${Date.now() - started}ms)`);
}

async function pollPhp(bot, p, run, dir, env, entry, token) {
  const alive = () => p.run === run && !p.manual;
  p.phase = 'running';
  p.runStartedAt = Date.now();
  p.startedAt = p.startedAt || p.runStartedAt;
  p.ctl = new AbortController();
  sys(p, 'وضع PHP webhook: بنسحب التحديثات من تلجرم ونشغّل السكربت مرة لكل تحديث');
  try {
    await tg.call(token, 'deleteWebhook', {}, { signal: p.ctl.signal });
  } catch (e) {
    if (e.status === 401) { sys(p, 'توكن البوت غلط أو اتلغى. حدّثه وأعد التشغيل'); p.phase = 'failed'; p.lastError = 'توكن غلط'; return; }
    if (!alive()) return;
    sys(p, `ما قدرناش نلغي الـ webhook: ${e.message}`);
  }
  let offset = 0;
  let errors = 0;
  while (alive()) {
    let updates;
    try {
      updates = await tg.call(token, 'getUpdates', { offset, timeout: 25 }, { signal: p.ctl.signal, timeoutMs: 40000 });
      errors = 0;
    } catch (e) {
      if (!alive() || e.aborted) return;
      if (e.status === 401) { sys(p, 'توكن البوت غلط أو اتلغى. حدّثه وأعد التشغيل'); p.phase = 'failed'; p.lastError = 'توكن غلط'; return; }
      sys(p, e.status === 409 ? 'فيه اتصال تاني بنفس البوت (نسخة تانية أو webhook). اقفله الأول' : `خطأ اتصال بتلجرم: ${e.message}`);
      errors += 1;
      await sleep(p, Math.min(20000, 3000 * errors));
      continue;
    }
    for (const u of updates) {
      if (!alive()) return;
      offset = u.update_id + 1;
      await runPhpOnce(bot, p, dir, env, entry, u);
    }
  }
}

// ---------- التشغيل والإيقاف ----------
async function launch(bot, p, run) {
  const dir = dirOf(bot.id);
  const secrets = decrypt(bot.secretsEnc) || {};
  const env = buildEnv(bot, secrets, dir);
  const rts = runtimes.detect();
  const rtKey = bot.runtime;
  if (!rts[rtKey] || !rts[rtKey].ok) {
    sys(p, `${rtKey} مش متاح على السيرفر ده`);
    p.phase = 'failed'; p.lastError = 'اللغة مش متاحة';
    return;
  }
  if (!secrets.token && bot.platform !== 'whatsapp') {
    sys(p, 'مفيش توكن للبوت. حطه من الإعدادات أو بأمر /token في بوت التحكم');
    p.phase = 'failed'; p.lastError = 'مفيش توكن';
    return;
  }
  const entryName = bot.entry || defaultEntry(bot);
  const entryFull = safeEntry(dir, entryName);
  if (!entryName || !entryFull || !fs.existsSync(entryFull)) {
    sys(p, 'ملف التشغيل مش موجود. ارفع ملفات البوت واختار الملف الرئيسي');
    p.phase = 'failed'; p.lastError = 'ملف التشغيل مش موجود';
    return;
  }
  if (!(await installDeps(bot, p, run, dir, env))) {
    if (p.run === run && !p.manual) p.phase = 'failed';
    return;
  }
  if (p.run !== run || p.manual) return;
  if (bot.runtime === 'php' && bot.mode === 'webhook' && bot.platform !== 'whatsapp') {
    await pollPhp(bot, p, run, dir, env, entryName, secrets.token);
  } else {
    await runLoop(bot, p, run, dir, env, entryName);
  }
}

async function start(bot) {
  const p = getP(bot.id);
  if (ACTIVE.has(p.phase)) return;
  const active = [...procs.values()].filter((x) => ACTIVE.has(x.phase)).length;
  if (active >= config.maxRunning) {
    throw new HttpError(503, `السيرفر وصل للحد الأقصى من البوتات الشغالة (${config.maxRunning}). اقفل بوت الأول`);
  }
  await halt(p);
  p.manual = false;
  p.phase = 'starting';
  p.restarts = 0; p.lastError = ''; p.handled = 0; p.startedAt = 0; p.memKilled = false; p.ctl = null;
  const run = ++p.run;
  launch(bot, p, run).catch((e) => { sys(p, `خطأ داخلي: ${e.message}`); p.phase = 'failed'; });
}

async function stop(botId) {
  const p = procs.get(botId);
  if (!p) return;
  await halt(p);
  p.phase = 'stopped';
  p.rss = 0;
}

async function restart(bot) {
  await stop(bot.id);
  return start(bot);
}

async function destroy(bot) {
  await stop(bot.id);
  procs.delete(bot.id);
  fs.rmSync(dirOf(bot.id), { recursive: true, force: true });
}

function status(id) {
  const p = procs.get(id);
  if (!p || p.phase === 'stopped') return { phase: 'stopped', restarts: 0, rssMb: 0, lastError: p ? p.lastError : '', handled: 0 };
  return {
    phase: p.phase,
    startedAt: p.phase === 'running' && p.runStartedAt ? new Date(p.runStartedAt).toISOString() : null,
    restarts: p.restarts, rssMb: p.rss, cpu: Math.round((p.cpu || 0) * 10) / 10, lastError: p.lastError, handled: p.handled
  };
}

const activeCount = () => [...procs.values()].filter((x) => ACTIVE.has(x.phase)).length;

function logStream(id) {
  const p = getP(id);
  const out = new PassThrough();
  out.write(p.lines.slice(-300).map((l) => `${l}\n`).join(''));
  p.subs.add(out);
  out.on('close', () => p.subs.delete(out));
  return out;
}

const recentLogs = (id, n = 40) => (procs.has(id) ? procs.get(id).lines.slice(-n) : []);

function listFiles(bot) {
  const dir = dirOf(bot.id);
  const out = [];
  const skip = new Set(['node_modules', '.pydeps', 'vendor', '.composer', '.git', '.npm']);
  (function walk(d, depth) {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (out.length >= 300) return;
      const full = path.join(d, it.name);
      const rel = path.relative(dir, full);
      if (it.isDirectory()) {
        if (skip.has(it.name)) out.push({ path: `${rel}/`, size: 0, skipped: true });
        else if (depth < 4) walk(full, depth + 1);
      } else if (it.isFile() && !it.name.startsWith('.botnest-')) {
        out.push({ path: rel, size: fs.statSync(full).size });
      }
    }
  })(dir, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function wipeFiles(bot) {
  const dir = dirOf(bot.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function resumeAll(bots) {
  let delay = 0;
  for (const bot of bots.filter((b) => b.desired === 'running')) {
    setTimeout(() => { start(bot).catch((e) => sys(getP(bot.id), e.message)); }, delay).unref();
    delay += 1500;
  }
}

// ---------- مراقب الرام ----------
function readCpuTicks(pid) {
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const a = f.slice(f.lastIndexOf(')') + 2).split(' ');
    return Number(a[11]) + Number(a[12]); // utime + stime
  } catch { return null; }
}

function readRssMb(pid) {
  try {
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Math.round(Number(m[1]) / 1024) : 0;
  } catch { return 0; }
}
setInterval(() => {
  for (const p of procs.values()) {
    if (!p.child || p.phase !== 'running') continue;
    const rss = readRssMb(p.child.pid);
    p.rss = rss;
    const t = readCpuTicks(p.child.pid), now = Date.now();
    if (t != null && p.cpuT != null) p.cpu = Math.max(0, Math.min(400, ((t - p.cpuT) / 100) / ((now - p.cpuAt) / 1000) * 100));
    p.cpuT = t; p.cpuAt = now;
    if (rss > config.botMemMb) {
      sys(p, `البوت عدّى حد الرام (${rss}MB من ${config.botMemMb}MB)، هنقفله`);
      p.memKilled = true;
      killGroup(p.child, 'SIGKILL');
    }
  }
}, 5000).unref();

async function shutdown() {
  for (const p of procs.values()) { p.manual = true; p.run += 1; if (p.ctl) p.ctl.abort(); killGroup(p.child, 'SIGTERM'); }
  await sleepRaw(500);
  for (const p of procs.values()) killGroup(p.child, 'SIGKILL');
}

module.exports = {
  start, stop, restart, destroy, status, logStream, recentLogs, listFiles, wipeFiles, resumeAll, shutdown,
  defaultEntry, validEntryName, dirOf, activeCount, ENTRY_EXT, BLOCKED_ENV
};
