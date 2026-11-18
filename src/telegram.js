const config = require('./config');

const TOKEN_RE = /^\d{5,12}:[A-Za-z0-9_-]{30,50}$/;
const validToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);
const maskToken = (t) => (typeof t === 'string' && t.includes(':') ? `${t.split(':')[0]}:••••••••` : '');

/**
 * ينده على Bot API. الأخطاء بترجع بـ { status, description } من غير ما التوكن يظهر فيها.
 */
async function call(token, method, params = {}, { signal, timeoutMs = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const res = await fetch(`${config.telegramApi}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctl.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const e = new Error(data.description || `HTTP ${res.status}`);
      e.status = data.error_code || res.status;
      throw e;
    }
    return data.result;
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(signal && signal.aborted ? 'aborted' : 'انتهت مهلة الاتصال بتلجرم');
      err.aborted = Boolean(signal && signal.aborted);
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { call, validToken, maskToken };
