import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';

// One handle, several agents at once: each POST /start opens its own session; sessions hold their own assignments and never
// see each other's. Runs against a real Postgres (TEST_DATABASE_URL); every row it creates is deleted at the end and a residue
// check fails the run if anything is left behind.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the session tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job} = await import('../src/routes/job.ts');

const tag = `sess-test-${Date.now().toString(36)}`;
const slug = tag, handle = `${tag}-person`;
let server, base, uid, pid, token, laneId;
const ids = {jobs: [], channels: []};

before(async () => {
  await migrate();
  const u = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), handle, TERMS_VERSION]);
  uid = Number(u.id);
  token = await issueToken(uid, 'sessions-test');
  const p = await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,$2,'https://example.org/r','open') RETURNING id`, [slug, 'Sessions test']);
  pid = Number(p.id);
  const l = await one(`INSERT INTO lanes (problem_id, slug, title) VALUES ($1,'lane','Lane') RETURNING id`, [pid]);
  laneId = Number(l.id);
  const c = await one(`INSERT INTO channels (problem_id, path, title) VALUES ($1,'','Project') RETURNING id`, [pid]);
  ids.channels.push(Number(c.id));
  for (const n of [1, 2, 3, 4, 5]) {
    const j = await one(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status)
                         VALUES ($1,$2,'source',$3,'find the page','main','{}',1,99,1,'queued') RETURNING id`, [pid, laneId, `Source ${n}`]);
    ids.jobs.push(Number(j.id));
  }
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job);
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/projects/${slug}`;
});

after(async () => {
  server?.close();
  // Delete what the test created, children first; then prove nothing is left.
  await q(`DELETE FROM messages WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM credits WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM reviews WHERE user_id = $1`, [uid]);
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
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE handle = $1) + (SELECT count(*) FROM problems WHERE slug = $1) + (SELECT count(*) FROM sessions WHERE user_id = $2) + (SELECT count(*) FROM jobs WHERE problem_id = $3) AS n`, [handle, uid, pid]);
  await pool.end();
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const call = (method, path, {model, session, body} = {}) => fetch(base + path, {
  method, headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', ...(model ? {'x-model': model} : {}), ...(session ? {'x-session': session} : {})},
  body: body ? JSON.stringify(body) : undefined,
});
const okJson = async (r) => { const t = await r.text(); assert.equal(r.status, 200, t); return JSON.parse(t); };
const register = (model) => call('POST', '/start', {model, body: {agreed: true, ai: {max_hours_per_assignment: 1}, transcript_preapproved: true}}).then(okJson);

let opus, fable;
test('two agents of one person get two sessions and two different assignments', async () => {
  opus = await register('claude-opus-5');
  fable = await register('claude-fable-5-1');
  assert.ok(opus.session && fable.session && opus.session !== fable.session, 'distinct session ids');
  assert.ok(opus.job_id && fable.job_id && opus.job_id !== fable.job_id, 'distinct jobs');
  const rows = await q(`SELECT id, assigned_session, assigned_to FROM jobs WHERE id = ANY($1)`, [[opus.job_id, fable.job_id]]);
  assert.deepEqual(new Set(rows.map(r => r.assigned_session)), new Set([opus.session, fable.session]));
  assert.ok(rows.every(r => Number(r.assigned_to) === uid));
  const first = await one(`SELECT jobs, model FROM sessions WHERE id = $1`, [opus.session]);
  assert.equal(Number(first.jobs), 1); assert.equal(first.model, 'claude-opus-5');
});

test('a session that holds a job is refused another; the sibling session is not', async () => {
  const held = await call('GET', '/start', {model: 'claude-opus-5', session: opus.session});
  assert.equal(held.status, 409);
  assert.equal((await held.json()).job_id, opus.job_id);
  // The third queued job goes to whichever session asks next after releasing: release Fable's, ask again, get a job (not Opus's).
  const rel = await call('POST', '/release', {model: 'claude-fable-5-1', session: fable.session, body: {job_id: fable.job_id, note: 'test'}});
  assert.equal(rel.status, 200);
  const nj = await okJson(await call('GET', '/start', {model: 'claude-fable-5-1', session: fable.session}));
  assert.notEqual(nj.job_id, opus.job_id);
  assert.notEqual(nj.job_id, fable.job_id, 'a session never gets back the job it just released');
  fable.job_id = nj.job_id;
});

test('a session refuses a different model, and a return must come from the session that holds the job', async () => {
  const wrong = await call('GET', '/start', {model: 'gpt-6-astra', session: opus.session});
  assert.equal(wrong.status, 409);
  assert.match((await wrong.json()).error, /registered for model claude-opus-5/);
  const cross = await call('POST', '/result', {model: 'claude-fable-5-1', session: fable.session, body: {job_id: opus.job_id, report_md: 'x', transcript: 'prose', transcript_approved: true}});
  assert.equal(cross.status, 403);
  assert.match((await cross.json()).error, /another of your sessions/);
  const own = await okJson(await call('POST', '/result', {model: 'claude-opus-5', session: opus.session, body: {job_id: opus.job_id, report_md: 'Found it on page 3 of the stated source.', transcript: 'prose transcript', transcript_approved: true}}));
  const ret = await one(`SELECT session FROM returns WHERE id = $1`, [own.return_id]);
  assert.equal(ret.session, opus.session);
});

test('without a live session the agent gets the orientation, not an assignment', async () => {
  const none = await call('GET', '/start', {model: 'claude-opus-5', session: 'not-a-session'});
  assert.equal(none.status, 200);
  const body = await none.json();
  assert.equal(body.session, null); assert.equal(body.registered, true);
  assert.match(body.orientation_md, /Many agents, one handle/);
});

test('release without job_id is a 400, not a 500', async () => {
  const r = await call('POST', '/release', {model: 'claude-opus-5', session: opus.session, body: {}});
  assert.equal(r.status, 400); assert.match((await r.json()).error, /job_id is required/);
});

test('sessions are listed, ended, replaced, and finished ones do not count against the cap', async () => {
  // Fable holds a job: it is live; Opus returned its job and is idle but was seen just now: still live.
  const list = await okJson(await call('GET', '/sessions', {model: 'claude-opus-5'}));
  const f = list.sessions.find(s => s.id === fable.session), o = list.sessions.find(s => s.id === opus.session);
  assert.equal(f.live, true); assert.equal(f.holds.length, 1); assert.equal(Number(f.holds[0].id), Number(fable.job_id));
  assert.equal(o.live, true); assert.equal(o.holds.length, 0);
  // Ending Fable's session hands its job back with a note.
  const end = await okJson(await call('POST', `/sessions/${fable.session}/end`, {model: 'claude-fable-5-1', body: {note: 'person closed the laptop'}}));
  assert.equal(end.status, 'ended');
  const j = await one(`SELECT status, assigned_session, last_release_note FROM jobs WHERE id = $1`, [fable.job_id]);
  assert.equal(j.status, 'queued'); assert.equal(j.assigned_session, null); assert.match(j.last_release_note, /session ended: person closed the laptop/);
  assert.equal((await call('POST', `/sessions/${fable.session}/end`, {model: 'claude-fable-5-1'})).status, 404, 'ending twice is a 404');
  // Idle for over an hour with nothing held: not live. Fill the handle with eight such sessions; registration still works.
  for (let i = 0; i < 8; i++) await q(`INSERT INTO sessions (id, problem_id, user_id, model, last_seen) VALUES ($1,$2,$3,'claude-opus-5', now() - interval '2 hours')`, [`idle-${tag}-${i}`, pid, uid]);
  await q(`UPDATE sessions SET last_seen = now() - interval '2 hours' WHERE id = $1`, [opus.session]);
  const again = await register('claude-fable-5-1');
  assert.ok(again.session, 'registered despite eight idle sessions');
  // A capped session ends with its last return, and replacing it from the registration POST ends it too.
  const capped = await okJson(await call('POST', '/start', {model: 'claude-astra-1', body: {agreed: true, ai: {max_assignments: 1}, transcript_preapproved: true}}));
  assert.ok(capped.job_id);
  await okJson(await call('POST', '/result', {model: 'claude-astra-1', session: capped.session, body: {job_id: capped.job_id, report_md: 'Found it on the stated page.', transcript: 'prose transcript', transcript_approved: true}}));
  const ended = await one(`SELECT ended_at FROM sessions WHERE id = $1`, [capped.session]);
  assert.ok(ended.ended_at, 'the cap reached with the return ends the session');
  const after = await call('GET', '/start', {model: 'claude-astra-1', session: capped.session});
  assert.equal(after.status, 409, 'issue #6: an ended session is told so, not shown the join page');
  const ab = await after.json(); assert.equal(ab.error, 'session cap reached'); assert.match(ab.orientation_md, /the cap is reached/); assert.doesNotMatch(ab.orientation_md, /Settings on record/);
  const replaced = await okJson(await call('POST', '/start', {model: 'claude-fable-5-1', session: again.session, body: {agreed: true, ai: {max_assignments: 1}}}));
  assert.notEqual(replaced.session, again.session);
  const old = await one(`SELECT ended_at FROM sessions WHERE id = $1`, [again.session]);
  assert.ok(old.ended_at, 'X-Session on the registration POST ends the session it replaces');
  fable.session = replaced.session;
});

test('issues #17 and #18: a session inherits nothing from the handle, and the registration reply is the session block plus the brief', async () => {
  const withCompute = await okJson(await call('POST', '/start', {model: 'claude-opus-5', body: {agreed: true, ai: {max_hours_per_assignment: 3, max_assignments: 1}, compute: {share: 0.5, machine: {cores: 8, ram_gb: 16}}, transcript_preapproved: true}}));
  const first = await one(`SELECT ai, compute FROM sessions WHERE id = $1`, [withCompute.session]);
  assert.equal(first.compute.usable.cores, 4);
  await call('POST', `/sessions/${withCompute.session}/end`, {model: 'claude-opus-5', body: {note: 'test'}});
  const bare = await okJson(await call('POST', '/start', {model: 'claude-opus-5', body: {agreed: true, ai: {max_assignments: 1}}}));
  const second = await one(`SELECT ai, compute FROM sessions WHERE id = $1`, [bare.session]);
  assert.equal(second.compute, null, 'compute is not inherited from the last registration');
  assert.equal(Number(second.ai.max_hours_per_assignment), 2, 'AI time is the default, not the last value');
  assert.equal(second.ai.transcript_preapproved, false);
  assert.match(bare.brief_md, /## Registered for this session/);
  assert.doesNotMatch(bare.brief_md, /You are being asked to join the processing pool/, 'the registration reply does not repeat the orientation');
  assert.match(bare.brief_md, /nothing is inherited from the handle's earlier registrations/);
  await call('POST', `/sessions/${bare.session}/end`, {model: 'claude-opus-5', body: {note: 'test'}});
});

test('compute fit: an offered share is the limit, so a 4 GB session never gets an 8 GB job', async () => {
  const heavy = await one(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status) VALUES ($1,$2,'measure','Heavy measure','run it','main','{"ram_gb": 8, "cpu_hours": 1}',1,99,1,'queued') RETURNING id`, [pid, laneId]);
  const small = await okJson(await call('POST', '/start', {model: 'claude-opus-5', body: {agreed: true, ai: {max_assignments: 1}, compute: {share: 0.5, machine: {cores: 8, ram_gb: 8}}, transcript_preapproved: true}}));
  assert.notEqual(Number(small.job_id), Number(heavy.id), 'the 8 GB job did not go to a 4 GB share');
  assert.equal((await one(`SELECT status FROM jobs WHERE id = $1`, [heavy.id])).status, 'queued');
  await call('POST', `/sessions/${small.session}/end`, {model: 'claude-opus-5', body: {note: 'test'}});
  const big = await okJson(await call('POST', '/start', {model: 'claude-opus-5', body: {agreed: true, ai: {max_assignments: 1}, compute: {share: 1, machine: {cores: 8, ram_gb: 16}}, transcript_preapproved: true}}));
  assert.equal(Number(big.job_id), Number(heavy.id), 'a 16 GB share takes it');
  await call('POST', `/sessions/${big.session}/end`, {model: 'claude-opus-5', body: {note: 'test'}});
});
