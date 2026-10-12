import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';

// JIT stays off on every pooled connection (Oct 12 2026): with it on, Postgres compiled the scheduler's eligibility query to
// machine code on every /ready and /start, about 8 s a query, and /ready took 27-35 s while the rows it counts take milliseconds.
// /ready's answers are pinned by review-triage; this pins the setting that keeps them fast. Creates no rows.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the JIT test.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const {migrate, one, pool, transaction} = await import('../src/db/index.ts');
before(() => migrate());
after(() => pool.end());

test('every pooled connection runs with JIT off, in and outside a transaction', async () => {
  assert.equal((await one(`SHOW jit`)).jit, 'off');
  const clients = await Promise.all([pool.connect(), pool.connect()]);
  try { for (const c of clients) assert.equal((await c.query(`SHOW jit`)).rows[0].jit, 'off'); } finally { clients.forEach(c => c.release()); }
  await transaction(async () => assert.equal((await one(`SHOW jit`)).jit, 'off'));
});
