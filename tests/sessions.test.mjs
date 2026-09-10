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
  for (const n of [1, 2, 3]) {
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
