/**
 * فك ZIP بدون مكتبات (zlib فقط). مع حماية من:
 * zip-slip (مسارات ..)، قنابل الضغط (حد للحجم والعدد)، الروابط الرمزية، والملفات المشفّرة.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const inflateRaw = promisify(zlib.inflateRaw);
const { HttpError } = require('./util');

const bad = (msg) => new HttpError(400, msg);

function readEntries(buf) {
  const min = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('الملف مش ZIP صالح');
  const total = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOff === 0xffffffff) throw bad('ملفات ZIP64 مش مدعومة. اضغطها بشكل عادي');

  const entries = [];
  let p = cdOff;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('ملف ZIP تالف');
    const flags = buf.readUInt16LE(p + 8);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    entries.push({
      flags,
      method: buf.readUInt16LE(p + 10),
      csize: buf.readUInt32LE(p + 20),
      usize: buf.readUInt32LE(p + 24),
      mode: buf.readUInt32LE(p + 38) >>> 16,
      offset: buf.readUInt32LE(p + 42),
      name: buf.toString('utf8', p + 46, p + 46 + nlen).replace(/\\/g, '/')
    });
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

function safeRel(name) {
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.includes('\0')) return null;
  const parts = name.split('/').filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) return null;
  return parts.join('/');
}

/**
 * @returns {{files:number, bytes:number}}
 */
async function extractZip(buf, dest, { maxFiles, maxBytes }) {
  const all = readEntries(buf);
  const files = [];
  for (const e of all) {
    if (e.name.endsWith('/')) continue;
    if (e.name.startsWith('__MACOSX/') || e.name.endsWith('.DS_Store')) continue;
    if ((e.mode & 0o170000) === 0o120000) continue; // symlink
    if (e.flags & 1) throw bad('الـ ZIP فيه ملفات مشفّرة بكلمة سر');
    if (e.method !== 0 && e.method !== 8) throw bad('طريقة ضغط غير مدعومة');
    const rel = safeRel(e.name);
    if (rel === null) throw bad('الـ ZIP فيه مسارات غير مسموحة');
    files.push({ ...e, rel });
  }
  if (!files.length) throw bad('الـ ZIP فاضي');
  if (files.length > maxFiles) throw bad(`عدد الملفات كبير (الحد ${maxFiles})`);
  const declared = files.reduce((n, f) => n + f.usize, 0);
  if (declared > maxBytes) throw bad(`الحجم بعد الفك كبير (الحد ${Math.round(maxBytes / 1048576)}MB)`);

  // لو كل الملفات جوه فولدر واحد، نشيله
  const firsts = new Set(files.map((f) => f.rel.split('/')[0]));
  const strip = firsts.size === 1 && files.every((f) => f.rel.includes('/')) ? `${[...firsts][0]}/` : '';

  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  let written = 0;
  const made = new Set();
  const one = async (f) => {
    if (f.offset + 30 > buf.length || buf.readUInt32LE(f.offset) !== 0x04034b50) throw bad('ملف ZIP تالف');
    const start = f.offset + 30 + buf.readUInt16LE(f.offset + 26) + buf.readUInt16LE(f.offset + 28);
    const raw = buf.subarray(start, start + f.csize);
    let data;
    try {
      data = f.method === 0 ? raw : await inflateRaw(raw, { maxOutputLength: f.usize + 1 });
    } catch { throw bad('ملف ZIP تالف أو أكبر من المعلن'); }
    if (data.length !== f.usize) throw bad('ملف ZIP تالف');
    written += data.length;
    if (written > maxBytes) throw bad('الحجم بعد الفك كبير');
    const rel = strip ? f.rel.slice(strip.length) : f.rel;
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) throw bad('الـ ZIP فيه مسارات غير مسموحة');
    const d = path.dirname(target);
    if (!made.has(d)) { await fs.promises.mkdir(d, { recursive: true }); made.add(d); }
    await fs.promises.writeFile(target, data, { mode: 0o644 });
  };
  // فك وكتابة 16 ملف في نفس الوقت بدل واحد ورا التاني
  let next = 0;
  const worker = async () => { while (next < files.length) await one(files[next++]); };
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, worker));
  return { files: files.length, bytes: written };
}

module.exports = { extractZip };
