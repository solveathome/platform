import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import pg from 'pg';

// The boot schema must not deadlock with live requests (Oct 13 2026, #sah-boot-schema-deadlocks). schema.sql runs at every start while
// the other blue/green slot serves; sent as one query it held users' AccessExclusiveLock from its first ALTER and then waited for tokens,
// which a live request held while it waited for users: 25 deadlocks in production from Oct 5 to Oct 12. This replays that request
// against a running migrate(): it holds tokens, then reads users and assignment_attempts. migrate() now takes every lock first, in name
// order, within less than deadlock_timeout, and retries; both sides must finish without an error. Creates no rows.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the boot schema lock test.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const {migrate, pool} = await import('../src/db/index.ts');
const live = new pg.Client({connectionString: process.env.TEST_DATABASE_URL, statement_timeout: 10_000});
before(async () => { await migrate(); await live.connect(); });
after(async () => { await live.end(); await pool.end(); });

test('a boot schema run beside a live request that holds tokens and then reads users finishes without a deadlock', async () => {
  await live.query('BEGIN');
  await live.query('SELECT 1 FROM tokens LIMIT 1');
  const livePid = (await live.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  let migrateError = null;
  const run = migrate().catch((e) => { migrateError = e; });
  // Wait until the schema is queued behind the live request's lock on tokens.
  const watch = new pg.Client({connectionString: process.env.TEST_DATABASE_URL});
  await watch.connect();
  try {
    for (let i = 0; i < 100; i++) {
      const {rows} = await watch.query(`SELECT 1 FROM pg_locks WHERE NOT granted AND relation = 'tokens'::regclass AND pid <> $1`, [livePid]);
      if (rows.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally { await watch.end(); }
  try {
    await live.query('SELECT 1 FROM users LIMIT 1');
    await live.query('SELECT 1 FROM assignment_attempts LIMIT 1');
    await live.query('COMMIT');
  } catch (e) {
    await live.query('ROLLBACK').catch(() => {});
    assert.fail(`the live request failed beside the boot schema: ${e.code} ${e.message}`);
  }
  await run;
  assert.equal(migrateError, null, `the boot schema failed beside a live request: ${migrateError?.code} ${migrateError?.message}`);
});

test('a second boot against an applied schema holds no lock once it returns, and its connection keeps the pool timeout', async () => {
  await migrate();
  const {rows} = await pool.query(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.mode = 'AccessExclusiveLock' AND c.relnamespace = 'public'::regnamespace`);
  assert.equal(rows[0].n, 0);
  const clients = await Promise.all(Array.from({length: 3}, () => pool.connect()));
  try { for (const c of clients) assert.equal((await c.query('SHOW statement_timeout')).rows[0].statement_timeout, '15s'); } finally { clients.forEach((c) => c.release()); }
});
