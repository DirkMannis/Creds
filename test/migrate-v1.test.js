// The live DB is at schema v1 with $5 #1 and $20 #1 open. v2 must apply additively on top of it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pool } from '@neondatabase/serverless';
import { freshDb, stopProxy, req } from './helpers.js';
import { migrate, currentVersion, _resetEnsured } from '../api/_db/migrate.js';
import * as board from '../api/board/[stake].js';

let pool;
before(async () => { await freshDb('tipboard_v1'); _resetEnsured(); pool = new Pool({ connectionString: process.env.DATABASE_URL }); });
after(async () => { await pool.end(); await stopProxy(); });

test('v1 database with open boards migrates to v2 without touching existing data', async () => {
  await pool.query(readFileSync(new URL('./fixtures/schema-v1.sql', import.meta.url), 'utf8'));
  assert.equal(await currentVersion(pool), 1);
  // the v1 code path opened $5 #1 and $20 #1 (same as live)
  const { insertBoard } = await import('../api/_lib/board.js');
  const c = await pool.connect();
  try { await c.query('BEGIN'); await insertBoard(c, 5, 1, 0); await insertBoard(c, 20, 1, 0); await c.query('COMMIT'); } finally { c.release(); }
  await pool.query(`INSERT INTO players (token_hash) VALUES (repeat('d', 64))`);
  const before = (await pool.query('SELECT id, stake, n, commit_hash, status FROM boards ORDER BY id')).rows;
  const r = await migrate(pool);
  assert.deepEqual(r, { before: 1, after: 2, applied: true });
  assert.deepEqual((await pool.query('SELECT id, stake, n, commit_hash, status FROM boards ORDER BY id')).rows, before, 'boards untouched');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM players')).rows[0].n, 1);
  assert.equal((await pool.query(`SELECT to_regclass('payouts') IS NOT NULL AS ok`)).rows[0].ok, true);
  await pool.query(`INSERT INTO ledger (player_id, kind, amount) SELECT id, 'preplay', 0 FROM players LIMIT 1`); // new kind accepted
  assert.equal((await migrate(pool)).applied, false, 'idempotent');
  const f = await (await board.GET(req('/api/board/5'))).json();
  assert.equal(f.board.n, 1, 'the live $5 #1 keeps going'); assert.equal(f.board.id, Number(before[0].id));
});
