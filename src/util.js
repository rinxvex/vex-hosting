const crypto = require('crypto');
const config = require('./config');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const stripAnsi = (s) => String(s).replace(ANSI, '');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));
const randomId = (bytes = 5) => crypto.randomBytes(bytes).toString('hex');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- كلمات السر (scrypt) ----------
const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `s1$${b64u(salt)}$${b64u(await scrypt(pw, salt))}`;
}
async function verifyPassword(pw, stored) {
  const [v, salt, hash] = String(stored).split('$');
  if (v !== 's1' || !salt || !hash) return false;
  const got = await scrypt(pw, fromB64u(salt));
  const want = fromB64u(hash);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---------- توكن الجلسة (HMAC) ----------
const hmac = (data) => b64u(crypto.createHmac('sha256', config.secret).update(data).digest());
function signToken(payload, ttlSec = 7 * 24 * 3600) {
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return `${body}.${hmac(body)}`;
}
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(body))) return null;
  try {
    const p = JSON.parse(fromB64u(body).toString('utf8'));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}

// ---------- تشفير أسرار البوت (AES-256-GCM) ----------
const key = crypto.scryptSync(config.secret, 'botnest-secrets-v1', 32);
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return `${b64u(iv)}.${b64u(c.getAuthTag())}.${b64u(enc)}`;
}
function decrypt(text) {
  try {
    const [iv, tag, enc] = String(text).split('.');
    const d = crypto.createDecipheriv('aes-256-gcm', key, fromB64u(iv));
    d.setAuthTag(fromB64u(tag));
    return JSON.parse(Buffer.concat([d.update(fromB64u(enc)), d.final()]).toString('utf8'));
  } catch { return null; }
}

// ---------- حد الطلبات ----------
const buckets = new Map();
function rateLimit(key2, limit, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key2) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) { buckets.set(key2, arr); return false; }
  arr.push(now);
  buckets.set(key2, arr);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (!v.some((t) => now - t < 3600 * 1000)) buckets.delete(k);
}, 10 * 60 * 1000).unref();

module.exports = {
  stripAnsi, safeEqual, randomId, HttpError,
  hashPassword, verifyPassword, signToken, verifyToken, encrypt, decrypt, rateLimit
};
