import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import express from 'express';

// Review briefs are stored at intake. Two things are read from the record when the brief is served (issues #39 and #53):
// the bound-script paragraph is corrected for a documents-only patch, and the return's duplicates are named.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the review brief tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';
const tmp = mkdtempSync(join(tmpdir(), 'sah-rbs-')); process.env.FILES_DIR = join(tmp, 'files'); process.env.OVERLAY_DIR = join(tmp, 'overlay'); process.env.DOCS_DIR = join(tmp, 'repos');

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const roles = await import('../src/lib/roles.ts');
const {job} = await import('../src/routes/job.ts');

const tag = `rbs-test-${Date.now().toString(36)}`;
const slug = tag;
let server, base, pid, reviewer, author, token, parentId, dupId, reviewJobId;
const STALE = 'This return carries a patch against served scripts. Apply it to a copy of the served file and read the diff before judging. Run `node research/qc/embed.js --check <patched file>`.';
const DOC_PATCH = '--- a/research/history/staging/note.md\n+++ b/research/history/staging/note.md\n@@ -1 +1 @@\n-old\n+new\n';

before(async () => {
  await migrate();
  const mk = async (h) => Number((await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), h, TERMS_VERSION])).id);
  reviewer = await mk(`${tag}-reviewer`); author = await mk(`${tag}-author`);
  token = await issueToken(reviewer, 'rbs-test');
  pid = Number((await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,$2,'https://example.org/r','open') RETURNING id`, [slug, 'Review brief test'])).id);
  await one(`INSERT INTO channels (problem_id, path, title) VALUES ($1,'','Project') RETURNING id`, [pid]);
  await roles.grant(pid, reviewer, 'trusted', null, 'test');
  const ins = (dupOf) => one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, patch, duplicate_of) VALUES ($1,'audit',$2,'claude-opus-5','anthropic','Audit.','t','pending',$3,$4) RETURNING id`, [pid, author, DOC_PATCH, dupOf]);
  parentId = Number((await ins(null)).id);
  dupId = Number((await ins(parentId)).id);
  const j = await one(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status, parent_return_id) VALUES ($1,NULL,'review',$2,$3,'main','{}',1,1,1,'queued',$4) RETURNING id`, [pid, `Review return #${parentId}`, `Review return #${parentId}. Read it.\n\n${STALE}\n\nBudget 1 h.`, parentId]);
  reviewJobId = Number(j.id);
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/projects/${slug}`;
});
after(async () => {
  server?.close();
  const ids = [reviewer, author];
  await q(`DELETE FROM messages WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM channel_members WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM credits WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM sessions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM pool WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM project_roles WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM tokens WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM reputation WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE id = ANY($1)) + (SELECT count(*) FROM problems WHERE id = $2) + (SELECT count(*) FROM returns WHERE problem_id = $2) + (SELECT count(*) FROM jobs WHERE problem_id = $2) AS n`, [ids, pid]);
  await pool.end(); rmSync(tmp, {recursive: true, force: true});
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const call = (method, path, {session, body} = {}) => fetch(base + path, {method, headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', 'x-model': 'claude-fable-5-1', 'x-effort': 'max', ...(session ? {'x-session': session} : {})}, body: body ? JSON.stringify(body) : undefined});

test('issue #39: a stale bound-script paragraph is corrected at serve time for a documents-only patch; issue #53: the brief names the duplicates', async () => {
  const reg = await call('POST', '/start', {body: {agreed: true, ai: {max_assignments: 1}, transcript_preapproved: true}});
  const s = await reg.json(); assert.equal(reg.status, 200, JSON.stringify(s).slice(0, 400));
  assert.equal(Number(s.job_id), reviewJobId, JSON.stringify(s).slice(0, 400));
  assert.doesNotMatch(s.brief_md, /patch against served scripts/);
  assert.doesNotMatch(s.brief_md, /embed\.js --check/);
  assert.match(s.brief_md, /touches served documents only, no scripts/);
  assert.match(s.brief_md, /## Duplicates of the return under review/);
  assert.match(s.brief_md, new RegExp(`Return #${dupId} \\(audit by @${tag}-author, [^)]*/return/${dupId}\\) carries the same change`));
  assert.match(s.brief_md, new RegExp(`will be folded into #${parentId} when this one is accepted`));
  await call('POST', `/sessions/${s.session}/end`, {body: {note: 'test'}});
});

test('a review brief with no duplicates and a script patch keeps its paragraph and gets no duplicates section', async () => {
  await q(`UPDATE jobs SET status = 'returned' WHERE id = $1`, [reviewJobId]);   // ending the session put the first job back in the queue; take it out of the way
  const scriptPatch = '--- a/research/qc/embed.js\n+++ b/research/qc/embed.js\n@@ -1 +1 @@\n-a\n+b\n';
  const p2 = Number((await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, patch) VALUES ($1,'break',$2,'claude-opus-5','anthropic','Break.','t','pending',$3) RETURNING id`, [pid, author, scriptPatch])).id);
  await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status, parent_return_id) VALUES ($1,NULL,'review',$2,$3,'main','{}',1,1,1,'queued',$4)`, [pid, `Review return #${p2}`, `Review return #${p2}.\n\n${STALE}\n\nBudget 1 h.`, p2]);
  const reg = await call('POST', '/start', {body: {agreed: true, ai: {max_assignments: 1}, transcript_preapproved: true}});
  const s = await reg.json(); assert.equal(reg.status, 200, JSON.stringify(s).slice(0, 400));
  assert.match(s.brief_md, /patch against served scripts/);
  assert.doesNotMatch(s.brief_md, /## Duplicates of the return under review/);
  await call('POST', `/sessions/${s.session}/end`, {body: {note: 'test'}});
});
