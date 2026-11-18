/**
 * يكتشف اللغات المتاحة على السيرفر (Node دايمًا موجود).
 * PHP: لو مش موجود على السيرفر بنزّل نسخة ثابتة (static) لوحدنا في مجلد data/runtime
 * من static-php-cli، ولو فشلت من FrankenPHP (GitHub). composer.phar بيتنزّل لما نحتاجه.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');
const config = require('./config');

const RT_DIR = path.join(config.dataDir, 'runtime');
const LOCAL_PHP = path.join(RT_DIR, 'php');
const LOCAL_FRANKEN = path.join(RT_DIR, 'frankenphp');
const LOCAL_COMPOSER = path.join(RT_DIR, 'composer.phar');
const PHP_MIRROR = (process.env.PHP_MIRROR || 'https://dl.static-php.dev').replace(/\/$/, '');
const FRANKEN_URL = process.env.FRANKENPHP_URL ||
  'https://github.com/dunglas/frankenphp/releases/latest/download/frankenphp-linux-';
const COMPOSER_URL = process.env.COMPOSER_URL || 'https://getcomposer.org/download/latest-stable/composer.phar';

const baseEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', COMPOSER_ALLOW_SUPERUSER: '1' });

function probeCmd(cmd, pre, args) {
  try {
    const r = spawnSync(cmd, [...pre, ...args], { encoding: 'utf8', timeout: 8000, env: baseEnv() });
    if (r.status === 0) {
      const line = String(r.stdout || r.stderr).split('\n').map((s) => s.trim()).find(Boolean) || '';
      const v = /(\d+\.\d+(?:\.\d+)?)/.exec(line);
      return { ok: true, cmd, pre, version: v ? v[1] : line.slice(0, 30) };
    }
  } catch { /* جرّب اللي بعده */ }
  return { ok: false };
}
const probe = (cmds, args) => {
  for (const c of cmds) { const r = probeCmd(c, [], args); if (r.ok) return r; }
  return { ok: false };
};

function probePhp() {
  const sys = probeCmd('php', [], ['-v']);
  if (sys.ok) return { ...sys, source: 'system' };
  if (fs.existsSync(LOCAL_PHP)) { const r = probeCmd(LOCAL_PHP, [], ['-v']); if (r.ok) return { ...r, source: 'static' }; }
  if (fs.existsSync(LOCAL_FRANKEN)) { const r = probeCmd(LOCAL_FRANKEN, ['php-cli'], ['-v']); if (r.ok) return { ...r, source: 'frankenphp' }; }
  return { ok: false };
}

let cache = null;
function detect(force = false) {
  if (cache && !force) return cache;
  const php = probePhp();
  let composer = probe(['composer'], ['--version', '--no-interaction']);
  if (!composer.ok && php.ok && fs.existsSync(LOCAL_COMPOSER)) {
    const r = probeCmd(php.cmd, [...php.pre, LOCAL_COMPOSER], ['--version', '--no-interaction']);
    if (r.ok) composer = { ...r, cmd: php.cmd, pre: [...php.pre, LOCAL_COMPOSER] };
  }
  cache = {
    node: { ok: true, cmd: process.execPath, version: process.versions.node },
    python: probe(['python3', 'python'], ['--version']),
    php,
    composer,
    npm: probe(['npm'], ['--version'])
  };
  cache.pip = cache.python.ok ? probeCmd(cache.python.cmd, [], ['-m', 'pip', '--version']) : { ok: false };
  return cache;
}

// ---------- تنزيل PHP ----------
const phpState = { state: 'idle', error: '', source: '' }; // idle | installing | ready | failed
const archOf = () => ({ x64: 'x86_64', arm64: 'aarch64' }[process.arch] || '');

async function fetchOk(url, opts) {
  const r = await fetch(url, { redirect: 'follow', ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status} من ${new URL(url).host}`);
  return r;
}
async function downloadTo(url, dest) {
  const r = await fetchOk(url);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp, { mode: 0o755 }));
  fs.renameSync(tmp, dest);
}

/** بيطلّع أول ملف عادي اسمه `want` من tar غير مضغوط */
function tarFind(buf, want) {
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const size = parseInt(h.toString('utf8', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    off += 512;
    if ((type === '0' || type === '\0') && path.basename(name) === want) return buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
  }
  return null;
}

function phpWorks(cmd, pre) {
  const r = spawnSync(cmd, [...pre, '-r', 'exit(extension_loaded("curl") && extension_loaded("openssl") && extension_loaded("mbstring") ? 0 : 3);'], { timeout: 15000, env: baseEnv() });
  return r.status === 0;
}

async function installStatic(arch) {
  const listing = await (await fetchOk(`${PHP_MIRROR}/static-php-cli/common/?format=json`)).text();
  const re = new RegExp(`php-(\\d+)\\.(\\d+)\\.(\\d+)-cli-linux-${arch}\\.tar\\.gz`, 'g');
  const found = new Map();
  for (const m of listing.matchAll(re)) found.set(m[0], [Number(m[1]), Number(m[2]), Number(m[3])]);
  if (!found.size) throw new Error('مفيش نسخة PHP مناسبة في القائمة');
  const best = [...found.entries()]
    .filter(([, v]) => v[0] === 8 && v[1] <= 4)
    .sort((a, b) => (b[1][1] - a[1][1]) || (b[1][2] - a[1][2]))[0] || [...found.entries()].sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1] || b[1][2] - a[1][2])[0];
  const tgz = path.join(os.tmpdir(), `php-${process.pid}.tgz`);
  try {
    await downloadTo(`${PHP_MIRROR}/static-php-cli/common/${best[0]}`, tgz);
    const bin = tarFind(zlib.gunzipSync(fs.readFileSync(tgz)), 'php');
    if (!bin) throw new Error('الأرشيف مفيهوش ملف php');
    fs.mkdirSync(RT_DIR, { recursive: true });
    fs.writeFileSync(`${LOCAL_PHP}.part`, bin, { mode: 0o755 });
    fs.renameSync(`${LOCAL_PHP}.part`, LOCAL_PHP);
  } finally { fs.rmSync(tgz, { force: true }); }
  if (!phpWorks(LOCAL_PHP, [])) throw new Error('نسخة PHP اللي نزلت مش شغالة أو ناقصها curl/openssl');
  return 'static';
}

async function installFranken(arch) {
  await downloadTo(FRANKEN_URL + arch, LOCAL_FRANKEN);
  if (!phpWorks(LOCAL_FRANKEN, ['php-cli'])) throw new Error('FrankenPHP مش شغال هنا');
  return 'frankenphp';
}

let installing = null;
function installPhp() {
  if (installing) return installing;
  phpState.state = 'installing'; phpState.error = '';
  installing = (async () => {
    if (process.platform !== 'linux' || !archOf()) throw new Error('النظام ده مش مدعوم لتنزيل PHP تلقائي');
    const errs = [];
    for (const fn of [installStatic, installFranken]) {
      try { phpState.source = await fn(archOf()); detect(true); phpState.state = 'ready'; console.log(`PHP اتثبّت (${phpState.source}) ${detect().php.version}`); return; }
      catch (e) { errs.push(`${fn.name}: ${e.message}`); }
    }
    throw new Error(errs.join(' | '));
  })().catch((e) => { phpState.state = 'failed'; phpState.error = e.message; console.log('تعذّر تثبيت PHP تلقائي:', e.message); })
    .finally(() => { installing = null; });
  return installing;
}

/** بيتأكد إن PHP موجود، ولو لأ بيبدأ التنزيل في الخلفية (بيتندهي عند التشغيل) */
function ensurePhp() {
  const d = detect(true);
  if (d.php.ok) { phpState.state = 'ready'; phpState.source = d.php.source; return Promise.resolve(); }
  return installPhp();
}

async function ensureComposer() {
  let d = detect();
  if (d.composer.ok) return true;
  if (!d.php.ok) return false;
  try { await downloadTo(COMPOSER_URL, LOCAL_COMPOSER); } catch (e) { console.log('composer:', e.message); return false; }
  d = detect(true);
  return d.composer.ok;
}

const phpStatus = () => ({ ...phpState });

module.exports = { detect, ensurePhp, installPhp, ensureComposer, phpStatus, RT_DIR };
