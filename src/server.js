const http = require('http');
const path = require('path');
const config = require('./config');
const store = require('./store');
const manager = require('./manager');
const runtimes = require('./runtimes');
const { router, ensureAdmin } = require('./api');
const control = require('./control');
const { secure, json, serveStatic } = require('./http');
const { HttpError } = require('./util');

const publicDir = path.resolve(__dirname, '..', 'public');

const server = http.createServer(async (req, res) => {
  secure(res);
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  const { pathname } = url;

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(publicDir, req, res, pathname);
  }
  try {
    const m = router.match(req.method, pathname);
    if (!m.handler) return json(res, m.pathMatched ? 405 : 404, { error: 'مش موجود' });
    await m.handler(req, res, { params: m.params, query: url.searchParams });
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch { /* تمام */ } return; }
    if (e instanceof HttpError) {
      if (e.status === 413) res.setHeader('Connection', 'close');
      return json(res, e.status, { error: e.message });
    }
    console.error(e);
    json(res, 500, { error: 'حصل خطأ في السيرفر' });
  }
});
server.requestTimeout = 0;      // رفع الملفات والسجلات اللحظية محتاجة اتصال طويل
server.headersTimeout = 30000;

const rt = runtimes.detect();
server.listen(config.port, () => {
  console.log(`${config.siteName} on :${config.port}`);
  console.log(`runtimes: node ${rt.node.version}` +
    ` | python ${rt.python.ok ? rt.python.version : '-'} (pip ${rt.pip.ok ? 'ok' : '-'})` +
    ` | php ${rt.php.ok ? rt.php.version : '-'} (composer ${rt.composer.ok ? 'ok' : '-'})`);
  console.log(`max bots/user: ${config.maxBotsPerUser} | max running: ${config.maxRunning} | bot memory: ${config.botMemMb}MB`);
  ensureAdmin().catch((e) => console.error('admin:', e.message));
  manager.resumeAll(store.bots);
  control.start();
  // PHP بيتنزّل بس لو فيه سيرفر PHP (أو لما تعمل واحد)، عشان نوفّر الرام والشبكة وقت التشغيل
  if (store.bots.some((b) => b.runtime === 'php')) runtimes.ensurePhp().catch(() => {});
});

let closing = false;
async function bye() {
  if (closing) return;
  closing = true;
  server.close();
  store.flush();
  control.stop();
  await manager.shutdown();
  store.flush();
  process.exit(0);
}
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
