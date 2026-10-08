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
      if (e && e.status && e.expose) return error(e.status, e.expose);
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
