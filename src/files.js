const path = require('path');
const manager = require('./manager');
const { HttpError } = require('./util');

const FILE_RE = /^[\w.-]+(\/[\w.-]+)*$/;
const SKIP_DIRS = /^(node_modules|\.pydeps|vendor|\.composer|\.git|\.npm)(\/|$)/;

/** يتأكد إن المسار جوه مجلد البوت وبيرجع المسار الكامل، أو يرمي HttpError */
function safePath(bot, name) {
  if (typeof name !== 'string' || name.length > 120 || !FILE_RE.test(name) ||
      name.split('/').some((x) => x === '..' || x === '.') ||
      SKIP_DIRS.test(name) || name.split('/').some((s) => s.startsWith('.botnest-'))) {
    throw new HttpError(400, 'اسم الملف غير مسموح');
  }
  const dir = manager.dirOf(bot.id);
  const full = path.resolve(dir, name);
  if (!full.startsWith(dir + path.sep)) throw new HttpError(400, 'اسم الملف غير مسموح');
  return full;
}

module.exports = { FILE_RE, SKIP_DIRS, safePath };
