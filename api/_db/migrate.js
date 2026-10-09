// Idempotent schema migration. Safe to run any number of times, including concurrently:
// every statement is IF NOT EXISTS and the whole run holds a transaction-scoped advisory lock.
//
//   Local:   DATABASE_URL_UNPOOLED=postgres://... node api/_db/migrate.js   (falls back to DATABASE_URL)
//   Remote:  POST /api/admin/migrate with header x-admin-key: <ADMIN_KEY>
//   Lazily:  the API calls ensureSchema() once per function instance.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SCHEMA_VERSION = 1;
const LOCK_KEY = 7340501; // arbitrary constant for pg_advisory_xact_lock
export const schemaSql = () => readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export async function currentVersion(q) {
  const { rows: [t] } = await q.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS ok");
  if (!t.ok) return 0;
  const { rows: [r] } = await q.query('SELECT coalesce(max(version), 0) AS v FROM schema_migrations');
  return Number(r.v);
}

/** Apply api/_db/schema.sql under an advisory lock. Returns { before, after, applied }. */
export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const before = await currentVersion(client);
    if (before < SCHEMA_VERSION) await client.query(schemaSql());
    const after = await currentVersion(client);
    await client.query('COMMIT');
    return { before, after, applied: before < SCHEMA_VERSION };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

let ensured = null; // per instance
export function ensureSchema(pool) {
  if (!ensured) {
    ensured = (async () => {
      if ((await currentVersion(pool)) >= SCHEMA_VERSION) return;
      await migrate(pool);
    })().catch(e => { ensured = null; throw e; });
  }
  return ensured;
}
export const _resetEnsured = () => { ensured = null; };

// CLI: node api/_db/migrate.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) { console.error('Set DATABASE_URL_UNPOOLED (or DATABASE_URL) first.'); process.exit(1); }
  const { Pool, neonConfig } = await import('@neondatabase/serverless');
  if (typeof WebSocket === 'undefined') neonConfig.webSocketConstructor = (await import('ws')).default;
  const pool = new Pool({ connectionString: url });
  try {
    const r = await migrate(pool);
    console.log(r.applied ? `Schema migrated: v${r.before} -> v${r.after}` : `Schema already at v${r.after}; nothing to do.`);
  } finally { await pool.end(); }
}
