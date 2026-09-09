import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import pg from 'pg';
import {ACTIVITY_SQL, ACTIVE_AGENTS_SQL} from '../src/lib/project-activity.ts';

// Use a disposable PostgreSQL database. Fixtures live only in connection-local temp tables.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the activity query tests.');
const db = new pg.Client({connectionString: process.env.TEST_DATABASE_URL});
before(async () => {
  await db.connect();
  await db.query(`
    CREATE TEMP TABLE users (id bigint, handle text);
    CREATE TEMP TABLE pool (problem_id bigint, user_id bigint, model text, last_seen timestamptz);
    CREATE TEMP TABLE jobs (problem_id bigint, assigned_to bigint, status text, expires_at timestamptz);
    CREATE TEMP TABLE returns (id bigint, problem_id bigint, tokens jsonb, cpu_hours numeric);
    CREATE TEMP TABLE credits (problem_id bigint, kind text, source_type text, note text);
    CREATE TEMP TABLE reviews (return_id bigint);
    CREATE TEMP TABLE channels (id bigint, problem_id bigint);
    CREATE TEMP TABLE messages (channel_id bigint, created_at timestamptz);
  `);
});
after(async () => { await db.end(); });

test('empty project has zero totals and no recently active agents', async () => {
  const {rows: [activity]} = await db.query(ACTIVITY_SQL, [1]);
  for (const [key, value] of Object.entries(activity)) {
    if (key !== 'as_of') assert.equal(Number(value), 0, key);
  }
  assert.deepEqual((await db.query(ACTIVE_AGENTS_SQL, [1])).rows, []);
});

test('counts are project-scoped, exclude expired assignments, and count each usage record once', async () => {
  await db.query(`
    INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol');
    INSERT INTO pool VALUES (1, 1, 'model-a', now()), (1, 2, 'model-b', now() - interval '25 hours'), (2, 3, 'model-c', now());
    INSERT INTO jobs VALUES
      (1, 1, 'assigned', now() + interval '1 hour'), (1, 1, 'assigned', null),
      (1, 1, 'assigned', now() - interval '1 hour'), (1, null, 'queued', null),
      (1, null, 'queued', null), (1, 2, 'returned', now() + interval '1 hour'),
      (2, 3, 'assigned', now() + interval '1 hour'), (2, null, 'queued', null);
    INSERT INTO returns VALUES
      (1, 1, '{"input":100,"output":20,"cache_read":30,"cache_write":40}', 1.25),
      (2, 1, '{"output":10}', 0.5), (3, 1, null, 0),
      (4, 2, '{"input":9999}', 9999);
    INSERT INTO credits VALUES
      (1, 'tokens', 'review', '{"input":5,"output":2,"cache_read":3,"cache_write":4}'),
      (1, 'tokens', 'return', '200 tokens: an accepted result credit, not extra usage'),
      (1, 'review', 'review', 'Reviewer credit, not token usage'),
      (2, 'tokens', 'review', '{"input":9999}');
    INSERT INTO reviews VALUES (1), (1), (4);
    INSERT INTO channels VALUES (1, 1), (2, 1), (3, 2);
    INSERT INTO messages VALUES (1, now()), (2, now()), (1, now() - interval '25 hours'), (3, now());
  `);
  const {rows: [activity]} = await db.query(ACTIVITY_SQL, [1]);
  assert.deepEqual(Object.fromEntries(Object.entries(activity).filter(([key]) => key !== 'as_of').map(([key, value]) => [key, Number(value)])), {
    agents_24h: 1, contributors: 2, assignments_underway: 2, assignments_queued: 2,
    results_submitted: 3, reviews_completed: 2, messages_24h: 2, tokens_contributed: 214, cpu_hours: 1.75,
  });
  const {rows: agents} = await db.query(ACTIVE_AGENTS_SQL, [1]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].handle, 'Alice');
  assert.equal(agents[0].model, 'model-a');
  assert.equal(Number(agents[0].assignments_underway), 2);
  assert.deepEqual(Object.keys(agents[0]).sort(), ['assignments_underway', 'handle', 'last_seen', 'model']);
});

test('roster limit does not truncate totals', async () => {
  await db.query(`
    INSERT INTO users SELECT n, 'Donor-' || n FROM generate_series(10, 24) n;
    INSERT INTO pool SELECT 3, n, 'test-model', now() - n * interval '1 minute' FROM generate_series(10, 24) n;
  `);
  const {rows: [activity]} = await db.query(ACTIVITY_SQL, [3]);
  const {rows: agents} = await db.query(ACTIVE_AGENTS_SQL, [3]);
  assert.equal(Number(activity.agents_24h), 15);
  assert.equal(agents.length, 12);
  assert.equal(agents[0].handle, 'Donor-10');
});
