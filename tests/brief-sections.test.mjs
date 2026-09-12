import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';

// Issues #13–#15 (Sep 11 2026): the reviews-waiting section appears once; the registration block names model, thinking level and
// tier; the queue line counts only what the reader could take and says how many reviews wait for another model.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the brief section tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job} = await import('../src/routes/job.ts');

const tag = `sect-test-${Date.now().toString(36)}`;
let server, base, uid, pid, token;

before(async () => {
  await migrate();
  uid = Number((await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), `${tag}-fable`, TERMS_VERSION])).id);
  token = await issueToken(uid, 'sect-test');
  pid = Number((await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,$2,'https://example.org/r','open') RETURNING id`, [tag, 'Sections test'])).id);
  await one(`INSERT INTO channels (problem_id, path, title) VALUES ($1,'','Project') RETURNING id`, [pid]);
  await q(`INSERT INTO project_roles (problem_id, user_id, role, note) VALUES ($1,$2,'trusted','test')`, [pid, uid]);
  // Two of this handle's own Fable returns with review jobs queued: barred for Fable (own kind), and one paper job it can take.
  for (const n of [1, 2]) {
    const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'audit',$2,'claude-fable-5-1','anthropic','Audit.','t','pending') RETURNING id`, [pid, uid]);
    await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status, parent_return_id) VALUES ($1,NULL,'review',$2,'Review it.','main','{}',1,1,1,'queued',$3)`, [pid, `Review return #${r.id}`, r.id]);
  }
  await q(`INSERT INTO papers (problem_id, slug, title, path, kind, status, grade, summary) VALUES ($1,'tc','Tailcount','paper/proposals/prop-tc.md','proposal','proposed',NULL,'A proposal.')`, [pid]);
  await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status) VALUES ($1,NULL,'paper','Paper: write tc','paper.slug: tc','main','{}',3,1,1,'queued')`, [pid]);
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/projects/${tag}`;
});
after(async () => {
  server?.close();
  await q(`DELETE FROM messages WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM channel_members WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM project_roles WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM papers WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM sessions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM pool WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM tokens WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM reputation WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM users WHERE id = $1`, [uid]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE id = $1) + (SELECT count(*) FROM problems WHERE id = $2) + (SELECT count(*) FROM jobs WHERE problem_id = $2) AS n`, [uid, pid]);
  await pool.end();
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const call = (method, path, {session, body, effort = 'max'} = {}) => fetch(base + path, {method, headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', 'x-model': 'claude-fable-5-1', ...(effort ? {'x-effort': effort} : {}), ...(session ? {'x-session': session} : {})}, body: body ? JSON.stringify(body) : undefined});

test('#15: the registration reply counts only reviews the reader could take and names the rest', async () => {
  const r = await call('GET', '/start');   // a bare GET with a model registers (Sep 12); the reply carries the per-model queue line
  const body = await r.json(); assert.equal(r.status, 200, JSON.stringify(body).slice(0, 300));
  assert.match(body.brief_md, /Queue right now for claude-fable-5-1: (paper 1|empty)\./);
  assert.match(body.brief_md, /A further 2 review job\(s\) wait for a reviewer on another model/);
  await call('POST', `/sessions/${body.session}/end`, {body: {note: 'test'}});
});

test('#14 and #13: the registration block names the tier; the reviews-waiting section appears once', async () => {
  const r = await call('POST', '/start', {body: {agreed: true, ai: {max_assignments: 1}, transcript_preapproved: true}});
  const s = await r.json(); assert.equal(r.status, 200, JSON.stringify(s).slice(0, 300));
  assert.equal(s.type, 'paper');
  assert.match(s.brief_md, /Model `claude-fable-5-1`, thinking level `max`: \*\*tier 1\*\* this session\./);
  const headings = s.brief_md.match(/## Reviews waiting for your person's other agents/g) ?? [];
  assert.equal(headings.length, 1, `heading count ${headings.length}`);
  assert.match(s.brief_md, /2 review job\(s\) of this handle's own returns are queued and cannot go to claude-fable-5-1/);
  const low = await call('POST', '/start', {body: {agreed: true, ai: {max_assignments: 1}}, effort: 'low', session: s.session});
  const l = await low.json(); assert.equal(low.status, 200, JSON.stringify(l).slice(0, 300));
  assert.match(l.brief_md, /thinking level `low`: \*\*tier 2\*\* this session \(thinking level "low" on record: tier 2/);
});
