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
    CREATE TEMP TABLE sessions (id text, problem_id bigint, user_id bigint, model text, last_seen timestamptz, ended_at timestamptz, effort text, department_id text, run_id text);
    CREATE TEMP TABLE jobs (problem_id bigint, assigned_to bigint, assigned_session text, status text, expires_at timestamptz, id bigserial, title text, type text, assigned_at timestamptz, research_stage text, follow_up_of bigint, evidence_return_id bigint, parent_return_id bigint, research_source_return_id bigint, step_check_of bigint, requires_trust boolean DEFAULT false, brief_md text);
    CREATE TEMP TABLE returns (id bigint, problem_id bigint, tokens jsonb, cpu_hours numeric, job_id bigint, report_md text);
    CREATE TEMP TABLE assignment_attempts (id text, problem_id bigint, job_id bigint, session_id text, user_id bigint, model text, started_at timestamptz, ended_at timestamptz, status text, department_id text, run_id text);
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
    INSERT INTO returns (id,problem_id,tokens,cpu_hours) VALUES
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
  assert.deepEqual(Object.keys(agents[0]).sort(), ['assignments_underway', 'department_id', 'handle', 'last_seen', 'model', 'run_id']);
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

test('live count belongs to the actual session and recent inactive work is explicitly separate', async () => {
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
  assert.deepEqual(running.jobs.filter(j=>j.live).map(j => [j.handle, j.model, j.effort, j.title]), [
    ['Alice', 'model-a', 'high', 'Check a proof'], ['Alice', 'model-b', 'max', 'Try a new direction'],
  ]);
  assert.equal(running.jobs.length, 9);
  assert.equal(Number(running.recent_total), 7);
  assert.equal(running.jobs.filter(j=>!j.live).length,7);
  for(const j of running.jobs) { assert.ok(!('assigned_session' in j));assert.ok(!('session_id' in j));assert.ok(!('attempt_id' in j)); }
  const {rows: [activity]} = await db.query(ACTIVITY_SQL, [4]);
  assert.equal(Number(activity.assignments_underway), Number(running.total));
  assert.equal(Number(activity.assignments_abandoned), 5);
  const {rows: agents} = await db.query(ACTIVE_AGENTS_SQL, [4]);
  assert.equal(agents.reduce((n, a) => n + Number(a.assignments_underway), 0), 2);
});

test('every live job remains available beyond the old hundred-row limit', async () => {
  await db.query(`
    INSERT INTO sessions (id, problem_id, user_id, model, last_seen) VALUES ('busy', 5, 1, 'test-model', now());
    INSERT INTO jobs (problem_id, assigned_to, assigned_session, status, title, type, assigned_at)
      SELECT 5, 1, 'busy', 'assigned', 'Assignment ' || n, 'explore', now() - n * interval '1 second' FROM generate_series(1, 200) n;
  `);
  const {rows: [running]} = await db.query(RUNNING_WORK_SQL, [5]);
  assert.equal(Number(running.total), 200);
  assert.equal(running.jobs.length, 200);
  assert.equal(running.jobs[0].title, 'Assignment 1');
  assert.equal(running.jobs.at(-1).title, 'Assignment 200');
});


test('quiet log uses original last attempts after cleared ownership, deduplicates jobs and excludes never-run work',async()=>{
  await db.query(`
    INSERT INTO jobs (id,problem_id,status,title,type) VALUES
      (7001,7,'queued','Released correction','audit'),(7002,7,'returned','Completed research','explore'),
      (7003,7,'queued','Never assigned','explore'),(7004,7,'queued','Older work','explore'),
      (7005,7,'queued','Fifth work','explore'),(7006,7,'queued','Sixth work','explore'),
      (7007,8,'queued','Another project','explore');
    INSERT INTO assignment_attempts (id,problem_id,job_id,user_id,model,started_at,ended_at,status) VALUES
      ('old',7,7001,1,'original-model',now()-interval '1 day',now()-interval '23 hours','released'),
      ('new',7,7001,2,'last-model',now()-interval '1 minute',now(),'released'),
      ('done',7,7002,1,'research-model',now()-interval '2 minutes',now(),'completed'),
      ('older',7,7004,1,'old-model',now()-interval '3 minutes',now(),'released'),
      ('fifth',7,7005,1,'old-model',now()-interval '4 minutes',now(),'released'),
      ('sixth',7,7006,1,'old-model',now()-interval '5 minutes',now(),'released'),
      ('foreign',8,7007,1,'foreign-model',now(),now(),'released');
  `);
  await db.query(`INSERT INTO jobs (id,problem_id,status,title,type,assigned_to,assigned_at)
    SELECT 7010+n,7,'returned','Earlier work '||n,'explore',1,now() - (10+n)*interval '1 minute' FROM generate_series(0,5)n;`);
  const read=async()=> (await db.query(RUNNING_WORK_SQL,[7])).rows[0];
  let w=await read();
  assert.equal(Number(w.total),0);assert.equal(Number(w.recent_total),10);
  assert.deepEqual(w.jobs.map(j=>j.id),[7001,7002,7004,7005,7006,7010,7011,7012,7013,7014]);
  assert.equal(w.jobs[0].handle,'Bob');assert.equal(w.jobs[0].model,'last-model');
  assert.equal(w.jobs[0].activity_status,'released');assert.equal(w.jobs[1].activity_status,'completed');
  assert.ok(w.jobs.every(j=>!j.live));
  await db.query(`INSERT INTO sessions (id,problem_id,user_id,model,last_seen) VALUES ('now-live',7,1,'live-model',now());
    UPDATE jobs SET assigned_session='now-live',assigned_to=1,assigned_at=now(),status='assigned' WHERE id=7001;`);
  w=await read();assert.equal(Number(w.total),1);assert.equal(Number(w.recent_total),9);
  assert.equal(w.jobs.length,10);assert.equal(w.jobs[0].model,'live-model');assert.equal(w.jobs[0].live,true);
  assert.equal(w.jobs.filter(j=>j.id===7001).length,1);
  // Four live jobs still get six recent rows; ten live jobs get no backfill.
  await db.query(`INSERT INTO jobs (problem_id,assigned_to,assigned_session,status,title,type,assigned_at)
    SELECT 7,1,'now-live','assigned','Live '||n,'explore',now() FROM generate_series(1,3)n;`);
  w=await read();assert.equal(Number(w.total),4);assert.equal(Number(w.recent_total),6);assert.equal(w.jobs.length,10);
  await db.query(`INSERT INTO jobs (problem_id,assigned_to,assigned_session,status,title,type,assigned_at) SELECT 7,1,'now-live','assigned','More live '||n,'explore',now() FROM generate_series(1,6)n;`);
  w=await read();assert.equal(Number(w.total),10);assert.equal(Number(w.recent_total),0);assert.equal(w.jobs.length,10);
});
