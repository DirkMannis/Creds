// POST /api/admin/migrate  (header x-admin-key: <ADMIN_KEY>) -> applies db/schema.sql (idempotent).
// Returns 404 unless ADMIN_KEY is set (16+ chars) and matches. Every call is written to admin_audit.
import { newPool } from '../../lib/db.js';
import { migrate } from '../../db/migrate.js';
import { isAdmin } from '../../lib/auth.js';
import { json, error, handle } from '../../lib/http.js';

export const POST = handle('admin/migrate', async request => {
  if (!isAdmin(request)) return error(404, 'Not found');
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) return error(503, 'Database not configured');
  const pool = newPool(url);
  try {
    const r = await migrate(pool);
    await pool.query(`INSERT INTO admin_audit (actor, action, args) VALUES ('admin-key', 'migrate', $1)`, [JSON.stringify(r)]);
    return json(r);
  } finally { await pool.end().catch(() => {}); }
});
