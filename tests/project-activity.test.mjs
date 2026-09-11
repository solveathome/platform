import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import pg from 'pg';
import {ACTIVITY_SQL, ACTIVE_AGENTS_SQL, RUNNING_WORK_SQL} from '../src/lib/project-activity.ts';

// Fixtures live only in connection-local temp tables that mirror the columns the query reads; nothing is written to the real tables.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the activity query tests.');
const db = new pg.Client({connectionString: process.env.TEST_DATABASE_URL});
before(async () => {
  await db.connect();
  await db.query(`
    CREATE TEMP TABLE users (id bigint, handle text);
    CREATE TEMP TABLE pool (problem_id bigint, user_id bigint, model text, last_seen timestamptz);
    CREATE TEMP TABLE sessions (id text, problem_id bigint, user_id bigint, model text, last_seen timestamptz, ended_at timestamptz, effort text);
    CREATE TEMP TABLE jobs (problem_id bigint, assigned_to bigint, assigned_session text, status text, expires_at timestamptz, id bigserial, title text, type text, assigned_at timestamptz);
    CREATE TEMP TABLE returns (id bigint, problem_id bigint, tokens jsonb, cpu_hours numeric);
    CREATE TEMP TABLE reviews (return_id bigint, tokens jsonb);
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
  const {rows: [running]} = await db.query(RUNNING_WORK_SQL, [1]);
  assert.equal(Number(running.total), 0);
  assert.deepEqual(running.jobs, []);
});

test('counts are project-scoped, exclude expired assignments, and count each usage record once', async () => {
  await db.query(`
    INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol');
    INSERT INTO pool VALUES (1, 1, 'model-a', now()), (1, 2, 'model-b', now() - interval '25 hours'), (2, 3, 'model-c', now());
    -- Alice runs two agents at once (two sessions, two models); Bob's session is stale; Carol is on another project.
    INSERT INTO sessions (id, problem_id, user_id, model, last_seen) VALUES ('s-a1', 1, 1, 'model-a', now()), ('s-a2', 1, 1, 'model-a2', now() - interval '1 minute'), ('s-b', 1, 2, 'model-b', now() - interval '25 hours'), ('s-c', 2, 3, 'model-c', now());
    INSERT INTO jobs (problem_id, assigned_to, assigned_session, status, expires_at) VALUES
      (1, 1, 's-a1', 'assigned', now() + interval '1 hour'), (1, 1, 's-a2', 'assigned', null),
      (1, 1, 's-a1', 'assigned', now() - interval '1 hour'), (1, null, null, 'queued', null),
      (1, null, null, 'queued', null), (1, 2, 's-b', 'returned', now() + interval '1 hour'),
      (2, 3, 's-c', 'assigned', now() + interval '1 hour'), (2, null, null, 'queued', null);
    INSERT INTO returns VALUES
      (1, 1, '{"input":100,"output":20,"cache_read":30,"cache_write":40}', 1.25),
      (2, 1, '{"output":10}', 0.5), (3, 1, null, 0),
      (4, 2, '{"input":9999}', 9999);
    INSERT INTO reviews VALUES
      (1, '{"input":5,"output":2,"cache_read":3,"cache_write":4}'),
      (1, null),
      (4, '{"input":9999}');
    INSERT INTO channels VALUES (1, 1), (2, 1), (3, 2);
    INSERT INTO messages VALUES (1, now()), (2, now()), (1, now() - interval '25 hours'), (3, now());
  `);
  const {rows: [activity]} = await db.query(ACTIVITY_SQL, [1]);
  assert.deepEqual(Object.fromEntries(Object.entries(activity).filter(([key]) => key !== 'as_of').map(([key, value]) => [key, Number(value)])), {
    agents_24h: 2, agents_total: 3, contributors: 2, assignments_underway: 2, assignments_abandoned: 0, assignments_queued: 2,
    results_submitted: 3, reviews_completed: 2, messages_24h: 2, tokens_contributed: 214, cpu_hours: 1.75,
  });
  const {rows: agents} = await db.query(ACTIVE_AGENTS_SQL, [1]);
  assert.equal(agents.length, 2);
  assert.deepEqual(agents.map(a => [a.handle, a.model, Number(a.assignments_underway)]), [['Alice', 'model-a', 1], ['Alice', 'model-a2', 1]]);
  assert.deepEqual(Object.keys(agents[0]).sort(), ['assignments_underway', 'handle', 'last_seen', 'model']);
});

test('roster limit does not truncate totals', async () => {
  await db.query(`
    INSERT INTO users SELECT n, 'Donor-' || n FROM generate_series(10, 24) n;
    INSERT INTO pool SELECT 3, n, 'test-model', now() - n * interval '1 minute' FROM generate_series(10, 24) n;
    INSERT INTO sessions (id, problem_id, user_id, model, last_seen) SELECT 's-' || n, 3, n, 'test-model', now() - n * interval '1 minute' FROM generate_series(10, 24) n;
  `);
  const {rows: [activity]} = await db.query(ACTIVITY_SQL, [3]);
  const {rows: agents} = await db.query(ACTIVE_AGENTS_SQL, [3]);
  assert.equal(Number(activity.agents_24h), 15); assert.equal(Number(activity.agents_total), 15);
  assert.equal(agents.length, 12);
  assert.equal(agents[0].handle, 'Donor-10');
});

test('running work belongs to the actual live session; stale, ended, orphaned and expired jobs stay out', async () => {
  await db.query(`
    INSERT INTO sessions (id, problem_id, user_id, model, effort, last_seen, ended_at) VALUES
      ('work-a', 4, 1, 'model-a', 'high', now(), null),
      ('work-b', 4, 1, 'model-b', 'max', now() - interval '5 minutes', null),
      ('work-quiet', 4, 2, 'model-quiet', null, now() - interval '2 hours', null),
      ('work-ended', 4, 2, 'model-ended', null, now(), now());
    INSERT INTO jobs (problem_id, assigned_to, assigned_session, status, expires_at, title, type, assigned_at) VALUES
      (4, 1, 'work-a', 'assigned', now() + interval '1 hour', 'Check a proof', 'review', now()),
      (4, 1, 'work-b', 'assigned', null, 'Try a new direction', 'explore', now()),
      (4, 1, 'work-a', 'assigned', now() - interval '1 minute', 'Expired', 'review', now()),
      (4, 2, 'work-quiet', 'assigned', null, 'Quiet', 'review', now()),
      (4, 2, 'work-ended', 'assigned', null, 'Ended', 'review', now()),
      (4, 1, 'work-a', 'returned', null, 'Returned', 'review', now()),
      (4, 1, 'missing', 'assigned', null, 'Missing agent', 'review', now()),
      (4, 2, 'work-a', 'assigned', null, 'Wrong owner', 'review', now()),
      (4, 1, 's-a1', 'assigned', null, 'Wrong project session', 'review', now());
  `);
  const {rows: [running]} = await db.query(RUNNING_WORK_SQL, [4]);
  assert.equal(Number(running.total), 2);
  assert.deepEqual(running.jobs.map(j => [j.handle, j.model, j.effort, j.title]), [
    ['Alice', 'model-a', 'high', 'Check a proof'], ['Alice', 'model-b', 'max', 'Try a new direction'],
  ]);
  assert.deepEqual(Object.keys(running.jobs[0]).sort(), ['assigned_at', 'effort', 'handle', 'id', 'last_seen', 'model', 'title', 'type']);
  const {rows: [activity]} = await db.query(ACTIVITY_SQL, [4]);
  assert.equal(Number(activity.assignments_underway), Number(running.total));
  assert.equal(Number(activity.assignments_abandoned), 5);
  const {rows: agents} = await db.query(ACTIVE_AGENTS_SQL, [4]);
  assert.equal(agents.reduce((n, a) => n + Number(a.assignments_underway), 0), 2);
});

test('running work stays bounded without truncating the count', async () => {
  await db.query(`
    INSERT INTO sessions (id, problem_id, user_id, model, last_seen) VALUES ('busy', 5, 1, 'test-model', now());
    INSERT INTO jobs (problem_id, assigned_to, assigned_session, status, title, type, assigned_at)
      SELECT 5, 1, 'busy', 'assigned', 'Assignment ' || n, 'explore', now() - n * interval '1 second' FROM generate_series(1, 101) n;
  `);
  const {rows: [running]} = await db.query(RUNNING_WORK_SQL, [5]);
  assert.equal(Number(running.total), 101);
  assert.equal(running.jobs.length, 100);
  assert.equal(running.jobs[0].title, 'Assignment 1');
  assert.equal(running.jobs.at(-1).title, 'Assignment 100');
});
