import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// A lane's channel exists from its first message, and an accepted direction opens a lane only when it carries its person's
// words (Chris, Sep 25 2026: seven route results filed as directions left seven empty channels in the discussion list).
// Closed lanes stay on record but are never listed as active or picked for work. Real Postgres; everything created is deleted.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the lane channel tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';
const docs = mkdtempSync(join(tmpdir(), 'sah-lanes-'));
process.env.DOCS_DIR = docs;

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job, resolveReturn} = await import('../src/routes/job.ts');
const {chat, ensureChannels} = await import('../src/routes/chat.ts');
const {board} = await import('../src/routes/board.ts');

const tag = `lanes-test-${Date.now().toString(36)}`;
let server, base, author, reviewer, pid, token, closedLane, legacyLane;
const users = () => [author, reviewer];

before(async () => {
  await migrate();
  mkdirSync(join(docs, tag, 'research'), {recursive: true});
  writeFileSync(join(docs, tag, 'research', 'QUESTIONS.md'), `| item | question | status | verdict |\n|---|---|---|---|\n| 1 | \`Q-alpha\` first thing | OPEN | nothing yet |\n| 2 | \`Q-beta\` second thing | OPEN | nothing yet |\n`);
  const mk = async (h) => Number((await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [920_000_000 + Math.floor(Math.random() * 1e8), `${tag}-${h}`, TERMS_VERSION])).id);
  author = await mk('author'); reviewer = await mk('reviewer');
  token = await issueToken(author, 'lane-channels-test');
  pid = Number((await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,'Lane channel test','https://example.org/r','open') RETURNING id`, [tag])).id);
  // Made first, so the lowest ids: the explore fallback would reach them first if it did not skip them.
  closedLane = Number((await one(`INSERT INTO lanes (problem_id, slug, title, status) VALUES ($1,'gone','A closed lane','closed') RETURNING id`, [pid])).id);
  const legacy = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'direction',$2,'claude-fable-5-1','anthropic','Return report: a route result.','t','accepted') RETURNING id`, [pid, author]);
  legacyLane = Number((await one(`INSERT INTO lanes (problem_id, slug, title, variant, origin_user_id) VALUES ($1,$2,'A route result','direction',$3) RETURNING id`, [pid, `dir-${legacy.id}`, author])).id);
  await q(`INSERT INTO lanes (problem_id, slug, title) VALUES ($1,'lane-a','Lane A')`, [pid]);
  await ensureChannels(pid);
  const root = await one(`SELECT id FROM channels WHERE problem_id = $1 AND path = ''`, [pid]);
  await q(`INSERT INTO channels (problem_id, parent_id, lane_id, path, title, status) VALUES ($1,$2,$3,'gone','A closed lane','closed')`, [pid, root.id, closedLane]);
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job); app.use('/projects/:slug', chat); app.use('/projects/:slug', board);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/projects/${tag}`;
});

after(async () => {
  server?.close();
  await q(`DELETE FROM messages WHERE user_id = ANY($1)`, [users()]);
  await q(`DELETE FROM channel_members WHERE user_id = ANY($1)`, [users()]);
  await q(`DELETE FROM credits WHERE user_id = ANY($1)`, [users()]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM reviews WHERE user_id = ANY($1)`, [users()]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM sessions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM pool WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1 AND parent_id IS NOT NULL`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM lanes WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM tokens WHERE user_id = ANY($1)`, [users()]);
  await q(`DELETE FROM reputation WHERE user_id = ANY($1)`, [users()]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [users()]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE id = ANY($1)) + (SELECT count(*) FROM problems WHERE id = $2) + (SELECT count(*) FROM lanes WHERE problem_id = $2) + (SELECT count(*) FROM channels WHERE problem_id = $2) AS n`, [users(), pid]);
  await pool.end();
  rmSync(docs, {recursive: true, force: true});
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const call = async (method, path, body) => {
  const r = await fetch(base + path, {method, headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', 'x-model': 'claude-fable-5-1'}, ...(body ? {body: JSON.stringify(body)} : {})});
  const t = await r.text(); return {status: r.status, body: t ? JSON.parse(t) : null};
};
const listed = async () => (await call('GET', '/chat')).body.map((c) => c.path);
const acceptDirection = async (human_md) => {
  const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, human_md, transcript, status) VALUES ($1,'direction',$2,'claude-fable-5-1','anthropic','Return report: arrangement statistics of route 7.',$3,'t','pending') RETURNING id`, [pid, author, human_md]);
  await q(`INSERT INTO reviews (return_id, user_id, model, provider, verdict, notes_md, weight, transcript, trusted) VALUES ($1,$2,'claude-opus-5-5','anthropic','accept','Checked.',1,'',true)`, [r.id, reviewer]);
  await resolveReturn(Number(r.id));
  assert.equal((await one(`SELECT status FROM returns WHERE id = $1`, [r.id])).status, 'accepted');
  return Number(r.id);
};

test('an accepted direction without its person\'s words (a route result) opens no lane', async () => {
  const id = await acceptDirection(null);
  assert.equal(await one(`SELECT 1 FROM lanes WHERE problem_id = $1 AND slug = $2`, [pid, `dir-${id}`]), undefined);
  const blank = await acceptDirection('   ');
  assert.equal(await one(`SELECT 1 FROM lanes WHERE problem_id = $1 AND slug = $2`, [pid, `dir-${blank}`]), undefined);
});

test('an accepted direction with its person\'s words opens a lane, and no channel until someone posts', async () => {
  const id = await acceptDirection('Try the sieve from the other side.');
  const lane = await one(`SELECT id, status FROM lanes WHERE problem_id = $1 AND slug = $2`, [pid, `dir-${id}`]);
  assert.equal(lane?.status, 'open');
  assert.equal(await one(`SELECT 1 FROM channels WHERE lane_id = $1`, [lane.id]), undefined);
  assert.ok(!(await listed()).includes(`dir-${id}`), 'an empty lane channel is listed');
});

test('a lane channel is made by its first message: reading and joining before that make nothing', async () => {
  assert.ok(!(await listed()).includes('lane-a'));
  const read = await call('GET', '/chat/lane-a/messages');
  assert.equal(read.status, 200); assert.deepEqual(read.body.messages, []);
  const join = await call('POST', '/chat/lane-a/join');
  assert.equal(join.status, 200); assert.deepEqual(join.body.recent, []);
  assert.equal(await one(`SELECT 1 FROM channels WHERE problem_id = $1 AND path = 'lane-a'`, [pid]), undefined, 'joining made the channel');
  const post = await call('POST', '/chat/lane-a/messages', {body_md: 'Taking the corner case.', kind: 'idea'});
  assert.equal(post.status, 200, JSON.stringify(post.body));
  const ch = await one(`SELECT c.id, c.parent_id, l.slug FROM channels c JOIN lanes l ON l.id = c.lane_id WHERE c.problem_id = $1 AND c.path = 'lane-a'`, [pid]);
  assert.ok(ch?.parent_id, 'the lane channel hangs off the project root'); assert.equal(ch.slug, 'lane-a');
  assert.ok((await listed()).includes('lane-a'));
  assert.equal((await call('GET', '/chat/lane-a/messages')).body.messages.length, 1);
  assert.equal((await call('POST', '/chat/gone/messages', {body_md: 'hello', kind: 'idea'})).status, 409, 'a closed lane took a post');
});

test('closed lanes leave the discussion list and the active lanes table, stay on record, and never get explore work', async () => {
  assert.ok(!(await listed()).includes('gone'), 'a closed empty channel is listed');
  const b = await (await fetch(`${base}/board`, {headers: {accept: 'application/json'}})).json();
  assert.ok(!b.lanes.some((l) => l.slug === 'gone'), 'a closed lane is in the active table');
  assert.ok(await one(`SELECT 1 FROM lanes WHERE id = $1`, [closedLane]), 'the closed lane is kept');
  const allowed = new Set(['lane-a', ...(await q(`SELECT slug FROM lanes WHERE problem_id = $1 AND variant = 'direction' AND status = 'open' AND id <> $2`, [pid, legacyLane])).map((l) => l.slug)]);
  for (let i = 0; i < 2; i++) {
    const r = await fetch(base + '/start', {method: 'POST', headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', 'x-model': 'claude-opus-5'}, body: JSON.stringify({agreed: true, ai: {max_hours_per_assignment: 1, max_assignments: 1}, transcript_preapproved: true})});
    const t = await r.text(); assert.equal(r.status, 200, t);
    const j = await one(`SELECT j.type, l.slug FROM jobs j LEFT JOIN lanes l ON l.id = j.lane_id WHERE j.id = $1`, [JSON.parse(t).job_id]);
    assert.equal(j.type, 'explore');
    assert.ok(allowed.has(j.slug), `explore landed on '${j.slug}'`);
  }
});

test('at start the schema closes lanes opened from directions without their person\'s words, and their empty channels', async () => {
  const root = await one(`SELECT id FROM channels WHERE problem_id = $1 AND path = ''`, [pid]);
  const legacySlug = (await one(`SELECT slug FROM lanes WHERE id = $1`, [legacyLane])).slug;
  await q(`INSERT INTO channels (problem_id, parent_id, lane_id, path, title) VALUES ($1,$2,$3,$4,'A route result')`, [pid, root.id, legacyLane, legacySlug]);
  const kept = (await one(`SELECT slug FROM lanes WHERE problem_id = $1 AND variant = 'direction' AND status = 'open' AND id <> $2`, [pid, legacyLane])).slug;
  await migrate();
  assert.equal((await one(`SELECT status FROM lanes WHERE id = $1`, [legacyLane])).status, 'closed');
  assert.equal((await one(`SELECT status FROM channels WHERE lane_id = $1`, [legacyLane])).status, 'closed');
  assert.ok(!(await listed()).includes(legacySlug), 'the closed empty channel is still listed');
  assert.equal((await one(`SELECT status FROM lanes WHERE problem_id = $1 AND slug = $2`, [pid, kept])).status, 'open', 'a person\'s direction lane was closed');
  assert.equal((await one(`SELECT status FROM lanes WHERE problem_id = $1 AND slug = 'lane-a'`, [pid])).status, 'open');
});
