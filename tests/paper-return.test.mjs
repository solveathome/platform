import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import express from 'express';

// Platform issue #1: a seeded paper slug with an uppercase letter ("exact-fold-L") could not receive a paper return, and each
// refused attempt left an orphan return row. Slugs match case-insensitively and nothing is written before the checks pass.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the paper return tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';
const tmp = mkdtempSync(join(tmpdir(), 'sah-paper-')); process.env.FILES_DIR = join(tmp, 'files'); process.env.OVERLAY_DIR = join(tmp, 'overlay'); process.env.DOCS_DIR = join(tmp, 'repos');

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const files = await import('../src/lib/files.ts');
const {job} = await import('../src/routes/job.ts');

const tag = `paper-test-${Date.now().toString(36)}`;
const slug = tag, handle = `${tag}-person`;
let server, base, uid, pid, token, jobId, sha, auditJobId;

before(async () => {
  await migrate();
  const u = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), handle, TERMS_VERSION]);
  uid = Number(u.id); token = await issueToken(uid, 'paper-test');
  const p = await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,$2,'https://example.org/r','open') RETURNING id`, [slug, 'Paper test']);
  pid = Number(p.id);
  await q(`UPDATE problems SET discovery_share = 0 WHERE id = $1`, [pid]); // isolate this suite from discovery allocation
  await one(`INSERT INTO channels (problem_id, path, title) VALUES ($1,'','Project') RETURNING id`, [pid]);
  await q(`INSERT INTO papers (problem_id, slug, title, path, kind, status, grade, summary) VALUES ($1,'exact-fold-L','Per-fold L','paper/proposals/prop-exact-fold-L.md','proposal','proposed',NULL,'A proposal.')`, [pid]);
  const j = await one(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status) VALUES ($1,NULL,'paper','Paper: write exact-fold-L','paper.slug: exact-fold-L','main','{}',3,1,1,'queued') RETURNING id`, [pid]);
  jobId = Number(j.id);
  sha = (await files.store(uid, 'claude-fable-5-1', 'exact-fold-L.md', 'md', '# Per-fold L\n\nA manuscript.\n')).sha;
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/projects/${slug}`;
});
after(async () => {
  server?.close();
  await q(`DELETE FROM file_refs WHERE file_sha IN (SELECT sha256 FROM files WHERE user_id = $1)`, [uid]);
  await q(`DELETE FROM messages WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM channel_members WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM credits WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM reviews WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM papers WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM sessions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM pool WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM files WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM tokens WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM reputation WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM users WHERE id = $1`, [uid]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE id = $1) + (SELECT count(*) FROM problems WHERE id = $2) + (SELECT count(*) FROM returns WHERE problem_id = $2) + (SELECT count(*) FROM files WHERE user_id = $1) AS n`, [uid, pid]);
  await pool.end(); rmSync(tmp, {recursive: true, force: true});
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const call = (method, path, {session, body} = {}) => fetch(base + path, {method, headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', 'x-model': 'claude-fable-5-1', 'x-effort': 'max', ...(session ? {'x-session': session} : {})}, body: body ? JSON.stringify(body) : undefined});

test('a mixed-case paper slug is matched, and a refused paper return records nothing', async () => {
  const reg = await call('POST', '/start', {body: {agreed: true, ai: {max_assignments: 1}, transcript_preapproved: true}});
  const s = await reg.json(); assert.equal(reg.status, 200, JSON.stringify(s)); assert.equal(Number(s.job_id), jobId);
  const bad = await call('POST', '/result', {session: s.session, body: {job_id: jobId, report_md: 'Return.', transcript: 't', transcript_approved: true, paper: {slug: 'exact-fold-L'}, files: [sha]}});
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /paper\.file must be/);
  assert.equal(Number((await one(`SELECT count(*) AS c FROM returns WHERE job_id = $1`, [jobId])).c), 0, 'no orphan return after a refusal');
  const unknown = await call('POST', '/result', {session: s.session, body: {job_id: jobId, report_md: 'Return.', transcript: 't', transcript_approved: true, paper: {slug: 'no-such-paper', file: sha}, files: [sha]}});
  assert.equal(unknown.status, 400);
  assert.equal(Number((await one(`SELECT count(*) AS c FROM returns WHERE job_id = $1`, [jobId])).c), 0);
  const cited = (await files.store(uid, 'claude-fable-5-1', 'prior.md', 'md', '# Prior return file\n')).sha;
  const stray = 'a'.repeat(64);
  const recipe = `Base: sha256 ${cited} (return #7's file). Output: ${stray}.`;
  const good = await call('POST', '/result', {session: s.session, body: {job_id: jobId, report_md: 'Return for exact-fold-L.', transcript: 't', transcript_approved: true, paper: {slug: 'EXACT-fold-l', file: sha}, files: [sha], cites: {files: [cited]}, recipe_md: recipe}});
  const g = await good.json(); assert.equal(good.status, 200, JSON.stringify(g));
  const r = await one(`SELECT paper_slug, revision_path, revision_sha FROM returns WHERE id = $1`, [g.return_id]);
  assert.equal(r.paper_slug, 'exact-fold-L'); assert.equal(r.revision_path, 'paper/proposals/prop-exact-fold-L.md'); assert.equal(r.revision_sha, sha);
  assert.equal((await one(`SELECT status FROM papers WHERE problem_id = $1`, [pid])).status, 'under_review');
  const shaWarn = g.warnings.filter(w => !/not a session log/.test(w));   // the stub transcript 't' also draws the not-a-session-log warning (Sep 12 2026)
  assert.equal(shaWarn.length, 1, JSON.stringify(g.warnings)); assert.match(shaWarn[0], /names 1 sha256/); assert.doesNotMatch(shaWarn[0], new RegExp(cited.slice(0, 12)), 'issue #7: a cited file is a known input');
  assert.equal(r.paper_slug, 'exact-fold-L');
});

test('issue #9: the rung is one validated ladder; issue #10: a missing return is a JSON 404', async () => {
  const s2 = await (await call('POST', '/start', {body: {agreed: true, ai: {max_assignments: 1}, transcript_preapproved: true}})).json();
  const bad = await call('POST', '/result', {session: s2.session, body: {type: 'direction', report_md: 'A route worth trying.', transcript: 't', transcript_approved: true, author_rung: 'solid'}});
  assert.equal(bad.status, 400); const bb = await bad.json(); assert.match(bb.error, /author_rung must be one of proven \| verified/); assert.deepEqual(bb.allowed, ['proven', 'verified', 'measured', 'heuristic', 'conjectured', 'refuted']);
  const gone = await call('GET', '/return/999999999');
  assert.equal(gone.status, 404); assert.match((await gone.json()).error, /no such return #999999999/);
  await call('POST', `/sessions/${s2.session}/end`, {body: {note: 'test'}});
});

test('issue #8: the pending-revisions block finds a mixed-case paper slug', async () => {
  // A pending audit return on the paper, then an audit job for it: the brief must point at the pending revision.
  const rsha = (await files.store(uid, 'claude-fable-5-1', 'rev.md', 'md', '# Per-fold L\n\nRevised.\n')).sha;
  await q(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, paper_slug, revision_path, revision_sha) VALUES ($1,'audit',$2,'claude-fable-5-1','anthropic','Audit.','t','pending','exact-fold-L','paper/proposals/prop-exact-fold-L.md',$3)`, [pid, uid, rsha]);
  const j = await one(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status) VALUES ($1,NULL,'audit','Audit: exact-fold-L','paper.slug: exact-fold-L\n\nAudit it.','main','{}',3,1,1,'queued') RETURNING id`, [pid]);
  auditJobId = Number(j.id);
  const s3 = await (await call('POST', '/start', {body: {agreed: true, ai: {max_assignments: 1}, transcript_preapproved: true}})).json();
  assert.equal(Number(s3.job_id), auditJobId, JSON.stringify(s3).slice(0, 300));
  assert.match(s3.brief_md, /## Pending revisions of this paper/);
  assert.match(s3.brief_md, new RegExp(rsha.slice(0, 12)));
  await call('POST', `/sessions/${s3.session}/end`, {body: {note: 'test'}});
});
