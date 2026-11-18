/** إنشاء الحسابات والسيرفرات (مشترك بين لوحة الإدارة وبوت تلجرم). */
const fs = require('fs');
const config = require('./config');
const store = require('./store');
const runtimes = require('./runtimes');
const manager = require('./manager');
const tg = require('./telegram');
const { HttpError, randomId, hashPassword, encrypt } = require('./util');

const LOGIN_RE = /^[\w.@+-]{3,64}$/; // إيميل أو اسم مستخدم
const NAME_RE = /^[\w؀-ۿ][\w؀-ۿ .-]{1,31}$/;
const RUNTIME_ALIASES = { node: 'node', nodejs: 'node', js: 'node', python: 'python', py: 'python', php: 'php' };
const normRuntime = (r) => RUNTIME_ALIASES[String(r || '').trim().toLowerCase()] || null;

async function checkToken(token) {
  if (!tg.validToken(token)) throw new HttpError(400, 'شكل التوكن غلط. انسخه من @BotFather زي ما هو');
  try {
    const me = await tg.call(token, 'getMe', {}, { timeoutMs: 8000 });
    return { username: me.username || '' };
  } catch (e) {
    if (e.status === 401 || e.status === 404) throw new HttpError(400, 'التوكن ده مش مقبول من تلجرم. اتأكد منه أو اعمل واحد جديد من @BotFather');
    return { username: '' }; // مشكلة اتصال: نكمّل
  }
}

async function createUser({ email, password, maxBots }) {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!LOGIN_RE.test(e)) throw new HttpError(400, 'الاسم لازم يكون 3-64 حرف (إيميل أو اسم مستخدم، حروف إنجليزي وأرقام و . _ - @)');
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new HttpError(400, 'كلمة السر لازم تكون من 8 حروف لـ 128');
  if (store.users.some((u) => u.email === e)) throw new HttpError(409, 'الاسم ده موجود قبل كده');
  const user = { id: randomId(6), email: e, pass: await hashPassword(password), createdAt: Date.now() };
  const mb = Number(maxBots);
  if (Number.isInteger(mb) && mb > 0 && mb <= 100) user.maxBots = mb;
  store.users.push(user);
  store.save();
  return user;
}

/** بيعمل سيرفر لمستخدم. التوكن اختياري (ممكن يتضاف بعدين). force = من غير حد عدد السيرفرات */
async function createServer(user, { name, runtime, mode, token, platform }, { force = false } = {}) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!NAME_RE.test(n)) throw new HttpError(400, 'اسم السيرفر من 2 لـ 32 حرف (حروف وأرقام ومسافة و - _ .)');
  const rt = normRuntime(runtime);
  if (!rt) throw new HttpError(400, 'اختار اللغة: node أو python أو php');
  const cap = user.maxBots || config.maxBotsPerUser;
  if (!force && store.bots.filter((b) => b.userId === user.id).length >= cap) throw new HttpError(403, `وصلت للحد الأقصى (${cap} سيرفرات)`);
  if (store.bots.some((b) => b.userId === user.id && b.name.toLowerCase() === n.toLowerCase())) throw new HttpError(409, 'عنده سيرفر بنفس الاسم');
  const wa = platform === 'whatsapp';
  if (rt === 'php') require('./runtimes').ensurePhp().catch(() => {});
  let username = '';
  if (token && !wa) username = (await checkToken(token)).username;
  const bot = {
    id: randomId(5), userId: user.id, name: n, runtime: rt, platform: wa ? 'whatsapp' : 'telegram',
    mode: rt === 'php' && !wa ? (mode === 'long' ? 'long' : 'webhook') : 'long',
    entry: '', username, desired: 'stopped', createdAt: Date.now(),
    secretsEnc: encrypt({ token: wa ? '' : token || '', env: {} })
  };
  fs.mkdirSync(manager.dirOf(bot.id), { recursive: true });
  store.bots.push(bot);
  store.save();
  return bot;
}

module.exports = { createUser, createServer, checkToken, normRuntime, LOGIN_RE, NAME_RE };
