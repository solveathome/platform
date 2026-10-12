import assert from 'node:assert/strict';
import {before, beforeEach, after, afterEach, test} from 'node:test';
import express from 'express';
import {randomUUID} from 'node:crypto';

// /ready and /start apply one rule (Oct 12 2026, #sah-ready-start-review-mismatch). Compute starts a worker when /ready counts work
// for its token, model and thinking level; /ready counted four Lean reviews needing 8 GB of disk that /start then refused the 5 GB
// worker it started, three times, and the source lost trust for it. Each case asks both and checks they agree. A session sent to
// another project's URL is named, not reported unknown. Every row is deleted at the end.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = 'http://localhost:0';
delete process.env.REVIEW_TRIAGE_MIN_TIER;
const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job} = await import('../src/routes/job.ts');
const reputation = await import('../src/lib/reputation.ts');
let server, author, reviewer, tokens = {}, pids = [], slug, base;
const tag = `agree-${Date.now().toString(36)}`;

before(async () => {
  await migrate();
  for (const [name, handle] of [['author', tag], ['reviewer', tag + '-rv']]) {
    const id = Number((await one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), handle, TERMS_VERSION])).id);
    tokens[name] = await issueToken(id);
    if (name === 'author') author = id; else reviewer = id;
    await reputation.ensure(id);
  }
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job);
  app.use((error, req, res, next) => res.status(500).json({error: error.message}));
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
});
async function newProject() {
  const s = tag + '-' + randomUUID().slice(0, 8);
  const pid = Number((await one(`INSERT INTO problems (slug,name,repo_url,status_md,discovery_share) VALUES ($1,'Agreement test','https://example.org/r','open',0) RETURNING id`, [s])).id);
  await q(`INSERT INTO channels (problem_id,path,title) VALUES ($1,'','Project')`, [pid]);
  await q(`INSERT INTO lanes (problem_id,slug,title) VALUES ($1,'main','Main')`, [pid]);
  await q(`INSERT INTO project_roles (problem_id,user_id,role,granted_by,note) VALUES ($1,$2,'trusted',$2,'test')`, [pid, reviewer]);
  pids.push(pid);
  return {slug: s, pid};
}
beforeEach(async () => { ({slug} = await newProject()); base = p => `http://127.0.0.1:${server.address().port}/projects/${p}`; });
afterEach(async () => {
  for (const pid of pids) {
    await q(`DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE problem_id=$1)`, [pid]);
    await q(`DELETE FROM channel_members WHERE channel_id IN (SELECT id FROM channels WHERE problem_id=$1)`, [pid]);
    await q(`DELETE FROM credits WHERE problem_id=$1`, [pid]);
    await q(`DELETE FROM triages WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`, [pid]);
    await q(`DELETE FROM reviews WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`, [pid]);
    await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`, [pid]);
    await q(`UPDATE returns SET job_id=NULL WHERE problem_id=$1`, [pid]);
    await q(`DELETE FROM assignment_attempts WHERE problem_id=$1`, [pid]);
    await q(`DELETE FROM jobs WHERE problem_id=$1`, [pid]);
    await q(`DELETE FROM returns WHERE problem_id=$1`, [pid]);
    for (const table of ['project_roles', 'sessions', 'pool', 'channels', 'lanes']) await q(`DELETE FROM ${table} WHERE problem_id=$1`, [pid]);
    await q(`DELETE FROM problems WHERE id=$1`, [pid]);
  }
  pids = [];
});
after(async () => {
  await new Promise(r => server.close(r));
  await q(`DELETE FROM counted_entries WHERE user_id = ANY($1)`, [[author, reviewer]]);
  for (const table of ['tokens', 'reputation']) await q(`DELETE FROM ${table} WHERE user_id=ANY($1)`, [[author, reviewer]]);
  await q(`DELETE FROM users WHERE id=ANY($1)`, [[author, reviewer]]);
  await pool.end();
});
async function call(path, {method = 'GET', project = slug, session, attempt, model = 'claude-opus-5-5', effort = 'high', body, who = tokens.reviewer, launch} = {}) {
  const h = {authorization: `Bearer ${who}`, accept: 'application/json', 'content-type': 'application/json'};
  if (model) h['x-model'] = model; if (effort) h['x-effort'] = effort; if (session) h['x-session'] = session;
  if (attempt) h['x-attempt'] = attempt; if (launch) h['x-launch-id'] = launch;
  const res = await fetch(base(project) + path, {method, headers: h, body: body ? JSON.stringify(body) : undefined});
  return {status: res.status, body: await res.json()};
}
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 1500)); return r.body; };
const start = (query = 'work=reviews', project = slug) => call(`/start?time=1task&${query}`, {launch: randomUUID(), project}).then(ok);
const ready = (work = 'reviews', project = slug) => call(`/ready${work ? `?work=${work}` : ''}`, {project}).then(ok);
const release = a => call('/release', {method: 'POST', session: a.session, attempt: a.attempt_id, body: {job_id: a.job_id, note: 'test complete'}});
const endSession = id => call(`/sessions/${id}/end`, {method: 'POST', session: id, body: {note: 'test'}});
/** A return by another model that asks for review: its review jobs are what a trusted Opus reviewer may take. */
async function reviewWaiting() {
  const r = ok(await call('/result', {method: 'POST', who: tokens.author, model: 'deepseek-v4-flash', effort: 'max', body: {type: 'direction', report_md: 'A bounded finding with a claim somebody could build on: the gap statistic is exactly 3 at every fold to 41#.', transcript: 't', transcript_approved: true, author_rung: 'measured', request_review: true}}));
  const jobs = await q(`SELECT id FROM jobs WHERE parent_return_id=$1 AND type='review' AND status='queued'`, [r.return_id]);
  assert.ok(jobs.length > 0, JSON.stringify(r).slice(0, 800));
  return {returnId: r.return_id, jobs: jobs.map(j => Number(j.id))};
}

test('reviews: /ready counts a review exactly when /start hands it out, the compute it needs included', async () => {
  const {jobs} = await reviewWaiting();
  // Fits a fresh session: both see it.
  assert.ok((await ready()).reviews > 0);
  const a = await start();
  assert.equal(a.type, 'review', JSON.stringify(a).slice(0, 800));
  assert.equal((await release(a)).status, 200);
  await endSession(a.session);
  // Needs more disk than a fresh session offers (the Lean reviews of Oct 12): neither counts it.
  await q(`UPDATE jobs SET compute_hint='{"disk_gb": 8, "cpu_hours": 1}'::jsonb WHERE id = ANY($1)`, [jobs]);
  const r = await ready();
  const b = await start();
  assert.equal(b.state, 'no_review_waiting', JSON.stringify(b).slice(0, 800));
  assert.equal(r.reviews, 0, `/ready counted ${r.reviews} reviews that /start refused`);
  assert.equal(r.ready, 0);
  await endSession(b.session);
  // A worker that offers the disk: /ready reads its latest session's offer, as /start does, and both agree again.
  const c = await start('work=reviews&share=75&disk=10');
  assert.equal(c.type, 'review', JSON.stringify(c).slice(0, 800));
  assert.equal((await release(c)).status, 200);
  await endSession(c.session);
  assert.ok((await ready()).reviews > 0, 'the latest session offers 10 GB: the review fits');
});

test('normal work: with nothing queued /ready counts the assignment /start makes on request', async () => {
  const r = await ready('');
  assert.equal(r.research + r.reviews, 0);
  assert.equal(r.made_on_request, 1);
  assert.equal(r.ready, 1);
  const a = await start('share=0');
  assert.ok(a.job_id, JSON.stringify(a).slice(0, 800));
  assert.equal((await release(a)).status, 200);
  await endSession(a.session);
});

test('a session sent to another project is named, not reported unknown, and nothing is recorded', async () => {
  const {jobs} = await reviewWaiting();
  const a = await start();
  assert.ok(jobs.includes(Number(a.job_id)));
  const other = await newProject();
  const r = await call('/release', {method: 'POST', project: other.slug, session: a.session, attempt: a.attempt_id, body: {job_id: a.job_id, note: 'wrong project'}});
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'session_project_mismatch');
  assert.equal(r.body.session_project, slug);
  assert.match(r.body.url, new RegExp(`/projects/${slug}/release$`));
  assert.equal((await one(`SELECT status FROM jobs WHERE id=$1`, [a.job_id])).status, 'assigned', 'still held: nothing was recorded');
  assert.equal((await call('/release', {method: 'POST', project: other.slug, session: 'no-such-session', body: {job_id: a.job_id}})).status, 403);
  assert.equal((await release(a)).status, 200);
  await endSession(a.session);
});
