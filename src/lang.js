/** كشف لغة المشروع من ملفاته (Node / Python / PHP) وتبديل لغة السيرفر تلقائيًا عند الرفع. */
const fs = require('fs');
const path = require('path');
const manager = require('./manager');
const runtimes = require('./runtimes');
const { HttpError } = require('./util');

const SKIP = /^(node_modules|\.pydeps|vendor|\.composer|\.git|\.npm|__pycache__|\.cache)$/;
const EXT = { node: /\.(c|m)?js$/i, python: /\.py$/i, php: /\.php$/i };
const MANIFEST = { 'package.json': 'node', 'requirements.txt': 'python', 'composer.json': 'php' };
const NAMES = { node: 'Node.js', python: 'Python', php: 'PHP' };

function langOfFile(name) {
  const base = path.basename(name);
  if (MANIFEST[base]) return MANIFEST[base];
  for (const [k, re] of Object.entries(EXT)) if (re.test(base)) return k;
  return null;
}

function score(dir) {
  const sc = { node: 0, python: 0, php: 0 };
  (function walk(d, depth) {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name.startsWith('.botnest-') || SKIP.test(it.name)) continue;
      if (it.isDirectory()) { if (depth < 3) walk(path.join(d, it.name), depth + 1); continue; }
      if (!it.isFile()) continue;
      const l = langOfFile(it.name);
      if (l) sc[l] += MANIFEST[it.name] ? 5 : 1;
    }
  })(dir, 0);
  return sc;
}

/** اللغة الغالبة في مجلد (أو null لو مفيش كود) */
function detectLang(dir) {
  const sc = score(dir);
  const best = Object.entries(sc).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : null;
}
const hasCode = (dir, lang) => score(dir)[lang] > 0;

function assertAvailable(lang) {
  const rt = runtimes.detect()[lang];
  if (!rt || !rt.ok) {
    const st = runtimes.phpStatus();
    const why = lang === 'php' && st.state === 'installing' ? ' (PHP لسه بيتثبت، جرّب بعد دقيقة)' : '';
    throw new HttpError(503, `${NAMES[lang]} مش متاح على السيرفر ده${why}`);
  }
}

function switchRuntime(bot, lang) {
  assertAvailable(lang);
  bot.runtime = lang;
  bot.mode = lang === 'php' && bot.platform !== 'whatsapp' ? 'webhook' : 'long';
  bot.entry = '';
}

module.exports = { detectLang, langOfFile, hasCode, switchRuntime, assertAvailable, NAMES };
