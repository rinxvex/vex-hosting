const fs = require('fs');
const path = require('path');

// قراءة ملف .env (لو موجود) من غير مكتبات. المتغيرات الحقيقية ليها الأولوية.
for (const dir of [process.cwd(), path.resolve(__dirname, '..')]) {
  try {
    const lines = fs.readFileSync(path.join(dir, '.env'), 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().startsWith('#')) continue;
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const val = m[2].replace(/^(['"])(.*)\1$/, '$2');
      if (val && process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
    break;
  } catch { /* مفيش .env هنا */ }
}

// لو SECRET مش موجود: نولّد واحد ونحفظه في مجلد data عشان السيرفر ما يقعش.
let secret = process.env.SECRET || '';
if (secret.length < 24) {
  const keyFile = path.join(path.resolve(process.env.DATA_DIR || './data'), 'secret.key');
  try { secret = fs.readFileSync(keyFile, 'utf8').trim(); } catch { /* مفيش */ }
  if (secret.length < 24) {
    secret = require('crypto').randomBytes(36).toString('base64url');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, secret, { mode: 0o600 });
  }
  console.log('تنبيه: SECRET مش موجود في .env، استخدمت مفتاح متولّد ومحفوظ في data/secret.key');
}

const num = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};

// حد بلا نهاية: 0 أو inf أو unlimited في .env. (الحد الحقيقي هو رام ومساحة الاستضافة نفسها)
const lim = (name, def) => {
  const raw = String(process.env[name] === undefined ? '' : process.env[name]).trim().toLowerCase();
  if (raw === '0' || raw === 'inf' || raw === 'unlimited' || raw === '∞') return Infinity;
  return num(name, def);
};

module.exports = {
  port: num('PORT', num('SERVER_PORT', 8000)),
  secret,
  adminEmail: (process.env.ADMIN_EMAIL || 'admin').trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  telegramApi: (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, ''),
  siteName: (process.env.SITE_NAME || 'vex-hosting').trim(),
  ownerName: (process.env.OWNER_NAME || 'Rinxvex').trim(),
  allowUserCreate: process.env.ALLOW_USER_CREATE !== '0',
  allowSignup: process.env.ALLOW_SIGNUP !== '0',
  // المطورين الأساسيين في بوت تلجرم (أيديهم). مينفعش يتشالوا من البوت
  devIds: (process.env.DEV_TG_IDS || '8847033299').split(',').map((x) => Number(x.trim())).filter((n) => Number.isSafeInteger(n) && n > 0),
  controlToken: (process.env.CONTROL_BOT_TOKEN || '').trim(),
  trustProxy: process.env.TRUST_PROXY === '1',
  // الحدود الافتراضية مناسبة لسيرفر فيه 2-3GB رام. عدّلها من .env
  maxBotsPerUser: num('MAX_BOTS_PER_USER', 5),
  maxRunning: num('MAX_RUNNING', 6),
  botMemMb: lim('BOT_MEM_MB', Infinity),
  maxUploadMb: lim('MAX_UPLOAD_MB', Infinity),
  maxUnzippedMb: lim('MAX_UNZIPPED_MB', Infinity),
  maxFiles: lim('MAX_FILES', 100000)
};
