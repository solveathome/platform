import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';

// Tier 1 alternates (Chris, Sep 11 2026): with reviews and papers both queued, a frontier session's first assignment is a review,
// the next prefers research, the one after that verification again. Frontier agents are not a review pool.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the queue tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job} = await import('../src/routes/job.ts');

const tag = `alt-test-${Date.now().toString(36)}`;
let server, base, uid, author, pid, token;

before(async () => {
  await migrate();
  uid = Number((await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), `${tag}-fable`, TERMS_VERSION])).id);
  author = Number((await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), `${tag}-author`, TERMS_VERSION])).id);
  token = await issueToken(uid, 'alt-test');
  pid = Number((await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,$2,'https://example.org/r','open') RETURNING id`, [tag, 'Alternation test'])).id);
  await one(`INSERT INTO channels (problem_id, path, title) VALUES ($1,'','Project') RETURNING id`, [pid]);
  await q(`INSERT INTO project_roles (problem_id, user_id, role, note) VALUES ($1,$2,'trusted','test')`, [pid, uid]);   // review assignments go to trusted handles only
  // Two returns by an Opus author (a Fable reviewer may review them), a review job on each, and two paper jobs.
  for (const n of [1, 2]) {
    const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'source',$2,'claude-opus-5','anthropic','Found it.','t','pending') RETURNING id`, [pid, author]);
    await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status, parent_return_id) VALUES ($1,NULL,'review',$2,'Review it.','main','{}',1,1,1,'queued',$3)`, [pid, `Review return #${r.id}`, r.id]);
    await q(`INSERT INTO papers (problem_id, slug, title, path, kind, status, grade, summary) VALUES ($1,$2,$3,$4,'proposal','proposed',NULL,'A proposal.')`, [pid, `p${n}`, `Paper ${n}`, `paper/proposals/prop-p${n}.md`]);
    await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status) VALUES ($1,NULL,'paper',$2,$3,'main','{}',3,1,1,'queued')`, [pid, `Paper: write p${n}`, `paper.slug: p${n}`]);
  }
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/projects/${tag}`;
});
after(async () => {
  server?.close();
  await q(`DELETE FROM messages WHERE user_id = ANY($1)`, [[uid, author]]);
  await q(`DELETE FROM channel_members WHERE user_id = ANY($1)`, [[uid, author]]);
  await q(`DELETE FROM credits WHERE user_id = ANY($1)`, [[uid, author]]);
  await q(`DELETE FROM reviews WHERE user_id = ANY($1)`, [[uid, author]]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM project_roles WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM papers WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM sessions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM pool WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM tokens WHERE user_id = ANY($1)`, [[uid, author]]);
  await q(`DELETE FROM reputation WHERE user_id = ANY($1)`, [[uid, author]]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [[uid, author]]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE id = ANY($1)) + (SELECT count(*) FROM problems WHERE id = $2) + (SELECT count(*) FROM jobs WHERE problem_id = $2) AS n`, [[uid, author], pid]);
  await pool.end();
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const call = (method, path, {session, body} = {}) => fetch(base + path, {method, headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', 'x-model': 'claude-fable-5-1', 'x-effort': 'max', ...(session ? {'x-session': session} : {})}, body: body ? JSON.stringify(body) : undefined});
const okJson = async (r) => { const t = await r.text(); assert.equal(r.status, 200, t); return JSON.parse(t); };

test('a frontier session alternates: review, then research, then review again', async () => {
  const s = await okJson(await call('POST', '/start', {body: {agreed: true, ai: {max_assignments: 3}, transcript_preapproved: true}}));
  assert.equal(s.type, 'review', 'a fresh session starts with verification');
  await okJson(await call('POST', '/result', {session: s.session, body: {job_id: s.job_id, verdict: 'accept', rung: 'measured', notes_md: 'Checked the page.', transcript: 't', transcript_approved: true, verification: 'read'}}));
  const n2 = await okJson(await call('GET', '/start', {session: s.session}));
  assert.equal(n2.type, 'paper', 'after a review the queue prefers research although a review is still queued');
  await call('POST', '/release', {session: s.session, body: {job_id: n2.job_id, note: 'test'}});
  const n3 = await okJson(await call('GET', '/start', {session: s.session}));
  assert.equal(n3.type, 'review', 'after research, verification comes first again');
});

test('the run of reviews follows the backlog: many reviews and little research means several verifications before a research turn', async () => {
  // Six more Opus returns with a review job each; the queue now holds far more reviews than papers for a Fable session.
  for (let n = 0; n < 6; n++) {
    const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'source',$2,'claude-opus-5','anthropic','Found it.','t','pending') RETURNING id`, [pid, author]);
    await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status, parent_return_id) VALUES ($1,NULL,'review',$2,'Review it.','main','{}',1,1,1,'queued',$3)`, [pid, `Review return #${r.id}`, r.id]);
  }
  const reviews = Number((await one(`SELECT count(*) AS c FROM jobs WHERE problem_id = $1 AND status = 'queued' AND type = 'review'`, [pid])).c);
  const research = Number((await one(`SELECT count(*) AS c FROM jobs WHERE problem_id = $1 AND status = 'queued' AND type <> 'review'`, [pid])).c);
  const run = Math.min(4, Math.max(1, Math.ceil(reviews / Math.max(1, research))));
  assert.ok(run >= 2, `fixture should make a run of at least 2 (reviews ${reviews}, research ${research})`);
  await q(`UPDATE sessions SET review_streak = 0 WHERE user_id = $1`, [uid]);   // the streak carries across a handle's sessions (issue #41); start this one from zero
  const s = await okJson(await call('POST', '/start', {body: {agreed: true, ai: {max_assignments: 8}, transcript_preapproved: true}}));
  const types = [s.type]; let job = s.job_id;
  for (let i = 0; i < run; i++) {
    await okJson(await call('POST', '/release', {session: s.session, body: {job_id: job, note: 'test'}}));
    const n = await okJson(await call('GET', '/start', {session: s.session}));
    types.push(n.type); job = n.job_id;
  }
  await call('POST', '/release', {session: s.session, body: {job_id: job, note: 'test'}});
  assert.deepEqual(types.slice(0, run), Array(run).fill('review'), `expected ${run} reviews first, got ${types.join(', ')}`);
  assert.notEqual(types[run], 'review', `after ${run} reviews the next should be research, got ${types.join(', ')}`);
});
