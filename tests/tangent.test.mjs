import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';

// A person's tangent is their agent's first assignment. Real Postgres (TEST_DATABASE_URL); everything created is deleted and a residue check fails the run otherwise.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the tangent tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job} = await import('../src/routes/job.ts');
const {challengesFor} = await import('../src/lib/tangent.ts');

const tag = `tangent-test-${Date.now().toString(36)}`;
const slug = tag, handle = `${tag}-person`;
let server, base, uid, pid, token, targetReturn, otherId;

before(async () => {
  await migrate();
  const u = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [910_000_000 + Math.floor(Math.random() * 1e8), handle, TERMS_VERSION]);
  uid = Number(u.id);
  token = await issueToken(uid, 'tangent-test');
  const p = await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,$2,'https://example.org/r','open') RETURNING id`, [slug, 'Tangent test']);
  pid = Number(p.id);
  await one(`INSERT INTO lanes (problem_id, slug, title) VALUES ($1,'lane','Lane') RETURNING id`, [pid]);
  await one(`INSERT INTO channels (problem_id, path, title) VALUES ($1,'','Project') RETURNING id`, [pid]);
  // Something to object to: an accepted return by someone else (a person cannot challenge their own return).
  const other = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [911_000_000 + Math.floor(Math.random() * 1e8), `${tag}-other`, TERMS_VERSION]);
  otherId = Number(other.id);
  const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, final_rung) VALUES ($1,'source',$2,'m','p','claims page 12','t','accepted','measured') RETURNING id`, [pid, otherId]);
  targetReturn = Number(r.id);
  // A queued job, to prove the tangent outranks it.
  await q(`INSERT INTO jobs (problem_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status) VALUES ($1,'source','Queued source','find the page','main','{}',1,99,1,'queued')`, [pid]);
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job);
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/projects/${slug}`;
});

after(async () => {
  server?.close();
  await q(`DELETE FROM messages WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM channel_members WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1 AND parent_return_id IS NOT NULL`, [pid]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM reviews WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM sessions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM pool WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM lanes WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM tokens WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM reputation WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM reputation WHERE user_id = $1`, [otherId]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [[uid, otherId]]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE handle LIKE $1) + (SELECT count(*) FROM problems WHERE slug = $2) + (SELECT count(*) FROM returns WHERE user_id = $3) AS n`, [`${tag}%`, slug, uid]);
  await pool.end();
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const call = (method, path, {model, session, body} = {}) => fetch(base + path, {
  method, headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', ...(model ? {'x-model': model} : {}), ...(session ? {'x-session': session} : {})},
  body: body ? JSON.stringify(body) : undefined,
});
const okJson = async (r) => { const t = await r.text(); assert.equal(r.status, 200, t); return JSON.parse(t); };
const words = 'Lemma 3 of the source note assumes the window is symmetric; it is not for odd residues, so the bound on page 12 does not follow.';

let reg;
test('a session registered with a challenge gets the challenge as its first assignment, not the queue', async () => {
  reg = await okJson(await call('POST', '/start', {model: 'claude-opus-5', body: {agreed: true, ai: {max_hours_per_assignment: 1}, transcript_preapproved: true,
    input: {tangent: {kind: 'challenge', about: `return #${targetReturn}`, says: words}}}}));
  assert.equal(reg.type, 'challenge');
  const j = await one(`SELECT type, title, brief_md, assigned_session FROM jobs WHERE id = $1`, [reg.job_id]);
  assert.equal(j.type, 'challenge');
  assert.equal(j.assigned_session, reg.session);
  assert.match(j.brief_md, new RegExp(words.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(j.brief_md, new RegExp(`"ref":"${targetReturn}"`));
  const queued = await one(`SELECT status FROM jobs WHERE problem_id = $1 AND title = 'Queued source'`, [pid]);
  assert.equal(queued.status, 'queued', 'the queue was not touched');
});

test('the challenge return carries the target, the finding and the words, and shows on the target', async () => {
  const bad = await call('POST', '/result', {model: 'claude-opus-5', session: reg.session, body: {job_id: reg.job_id, report_md: 'x', transcript: 't', transcript_approved: true, human_md: words, finding: 'holds'}});
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /needs target/);
  const res = await okJson(await call('POST', '/result', {model: 'claude-opus-5', session: reg.session, body: {job_id: reg.job_id, report_md: 'The window is asymmetric for odd residues; counterexample at n = 7. The bound fails as stated; a weaker bound survives.', transcript: 't', transcript_approved: true,
    target: {kind: 'return', ref: String(targetReturn)}, human_md: words, finding: 'partial'}}));
  const r = await one(`SELECT type, target, finding, human_md, status FROM returns WHERE id = $1`, [res.return_id]);
  assert.equal(r.type, 'challenge'); assert.equal(r.finding, 'partial'); assert.equal(r.human_md, words);
  assert.deepEqual(r.target, {kind: 'return', ref: String(targetReturn)});
  const listed = await challengesFor(pid, 'return', String(targetReturn));
  assert.equal(listed.length, 1); assert.equal(listed[0].id, res.return_id); assert.equal(listed[0].status, 'pending');
  // After the tangent, the queue.
  const next = await okJson(await call('GET', '/start', {model: 'claude-opus-5', session: reg.session}));
  assert.equal(next.type, 'source');
});

test('a challenge can be self-assigned mid-session, and refuses a bad finding or a missing target', async () => {
  const noTarget = await call('POST', '/result', {model: 'claude-opus-5', session: reg.session, body: {type: 'challenge', report_md: 'x', transcript: 't', transcript_approved: true, finding: 'holds'}});
  assert.equal(noTarget.status, 400);
  const badFinding = await call('POST', '/result', {model: 'claude-opus-5', session: reg.session, body: {type: 'challenge', report_md: 'x', transcript: 't', transcript_approved: true, target: {kind: 'claim', ref: 'the bound on page 12'}, finding: 'maybe'}});
  assert.equal(badFinding.status, 400);
  assert.match((await badFinding.json()).error, /finding must be/);
  const ok = await okJson(await call('POST', '/result', {model: 'claude-opus-5', session: reg.session, body: {type: 'challenge', report_md: 'The claim as worded is fine; my person misread the quantifier.', transcript: 't', transcript_approved: true, target: {kind: 'claim', ref: 'the bound on page 12'}, human_md: 'The bound on page 12 is wrong.', finding: 'does-not-hold'}}));
  const r = await one(`SELECT finding, target->>'kind' AS kind FROM returns WHERE id = $1`, [ok.return_id]);
  assert.equal(r.finding, 'does-not-hold'); assert.equal(r.kind, 'claim');
});

test('a direction tangent is a direction job with the words in the brief', async () => {
  const d = await okJson(await call('POST', '/start', {model: 'claude-fable-5-1', body: {agreed: true, input: {tangent: {kind: 'direction', says: 'Try the two-class window variance with a moving cutoff.'}}}}));
  assert.equal(d.type, 'direction');
  const j = await one(`SELECT brief_md FROM jobs WHERE id = $1`, [d.job_id]);
  assert.match(j.brief_md, /moving cutoff/);
  assert.match(j.brief_md, /refuted registry/);
});
