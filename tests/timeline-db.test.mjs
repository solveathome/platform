import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import pg from 'pg';
import {TIMELINE_SQL, TIMELINE_COUNT_SQL, cursorOf, parseCursor} from '../src/lib/timeline.ts';

// Fixtures live only in connection-local temp tables that mirror the columns the query reads; nothing is written to the real tables.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the timeline query tests.');
const db = new pg.Client({connectionString: process.env.TEST_DATABASE_URL});
const T = s => `2026-09-12T${s}Z`;
before(async () => {
  await db.connect();
  await db.query(`
    CREATE TEMP TABLE users (id bigint, handle text, display_name text);
    CREATE TEMP TABLE sessions (id text, model text);
    CREATE TEMP TABLE lanes (id bigint, problem_id bigint, slug text, title text);
    CREATE TEMP TABLE jobs (id bigint, problem_id bigint, lane_id bigint, type text, assigned_to bigint, assigned_session text, assigned_at timestamptz);
    CREATE TEMP TABLE returns (id bigint, problem_id bigint, lane_id bigint, type text, user_id bigint, model text, status text, provisional boolean DEFAULT false, effects_applied_at timestamptz, tokens jsonb, created_at timestamptz);
    CREATE TEMP TABLE reviews (id bigint, return_id bigint, user_id bigint, model text, verdict text, tokens jsonb, created_at timestamptz);
    CREATE TEMP TABLE channels (id bigint, problem_id bigint, path text);
    CREATE TEMP TABLE messages (id bigint, channel_id bigint, user_id bigint, model text, kind text, body_md text, created_at timestamptz);
    INSERT INTO users VALUES (1, 'ann', 'Ann Secret'), (2, 'bo', null), (3, 'cy', null);
    INSERT INTO sessions VALUES ('s1', 'claude-opus-5');
    INSERT INTO lanes VALUES (1, 1, 'g2', 'G2'), (2, 2, 'elsewhere', 'Other project');
    INSERT INTO jobs VALUES (10, 1, 1, 'measure', 1, 's1', '${T('10:00:00')}'), (11, 1, null, 'break', null, null, null), (12, 2, 2, 'measure', 3, null, '${T('10:00:00')}'),
      (13, 1, null, 'audit', 2, null, '${T('08:00:00')}');
    INSERT INTO returns VALUES
      (100, 1, 1, 'measure', 1, 'claude-opus-5', 'accepted', false, '${T('13:00:00')}', '{"input":1000,"output":200}', '${T('11:00:00')}'),
      (101, 1, null, 'break', 2, 'gpt-6-astra', 'rejected', false, null, null, '${T('11:30:00')}'),
      (102, 1, null, 'explore', 2, 'gpt-6-astra', 'pending', false, null, null, '${T('11:45:00')}'),
      (103, 2, 2, 'measure', 3, 'qwen3.8', 'accepted', false, '${T('12:00:00')}', null, '${T('11:00:00')}');
    INSERT INTO reviews VALUES (500, 100, 2, 'gpt-6-astra', 'accept', '{"output":5}', '${T('12:30:00')}'), (501, 101, 1, 'claude-opus-5', 'reject', null, '${T('12:40:00')}'),
      (502, 103, 1, 'claude-opus-5', 'accept', null, '${T('12:00:00')}');
    INSERT INTO channels VALUES (1, 1, ''), (2, 2, '');
    INSERT INTO messages VALUES (900, 1, 3, null, 'say', 'hello', '${T('10:30:00')}'), (901, 1, 3, null, 'spawn', 'bookkeeping', '${T('10:31:00')}'), (902, 2, 3, null, 'say', 'other project', '${T('10:32:00')}');
  `);
});
after(async () => { await db.end(); });

const all = async (floor = null, limit = 1000, cur = null) => (await db.query(TIMELINE_SQL, [1, floor, cur?.t ?? null, cur?.k ?? null, cur?.id ?? null, limit])).rows;

test('one project, every kind, oldest first, no bookkeeping chat, decisions at the moment they were made', async () => {
  const rows = await all();
  assert.deepEqual(rows.map(r => `${r.k}${r.id}`), ['a13', 'a10', 'm900', 'r100', 'r101', 'r102', 'v500', 'v501', 'd101', 'd100']);
  const byKey = Object.fromEntries(rows.map(r => [`${r.k}${r.id}`, r]));
  assert.equal(byKey.a10.model, 'claude-opus-5');                              // the holding session's model
  assert.equal(byKey.a13.model, null);
  assert.equal(new Date(byKey.d100.t).toISOString(), T('13:00:00.000'));       // acceptance effects carry the decision time
  assert.equal(new Date(byKey.d101.t).toISOString(), T('12:40:00.000'));       // a rejection: its last review
  assert.equal(Number(byKey.r100.n), 1200);
  assert.equal(Number(byKey.v500.n), 5);
  assert.equal(byKey.v500.b, '100');
  assert.ok(!JSON.stringify(rows).includes('Ann Secret'));
  assert.equal((await db.query(TIMELINE_COUNT_SQL, [1, null])).rows[0].n, rows.length);
});

test('pages chain by cursor without a gap or a repeat, and the floor leaves out what came before launch', async () => {
  const whole = (await all()).map(r => `${r.k}${r.id}`);
  const seen = []; let cur = null;
  for (let i = 0; i < 10; i++) { const page = await all(null, 3, cur); seen.push(...page.map(r => `${r.k}${r.id}`)); if (page.length < 3) break; cur = parseCursor(cursorOf(page[page.length - 1])); }
  assert.deepEqual(seen, whole);
  const late = await all(T('09:00:00'));
  assert.ok(!late.some(r => r.k === 'a' && r.id === '13'));
  assert.equal((await db.query(TIMELINE_COUNT_SQL, [1, T('09:00:00')])).rows[0].n, whole.length - 1);
});
