/**
 * بوت التحكم في تلجرم: تدخل بإيميلك وكلمة السر، وتشوف سيرفراتك وتشغّل وتوقف وترفع ملفات (أي لغة).
 * المطورين (بالأيدي) يقدروا كمان يعملوا حسابات وسيرفرات ويضيفوا مطورين. الأوامر دي مش بتظهر لغيرهم.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const manager = require('./manager');
const runtimes = require('./runtimes');
const tg = require('./telegram');
const accounts = require('./accounts');
const upload = require('./upload');
const lang = require('./lang');
const { verifyPassword, rateLimit } = require('./util');

const TOKEN = config.controlToken;
let username = '';
let running = false;
let ctl = null;
const selected = new Map(); // tgId -> botId
const asking = new Map();   // tgId -> { step: 'email'|'password', email, t }
const DUMMY_HASH = 's1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const call = (method, params, opts) => tg.call(TOKEN, method, params, opts);
const say = (chat, text, extra = {}) => call('sendMessage', { chat_id: chat, text: String(text).slice(0, 4000), ...extra }).catch(() => {});
const wipeMsg = (chat, id) => call('deleteMessage', { chat_id: chat, message_id: id }).catch(() => {});
const userOf = (tgId) => store.users.find((u) => u.tgId === tgId);
const botsOf = (u) => store.bots.filter((b) => b.userId === u.id);
const isOwnerDev = (id) => config.devIds.includes(id);
const isDev = (id) => isOwnerDev(id) || store.devs.includes(id);
const ICON = { running: '🟢', starting: '🟡', installing: '🟡', backoff: '🟠', crashed: '🔴', failed: '🔴', stopped: '⚪' };
const LABEL = { running: 'شغّال', starting: 'بيشتغل', installing: 'بيثبّت المكتبات', backoff: 'بيعيد التشغيل', crashed: 'وقع', failed: 'فشل', stopped: 'واقف' };
const LNAME = lang.NAMES;

const HELP_USER = [
  'أوامر البوت:',
  '/login  تسجيل الدخول بالإيميل وكلمة السر',
  '/logout  تسجيل الخروج',
  '/bots  سيرفراتك والتحكم فيها',
  '/use اسم_السيرفر  اختيار السيرفر اللي هترفع له',
  '/token التوكن  تغيير توكن البوت المختار',
  '/logs  آخر سجل السيرفر المختار',
  '',
  'الرفع: ابعت ملف ZIP أو أي ملف كود (Node.js أو Python أو PHP) وهيتحفظ على السيرفر المختار، واللغة بتتعرّف لوحدها.',
  'اكتب في التعليق مسار الحفظ لو عاوز (مثال: lib/utils.js). كلمة clean في تعليق ZIP بتمسح القديم الأول.'
].join('\n');
const HELP_DEV = [
  '',
  'أوامر المطور:',
  '/newaccount الإيميل كلمة_السر [أقصى_سيرفرات]',
  '/newserver الإيميل اسم_السيرفر node|python|php [التوكن]',
  '/accounts  الحسابات',
  '/adddev الأيدي  إضافة مطور',
  '/deldev الأيدي  حذف مطور',
  '/devs  المطورين'
].join('\n');
const help = (tgId) => HELP_USER + (isDev(tgId) ? '\n' + HELP_DEV : '');

function pickBot(u, tgId, name) {
  const mine = botsOf(u);
  if (name) {
    const n = name.trim().toLowerCase();
    return mine.find((b) => b.name.toLowerCase() === n || b.id === n) || null;
  }
  const cur = mine.find((b) => b.id === selected.get(tgId));
  if (cur) return cur;
  return mine.length === 1 ? mine[0] : null;
}

function panel(bot) {
  const s = manager.status(bot.id);
  const on = s.phase !== 'stopped';
  const text = `${ICON[s.phase] || '⚪'} ${bot.name} (${LNAME[bot.runtime] || bot.runtime})\nالحالة: ${LABEL[s.phase] || s.phase}` +
    (s.phase === 'running' ? `\nالذاكرة: ${s.rssMb || 0}MB` : '') + (s.lastError && !on ? `\nآخر خطأ: ${s.lastError}` : '') +
    `\nملف التشغيل: ${bot.entry || manager.defaultEntry(bot) || 'غير محدد'}`;
  const row1 = on
    ? [{ text: '⏹ إيقاف', callback_data: `x:${bot.id}` }, { text: '🔄 إعادة تشغيل', callback_data: `r:${bot.id}` }]
    : [{ text: '▶️ تشغيل', callback_data: `s:${bot.id}` }];
  return { text, reply_markup: { inline_keyboard: [row1, [{ text: '📜 السجل', callback_data: `l:${bot.id}` }, { text: '📤 ارفع هنا', callback_data: `u:${bot.id}` }], [{ text: '↩️ السيرفرات', callback_data: 'list' }]] } };
}

function listView(u) {
  const mine = botsOf(u);
  if (!mine.length) return { text: 'معندكش سيرفرات لسه. صاحب الموقع بيعملها لك.' };
  return {
    text: 'سيرفراتك:',
    reply_markup: { inline_keyboard: mine.map((b) => [{ text: `${ICON[manager.status(b.id).phase] || '⚪'} ${b.name} · ${LNAME[b.runtime]}`, callback_data: `b:${b.id}` }]) }
  };
}

async function doAction(bot, what) {
  if (what === 's') { await manager.start(bot); bot.desired = 'running'; }
  else if (what === 'x') { bot.desired = 'stopped'; await manager.stop(bot.id); }
  else if (what === 'r') { await manager.stop(bot.id); await manager.start(bot); bot.desired = 'running'; }
  store.save();
}

// ---------- تسجيل الدخول ----------
async function tryLogin(chat, tgId, email, password) {
  if (!rateLimit(`tglogin:${tgId}`, 6, 10 * 60 * 1000)) return say(chat, 'محاولات كتير. جرّب بعد 10 دقايق.');
  const e = String(email || '').trim().toLowerCase();
  const user = store.users.find((u) => u.email === e);
  const ok = await verifyPassword(String(password || ''), user ? user.pass : DUMMY_HASH);
  if (!user || !ok) return say(chat, '❌ الإيميل أو كلمة السر غلط.');
  for (const x of store.users) if (x.tgId === tgId) delete x.tgId;
  user.tgId = tgId;
  store.save();
  return say(chat, `✅ اتسجّل دخولك: ${user.email}\nجرّب /bots`);
}

// ---------- الرفع (أي لغة) ----------
async function onDocument(msg, u, bot) {
  const doc = msg.document;
  const limit = Math.min(config.maxUploadMb, 20) * 1048576;
  if (doc.file_size && doc.file_size > limit) return say(msg.chat.id, `الملف كبير. الحد ${Math.round(limit / 1048576)}MB.`);
  let info;
  try { info = await call('getFile', { file_id: doc.file_id }); } catch (e) { return say(msg.chat.id, 'تلجرم رفض تنزيل الملف: ' + e.message); }
  const res = await fetch(`${config.telegramApi}/file/bot${TOKEN}/${info.file_path}`);
  if (!res.ok) return say(msg.chat.id, 'فشل تنزيل الملف من تلجرم.');
  const buf = Buffer.from(await res.arrayBuffer());
  const caption = (msg.caption || '').trim();
  const isZip = /\.zip$/i.test(doc.file_name || '') || (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 3);
  const was = manager.status(bot.id).phase !== 'stopped';
  const keyboard = { reply_markup: panel(bot).reply_markup };

  if (isZip) {
    if (was) await manager.stop(bot.id);
    const r = await upload.applyZip(bot, buf, { clean: /\bclean\b/i.test(caption) });
    store.save();
    let tail = '';
    if (r.switched) tail += `\nاللغة اتعرّفت: ${LNAME[r.switched]} (اتبدّلت لغة السيرفر).`;
    if (was) { try { await manager.start(bot); tail += '\nواتشغّل تاني.'; } catch (e) { tail += '\nتعذّر تشغيله: ' + e.message; } }
    return say(msg.chat.id, `✅ اتفك ${r.files} ملف على ${bot.name}.\nاللغة: ${LNAME[bot.runtime]} | ملف التشغيل: ${r.entry || 'غير محدد'}${tail}`, was ? {} : keyboard);
  }

  const rel = caption && !/\s/.test(caption) ? caption.replace(/^\/+/, '') : (doc.file_name || '');
  const r = upload.applyFile(bot, rel, buf);
  store.save();
  let tail = r.switched ? `\nاللغة اتعرّفت: ${LNAME[r.switched]} (اتبدّلت لغة السيرفر).` : '';
  if (was) tail += '\nأعد التشغيل عشان يطبّق.';
  return say(msg.chat.id, `✅ اتحفظ ${rel} في ${bot.name} (${LNAME[bot.runtime]}).${tail}`, keyboard);
}

// ---------- أوامر المطور ----------
async function devCommand(chat, tgId, cmd, args, msg) {
  if (cmd === 'newaccount') {
    const [email, password, maxBots] = args;
    if (!email || !password) return say(chat, 'الاستخدام: /newaccount الإيميل كلمة_السر [أقصى_سيرفرات]');
    wipeMsg(chat, msg.message_id); // مسح الرسالة اللي فيها كلمة السر
    try {
      const u = await accounts.createUser({ email, password, maxBots });
      return say(chat, `✅ اتعمل الحساب\nالاسم: ${u.email}\nكلمة السر: ${password}\nابعتهم له. وبعدين اعمل له سيرفر: /newserver ${u.email} اسم node`);
    } catch (e) { return say(chat, '❌ ' + e.message); }
  }
  if (cmd === 'newserver') {
    const [email, name, runtime, token] = args;
    if (!email || !name || !runtime) return say(chat, 'الاستخدام: /newserver الإيميل اسم_السيرفر node|python|php [التوكن]');
    if (token) wipeMsg(chat, msg.message_id);
    const u = store.users.find((x) => x.email === email.toLowerCase());
    if (!u) return say(chat, '❌ الحساب ده مش موجود. اعمله بـ /newaccount');
    try {
      const b = await accounts.createServer(u, { name, runtime, token }, { force: true });
      return say(chat, `✅ اتعمل السيرفر ${b.name} (${LNAME[b.runtime]}) لـ ${u.email}${token ? '' : '\nلسه من غير توكن: صاحبه يحطه بـ /token'}`);
    } catch (e) { return say(chat, '❌ ' + e.message); }
  }
  if (cmd === 'accounts') {
    if (!store.users.length) return say(chat, 'مفيش حسابات.');
    return say(chat, store.users.map((u) => `• ${u.email}  (${botsOf(u).length} سيرفر${u.tgId ? ' · في تلجرم' : ''})`).join('\n'));
  }
  if (cmd === 'devs') {
    return say(chat, 'المطورين:\n' + [...config.devIds.map((i) => `• ${i} (أساسي)`), ...store.devs.filter((i) => !config.devIds.includes(i)).map((i) => `• ${i}`)].join('\n'));
  }
  if (cmd === 'adddev' || cmd === 'deldev') {
    const id = Number(args[0]);
    if (!Number.isSafeInteger(id) || id <= 0) return say(chat, `الاستخدام: /${cmd} الأيدي (رقم). اطلب منه يبعت /id للبوت.`);
    if (cmd === 'adddev') {
      if (isDev(id)) return say(chat, 'هو مطور فعلاً.');
      store.devs.push(id); store.save();
      return say(chat, `✅ اتضاف المطور ${id}`);
    }
    if (isOwnerDev(id)) return say(chat, 'المطور الأساسي مينفعش يتشال.');
    const i = store.devs.indexOf(id);
    if (i < 0) return say(chat, 'مش مطور.');
    store.devs.splice(i, 1); store.save();
    return say(chat, `✅ اتشال المطور ${id}`);
  }
  return false;
}
const DEV_CMDS = new Set(['newaccount', 'newserver', 'accounts', 'adddev', 'deldev', 'devs']);

async function onMessage(msg) {
  if (!msg.from || msg.chat.type !== 'private') return;
  const chat = msg.chat.id, tgId = msg.from.id;
  const text = (msg.text || '').trim();
  const m = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(text);
  const cmd = m ? m[1].toLowerCase() : '';
  const rest = m ? m[2].trim() : '';
  const args = rest ? rest.split(/\s+/) : [];

  if (cmd === 'id') return say(chat, `الأيدي بتاعك: ${tgId}`);

  // خطوات تسجيل الدخول (إيميل ثم كلمة سر)
  const st = asking.get(tgId);
  if (st && !cmd && msg.text) {
    if (Date.now() - st.t > 5 * 60e3) { asking.delete(tgId); return say(chat, 'انتهت المهلة. ابعت /login من جديد.'); }
    if (st.step === 'email') { asking.set(tgId, { step: 'password', email: text, t: Date.now() }); return say(chat, 'ابعت كلمة السر (هتتمسح الرسالة بعد الدخول):'); }
    asking.delete(tgId);
    wipeMsg(chat, msg.message_id);
    return tryLogin(chat, tgId, st.email, text);
  }
  if (cmd) asking.delete(tgId);

  if (cmd === 'start' || cmd === 'help') return say(chat, (userOf(tgId) ? '' : 'أهلاً! سجّل دخولك الأول بـ /login\n\n') + help(tgId));
  if (cmd === 'login') {
    if (args.length >= 2) { wipeMsg(chat, msg.message_id); return tryLogin(chat, tgId, args[0], args.slice(1).join(' ')); }
    asking.set(tgId, { step: 'email', t: Date.now() });
    return say(chat, 'ابعت الإيميل أو اسم المستخدم:');
  }
  if (cmd === 'logout') { const u0 = userOf(tgId); if (u0) { delete u0.tgId; store.save(); } selected.delete(tgId); return say(chat, 'اتسجّل خروجك.'); }

  if (DEV_CMDS.has(cmd) && isDev(tgId)) { const r = await devCommand(chat, tgId, cmd, args, msg); if (r !== false) return r; }

  const u = userOf(tgId);
  if (!u) return say(chat, 'سجّل دخولك الأول بـ /login');

  if (cmd === 'bots') { const v = listView(u); return say(chat, v.text, v.reply_markup ? { reply_markup: v.reply_markup } : {}); }
  if (cmd === 'use') {
    const b = pickBot(u, tgId, rest);
    if (!b) return say(chat, 'مش لاقي السيرفر ده. شوف /bots');
    selected.set(tgId, b.id);
    return say(chat, `اخترت ${b.name} (${LNAME[b.runtime]}). ابعت الملفات.`);
  }
  if (cmd === 'logs') {
    const b = pickBot(u, tgId, rest);
    if (!b) return say(chat, 'اختار سيرفر الأول: /use اسم_السيرفر');
    const lines = manager.recentLogs(b.id, 30).join('\n');
    return say(chat, lines ? lines.slice(-3800) : 'مفيش سجل لسه.');
  }
  if (cmd === 'token') {
    wipeMsg(chat, msg.message_id);
    const b = pickBot(u, tgId);
    if (!b) return say(chat, 'اختار سيرفر الأول: /use اسم_السيرفر');
    if (!args[0]) return say(chat, 'الاستخدام: /token التوكن_من_BotFather');
    try {
      const me = await accounts.checkToken(args[0]);
      const { decrypt, encrypt } = require('./util');
      const secrets = decrypt(b.secretsEnc) || { env: {} };
      secrets.token = args[0]; b.secretsEnc = encrypt(secrets); b.username = me.username; store.save();
      return say(chat, `✅ اتحفظ التوكن لـ ${b.name}${me.username ? ' (@' + me.username + ')' : ''}. ${manager.status(b.id).phase !== 'stopped' ? 'أعد التشغيل.' : 'شغّله من /bots.'}`);
    } catch (e) { return say(chat, '❌ ' + e.message); }
  }
  if (msg.document) {
    const b = pickBot(u, tgId);
    if (!b) return say(chat, botsOf(u).length ? 'اختار السيرفر الأول: /use اسم_السيرفر ثم ابعت الملف.' : 'معندكش سيرفرات. كلّم صاحب الموقع.');
    try { return await onDocument(msg, u, b); } catch (e) { return say(chat, '❌ فشل الرفع: ' + e.message); }
  }
  if (cmd) return say(chat, help(tgId));
  return say(chat, 'ابعت /bots أو ملف للرفع.');
}

async function onCallback(q) {
  const tgId = q.from.id, msg = q.message;
  const done = (t) => call('answerCallbackQuery', { callback_query_id: q.id, ...(t ? { text: t } : {}) }).catch(() => {});
  const u = userOf(tgId);
  if (!u || !msg) return done('سجّل دخول بـ /login');
  const [what, id] = String(q.data || '').split(':');
  const edit = (v) => call('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: v.text, ...(v.reply_markup ? { reply_markup: v.reply_markup } : {}) }).catch(() => {});
  if (what === 'list') { await done(); return edit(listView(u)); }
  const bot = botsOf(u).find((b) => b.id === id);
  if (!bot) return done('السيرفر مش موجود');
  try {
    if (what === 'b') { await done(); return edit(panel(bot)); }
    if (what === 'u') { selected.set(tgId, bot.id); return done(`اخترت ${bot.name}. ابعت الملف دلوقتي`); }
    if (what === 'l') {
      await done();
      const lines = manager.recentLogs(bot.id, 30).join('\n');
      return say(msg.chat.id, lines ? lines.slice(-3800) : 'مفيش سجل لسه.');
    }
    if (['s', 'x', 'r'].includes(what)) {
      await done(what === 'x' ? 'بيوقف...' : 'بيشتغل...');
      await doAction(bot, what);
      return edit(panel(bot));
    }
  } catch (e) { await say(msg.chat.id, 'حصل خطأ: ' + (e.message || e)); }
  return done();
}

async function loop() {
  let offset = 0;
  while (running) {
    try {
      const ups = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, { signal: ctl.signal, timeoutMs: 40000 });
      for (const up of ups) {
        offset = up.update_id + 1;
        try {
          if (up.message) await onMessage(up.message);
          else if (up.callback_query) await onCallback(up.callback_query);
        } catch (e) { console.error('control:', e.message); }
      }
    } catch (e) {
      if (!running) return;
      await new Promise((r) => setTimeout(r, e.aborted ? 0 : 4000));
    }
  }
}

async function start() {
  if (!TOKEN) return null;
  if (!tg.validToken(TOKEN)) { console.log('CONTROL_BOT_TOKEN شكله غلط، بوت التحكم مش هيشتغل'); return null; }
  try {
    const me = await call('getMe', {}, { timeoutMs: 10000 });
    username = me.username || '';
    await call('deleteWebhook', {}).catch(() => {});
  } catch (e) { console.log('بوت التحكم: التوكن مش مقبول (' + e.message + ')'); return null; }
  running = true;
  ctl = new AbortController();
  loop();
  console.log(`control bot: @${username} | devs: ${config.devIds.join(',')}`);
  return username;
}
function stop() { running = false; if (ctl) ctl.abort(); }

module.exports = { start, stop, username: () => username };
