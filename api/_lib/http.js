// Small Response helpers for Vercel Functions (Web Request/Response signature).
export const NO_STORE = 'no-store';

export function json(body, { status = 200, cache = NO_STORE, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, ...headers },
  });
}

export const error = (status, message, extra = {}) => json({ error: message, ...extra }, { status });

/** Wrap a handler: log unexpected errors, never leak internals (or the connection string). */
export function handle(name, fn) {
  return async request => {
    try {
      return await fn(request);
    } catch (e) {
      if (e && e.status && e.expose) return error(e.status, e.expose, e.extra || {});
      console.error(`[${name}]`, e && e.message ? e.message.replace(/postgres(ql)?:\/\/\S+/g, '[db-url]') : e);
      return error(500, 'Server error');
    }
  };
}

export const clientIp = request =>
  (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';

/** :stake from /api/board/5 (or ?stake=5, which Vercel adds for [stake] routes). */
export function stakeFrom(request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('stake') || url.pathname.split('/').filter(Boolean).pop();
  return /^\d{1,4}$/.test(raw || '') ? Number(raw) : NaN;
}

/** Parse a small JSON body ({} if empty). 400 on bad JSON or > 8 KB. */
export async function readJson(request) {
  const text = await request.text();
  if (text.length > 8192) throw Object.assign(new Error('body too large'), { status: 413, expose: 'Request too large' });
  if (!text.trim()) return {};
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : {}; }
  catch { throw Object.assign(new Error('bad json'), { status: 400, expose: 'Body must be JSON' }); }
}
