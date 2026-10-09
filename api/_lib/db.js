// Database access: Neon serverless driver Pool over WebSockets (interactive transactions + row locks).
// Reads the pooled DATABASE_URL set by the Neon Marketplace integration. (Ignore POSTGRES_* vars.)
// Following Neon's Vercel guidance, a Pool is created per request and closed after the response.
import { Pool } from '@neondatabase/serverless';
import { waitUntil } from '@vercel/functions';
import { ensureSchema } from '../_db/migrate.js';

export function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw Object.assign(new Error('DATABASE_URL is not set'), { status: 503, expose: 'Database not configured' });
  return url;
}

export const newPool = (connectionString = databaseUrl()) => new Pool({ connectionString, max: 4 });

/** Run fn(pool) with a fresh pool; schema is ensured once per instance. */
export async function withPool(fn) {
  const pool = newPool();
  try {
    await ensureSchema(pool);
    return await fn(pool);
  } finally {
    const end = pool.end().catch(() => {});
    try { waitUntil(end); } catch { await end; }
  }
}

const RETRYABLE = new Set(['40P01', '40001']); // deadlock_detected, serialization_failure

/** BEGIN ... COMMIT on one client; ROLLBACK on error. Deadlocks are retried (the whole fn re-runs). */
export async function tx(pool, fn, { tries = 4 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (!(e && RETRYABLE.has(e.code)) || attempt >= tries) throw e;
      console.warn(`[tx] retrying after ${e.code} (attempt ${attempt})`);
      await new Promise(r => setTimeout(r, 10 + Math.random() * 40 * attempt));
    } finally {
      client.release();
    }
  }
}

export const money = v => (v == null ? 0 : Math.round(Number(v) * 100) / 100);
