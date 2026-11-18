const fs = require('fs');
const path = require('path');
const { HttpError } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'", "base-uri 'none'",
  "form-action 'self'", "frame-ancestors 'none'"
].join('; ');

function secure(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) { req.resume(); return reject(new HttpError(413, `الحجم أكبر من الحد (${Math.round(limit / 1048576)}MB)`)); }
    const chunks = [];
    let n = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > limit) { done = true; return reject(new HttpError(413, `الحجم أكبر من الحد (${Math.round(limit / 1048576)}MB)`)); }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

async function readJson(req, limit = 100 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'JSON غير صالح'); }
}

function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler) {
      const keys = [];
      const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; })}$`);
      routes.push({ method, re, keys, handler });
    },
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
      return { handler: null, pathMatched };
    }
  };
}

const gzCache = new Map();
function serveStatic(publicDir, req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const full = path.normalize(path.join(publicDir, rel));
  if (!full.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const type = MIME[path.extname(full)] || 'application/octet-stream';
    const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
    const head = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag };
    if (/(text|javascript|json|svg)/.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      const hit = gzCache.get(full);
      const send = (gz) => { res.writeHead(200, { ...head, 'Content-Encoding': 'gzip', 'Content-Length': gz.length, Vary: 'Accept-Encoding' }); res.end(req.method === 'HEAD' ? undefined : gz); };
      if (hit && hit.etag === etag) return send(hit.gz);
      return fs.readFile(full, (e2, data) => {
        if (e2) { res.writeHead(500); return res.end(); }
        const gz = require('zlib').gzipSync(data, { level: 9 });
        gzCache.set(full, { etag, gz });
        send(gz);
      });
    }
    res.writeHead(200, { ...head, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  });
}

module.exports = { secure, json, readBody, readJson, createRouter, serveStatic };
