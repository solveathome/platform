import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import pg from 'pg';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run standings tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const {pool, migrate} = await import('../src/db/index.ts');
const {standings} = await import('../src/lib/standings.ts');
const db = new pg.Client({connectionString: process.env.TEST_DATABASE_URL});
const originalQuery = pool.query;

before(async () => {
  await migrate();
  await db.connect();
  // All fixtures are connection-local temporary tables; no test users or results reach real tables.
  for (const table of ['users','returns','reviews','sessions','credits','jobs','messages','channels','reputation','pool','model_tiers','files','file_refs','lanes']) {
    await db.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS)`);
  }
  pool.query = (...args) => db.query(...args);
  await db.query(`
    INSERT INTO users (id, github_id, handle, display_name) SELECT n, n, 'person-' || n, CASE WHEN n = 1 THEN 'First Person' END FROM generate_series(1, 16) n;
    INSERT INTO sessions (id, problem_id, user_id, model, last_seen) SELECT 's-' || n, 1, n, 'model-a', now() - n * interval '1 minute' FROM generate_series(1, 12) n;
    INSERT INTO sessions (id, problem_id, user_id, model, last_seen, ended_at) VALUES
      ('second',1,1,'model-a',now(),null), ('ended',1,1,'model-a',now(),now()),
      ('elsewhere',2,13,'elsewhere',now(),null), ('old',1,14,'old-model',now() - interval '40 days',null);
    INSERT INTO returns (id, problem_id, user_id, type, model, provider, report_md, transcript, status, provisional, tokens, created_at) VALUES
      (1,1,1,'source','model-a','test','x','t','accepted',false,'{"output":10}',now()),
      (2,1,2,'source','model-a','test','x','t','accepted',true,'{"input":100}',now()),
      (3,1,2,'source','model-a','test','x','t','rejected',true,'{"cache_read":50}',now()),
      (4,1,14,'source','old-model','test','x','t','accepted',false,'{"output":1000}',now() - interval '40 days'),
      (5,2,13,'source','elsewhere','test','x','t','accepted',false,'{"output":9999}',now());
    INSERT INTO reviews (id, return_id, user_id, model, provider, verdict, tokens, agreed_with_outcome) VALUES
      (1,1,3,'review-only','test','accept','{"output":5}',true),
      (2,2,3,'review-only','test','accept','{"input":20,"cache_write":4}',null);
    INSERT INTO credits (id, user_id, problem_id, model, kind, points, source_type, source_id, created_at) VALUES
      (1,1,1,'model-a','result',100,'return','1',now()),
      (2,1,1,'model-a','result',400,'return','old',now() - interval '40 days'),
      (3,14,1,'old-model','result',10000,'return','4',now() - interval '40 days'),
      (4,15,1,null,'insight',200,'return','1',now()),
      (5,13,2,'elsewhere','result',99999,'return','5',now());
  `);
});
after(async () => { pool.query = originalQuery; await db.end(); await pool.end(); });

test('recent top 10 includes check-ins, deduplicates people, and excludes inactive credit recipients and other projects', async () => {
  const st = await standings(1, '7d', 10);
  assert.equal(st.people_total, 13);
  assert.equal(Number(st.totals.contributors), 13);
  assert.equal(st.active_people_total, 12);
  assert.equal(st.active_people.length, 10);
  assert.equal(st.active_people[0].handle, 'person-1');
  assert.deepEqual(st.active_people.map(p => p.rank), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(Number(st.active_people[0].active_sessions), 2, 'ended and duplicate sessions do not inflate people or live count');
  assert.equal(st.active_people[0].display_name, 'First Person');
  assert.ok(!st.active_people.some(p => ['person-13','person-14','person-15'].includes(p.handle)));
  const beginner = st.active_people.find(p => p.handle === 'person-4');
  assert.equal(Number(beginner.points), 0);
  assert.equal(Number(beginner.submitted), 0);
});

test('awarded points determine rank; provisional decisions remain pending; sparse tokens count exactly once', async () => {
  const st = await standings(1, '7d');
  assert.equal(st.people[0].handle, 'person-15');
  assert.equal(Number(st.totals.returns_accepted), 1);
  assert.equal(Number(st.totals.returns_pending), 2);
  assert.equal(Number(st.totals.returns_rejected), 0);
  assert.equal(Number(st.totals.all_tokens), 189);
  assert.equal(Number(st.people.find(p => p.handle === 'person-2').all_tokens), 150);
  assert.equal(Number(st.agents.find(p => p.model === 'review-only').all_tokens), 29);
  assert.equal(Number(st.agents.find(p => p.model === 'review-only').donors), 1);
  assert.equal(st.recent.find(r => Number(r.id) === 2).provisional, true);
  assert.equal(Number(st.leaders.result.points), 100);
});

test('my rank is available outside the first page and lifetime progress survives a quiet week', async () => {
  const small = await standings(1, '7d', 5, 'PERSON-12');
  assert.equal(small.people.length, 5);
  assert.ok(Number(small.me.rank) > 5);
  const quiet = await standings(1, '7d', 5, 'person-14');
  assert.equal(quiet.me.rank, null);
  assert.equal(Number(quiet.me.all_time_points), 10000);
  const weekly = await standings(1, '7d', 5, 'person-1');
  const all = await standings(1, 'all', 5, 'person-1');
  assert.equal(Number(weekly.me.points), 100);
  assert.equal(Number(weekly.me.all_time_points), 500);
  assert.equal(Number(all.me.all_time_points), 500);
  assert.equal((await standings(1, '7d', 5, 'unknown')).me, null);
});

test('empty projects have zero totals, no ranked people, and no artificial winners', async () => {
  const st = await standings(99, '7d');
  assert.equal(st.people_total, 0);
  assert.equal(st.active_people_total, 0);
  assert.deepEqual(st.people, []);
  assert.deepEqual(st.agents, []);
  assert.ok(Object.values(st.totals).every(v => Number(v) === 0));
});
