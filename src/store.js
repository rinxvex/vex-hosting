const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const file = path.join(config.dataDir, 'store.json');

let db = { users: [], bots: [], devs: [] };
for (const f of [file, `${file}.bak`]) {
  try {
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    db = { users: parsed.users || [], bots: parsed.bots || [], devs: parsed.devs || [] };
    if (f !== file) console.log('تنبيه: store.json كان تالف، اتسترجعت النسخة الاحتياطية');
    break;
  } catch { /* جرّب اللي بعده */ }
}

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 100);
}
function flush() {
  clearTimeout(timer);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch { /* تمام */ }
  fs.renameSync(tmp, file);
}
process.on('exit', () => { try { flush(); } catch { /* تمام */ } });

module.exports = {
  users: db.users,
  bots: db.bots,
  devs: db.devs,
  save,
  flush
};
