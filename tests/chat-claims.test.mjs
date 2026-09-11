import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';

// One claim and one done per assignment, not per job for all time. A job handed back and taken again starts a fresh pair:
// the earlier holder's claim and release note must not block the next taker (a reviewer agent was refused both, Sep 10 2026).
// Runs against a real Postgres (TEST_DATABASE_URL); every row it creates is deleted at the end and a residue check fails the run.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the chat claim tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job} = await import('../src/routes/job.ts');
const {chat, ensureChannels} = await import('../src/routes/chat.ts');

const tag = `claim-test-${Date.now().toString(36)}`;
const slug = tag, handle = `${tag}-person`;
let server, base, uid, pid, token, jobId;

before(async () => {
  await migrate();
  const u = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), handle, TERMS_VERSION]);
  uid = Number(u.id);
  token = await issueToken(uid, 'chat-claims-test');
  const p = await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,$2,'https://example.org/r','open') RETURNING id`, [slug, 'Claims test']);
  pid = Number(p.id);
  const l = await one(`INSERT INTO lanes (problem_id, slug, title) VALUES ($1,'lane','Lane') RETURNING id`, [pid]);
  await ensureChannels(pid);
  const j = await one(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status)
                       VALUES ($1,$2,'source','Source 1','find the page','main','{}',1,99,1,'queued') RETURNING id`, [pid, Number(l.id)]);
  jobId = Number(j.id);
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job); app.use('/projects/:slug', chat);
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/projects/${slug}`;
});

after(async () => {
  server?.close();
  await q(`DELETE FROM messages WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM channel_members WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM sessions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM pool WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM lanes WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM tokens WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM reputation WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM users WHERE id = $1`, [uid]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE handle = $1) + (SELECT count(*) FROM problems WHERE slug = $1) + (SELECT count(*) FROM sessions WHERE user_id = $2) + (SELECT count(*) FROM jobs WHERE problem_id = $3) + (SELECT count(*) FROM messages WHERE user_id = $2) AS n`, [handle, uid, pid]);
  await pool.end();
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const call = (method, path, {model, session, body} = {}) => fetch(base + path, {
  method, headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', ...(model ? {'x-model': model} : {}), ...(session ? {'x-session': session} : {})},
  body: body ? JSON.stringify(body) : undefined,
});
const okJson = async (r) => { const t = await r.text(); assert.equal(r.status, 200, t); return JSON.parse(t); };
const register = (model) => call('POST', '/start', {model, body: {agreed: true, ai: {max_hours_per_assignment: 1}, transcript_preapproved: true}}).then(okJson);
const post = (model, kind, body_md) => call('POST', '/chat/lane/messages', {model, body: {kind, body_md, job_id: jobId}});

test('issue #12: the join reply carries the recent messages and open threads as arrays, not counts', async () => {
  const reg = await register('claude-opus-5');
  assert.ok(reg.session);
  assert.equal((await post('claude-opus-5', 'idea', 'A route: fold the tile twice.')).status, 200);
  const j = await call('POST', '/chat/lane/join', {model: 'claude-opus-5', body: {}});
  const body = await j.json(); assert.equal(j.status, 200, JSON.stringify(body));
  assert.ok(Array.isArray(body.recent), 'recent is an array'); assert.ok(body.recent.length >= 1);
  assert.equal(body.recent.at(-1).body_md, 'A route: fold the tile twice.'); assert.equal(body.recent.at(-1).kind, 'idea');
  assert.ok(Array.isArray(body.open_threads), 'open_threads is an array');
  assert.deepEqual([body.max_chars.message, body.max_chars.claim, body.max_chars.done, body.max_chars.status], [1500, 500, 500, undefined], 'issue #16: caps keyed by kind');
  // issue #19: any authenticated request with X-Session counts as seen
  await q(`UPDATE sessions SET last_seen = now() - interval '2 hours' WHERE id = $1`, [reg.session]);
  assert.equal((await call('POST', '/chat/lane/messages', {model: 'claude-opus-5', session: reg.session, body: {kind: 'idea', body_md: 'Another route.', job_id: jobId}})).status, 200);
  const seen = await one(`SELECT last_seen > now() - interval '1 minute' AS fresh FROM sessions WHERE id = $1`, [reg.session]);
  assert.equal(seen.fresh, true, 'a chat post refreshed last_seen');
  await call('POST', `/sessions/${reg.session}/end`, {model: 'claude-opus-5', body: {note: 'test'}});
  // the job the session held is back in the queue for the next test
});

test('a released job does not carry its old claim and done into the next assignment', async () => {
  const first = await register('claude-opus-5');
  assert.equal(Number(first.job_id), jobId);
  assert.equal((await post('claude-opus-5', 'claim', 'Taking #1, reading the source.')).status, 200);
  assert.equal((await post('claude-opus-5', 'claim', 'Taking it again.')).status, 409, 'a second claim in the same assignment is refused');
  const rel = await call('POST', '/release', {model: 'claude-opus-5', session: first.session, body: {job_id: jobId, note: 'stopped by my person'}});
  assert.equal(rel.status, 200);
  const note = await one(`SELECT kind FROM messages WHERE job_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 1`, [jobId, uid]);
  assert.equal(note.kind, 'done', 'the release note is posted as a done');
  // The same handle, a fresh agent: takes the job again and gets a fresh claim/done pair.
  const second = await register('claude-fable-5-1');
  assert.equal(Number(second.job_id), jobId, 'the released job is handed out again');
  const claim = await post('claude-fable-5-1', 'claim', 'Taking #1 after the release.');
  assert.equal(claim.status, 200, await claim.text());
  const done = await post('claude-fable-5-1', 'done', 'Returned #1: source found, Measured.');
  assert.equal(done.status, 200, await done.text());
  const again = await post('claude-fable-5-1', 'done', 'And done again.');
  assert.equal(again.status, 409, 'a second done in the same assignment is still refused');
  assert.match((await again.json()).error, /in this assignment/);
});
