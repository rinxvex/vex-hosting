/** منطق الرفع المشترك بين الموقع وبوت تلجرم: أي لغة، والسيرفر بيتبدّل تلقائي لو لزم. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const manager = require('./manager');
const { extractZip } = require('./zip');
const { safePath } = require('./files');
const lang = require('./lang');

/** بيفك ZIP على السيرفر. لو لغته غير لغة السيرفر بيمسح القديم ويبدّل اللغة. البوت لازم يكون واقف. */
async function applyZip(bot, buf, { clean = false } = {}) {
  const tmpRoot = path.join(config.dataDir, 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'up-'));
  try {
    const r = await extractZip(buf, tmp, { maxFiles: config.maxFiles, maxBytes: config.maxUnzippedMb * 1024 * 1024 });
    await new Promise((r2) => setImmediate(r2));
    const found = lang.detectLang(tmp);
    let switched = null;
    if (found && found !== bot.runtime) {
      lang.assertAvailable(found);
      manager.wipeFiles(bot);
      lang.switchRuntime(bot, found);
      switched = found;
    } else if (clean) {
      manager.wipeFiles(bot);
    }
    await fs.promises.cp(tmp, manager.dirOf(bot.id), { recursive: true, force: true });
    if (!bot.entry || !fs.existsSync(path.join(manager.dirOf(bot.id), bot.entry))) bot.entry = manager.defaultEntry(bot);
    return { files: r.files, bytes: r.bytes, entry: bot.entry, switched };
  } finally { fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}

/** بيحفظ ملف واحد. لو كود بلغة تانية والسيرفر مفيهوش كود بلغته، بيبدّل اللغة. */
function applyFile(bot, rel, buf) {
  const full = safePath(bot, rel);
  const dir = manager.dirOf(bot.id);
  const l = lang.langOfFile(rel);
  let switched = null;
  if (l && l !== bot.runtime && !lang.hasCode(dir, bot.runtime)) {
    lang.switchRuntime(bot, l);
    switched = l;
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf, { mode: 0o644 });
  if (!bot.entry || !fs.existsSync(path.join(dir, bot.entry))) bot.entry = manager.defaultEntry(bot);
  return { entry: bot.entry, switched };
}

module.exports = { applyZip, applyFile };
