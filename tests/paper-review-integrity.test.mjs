import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';

// Review follows the served text (Sep 24 2026, paper review integrity). An accepted correction of beta2-note was integrated, then a mirror
// cut carrying the pre-correction text replaced it while the paper kept "reviewed"; a trusted review's required correction lived only in
// its also_fix. Synthetic fixtures of those cases: stale cuts keep the accepted text, status binds to the served hash, a revision made
// against an older text conflicts instead of overwriting, and a finding survives job turnover until an accepted revision answers it.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the paper review integrity tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const tmp = mkdtempSync(join(tmpdir(), 'sah-pri-'));
process.env.DOCS_DIR = join(tmp, 'repos'); process.env.OVERLAY_DIR = join(tmp, 'overlay'); process.env.FILES_DIR = join(tmp, 'files');

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const files = await import('../src/lib/files.ts');
const {recordMirrorCut, restoreVersion, history} = await import('../src/lib/revisions.ts');
const {resolveReturn, spawnFixJob} = await import('../src/routes/job.ts');
const findings = await import('../src/lib/findings.ts');
const {paperReview} = await import('../src/lib/paper-state.ts');
const {listPapers} = await import('../src/routes/papers.ts');
const {inventory} = await import('../src/lib/paper-integrity.ts');

const tag = `pri-test-${Date.now().toString(36)}`;
const slug = tag, rel = 'paper/beta.md', note = 'research/note.md';
let author, reviewer, pid;
const ORIGINAL = '# Beta\n\nThe exponent is proved.\n', CORRECTED = '# Beta\n\nThe exponent is conjectural.\n';
const mirror = (path, text) => { mkdirSync(dirname(join(tmp, 'repos', slug, path)), {recursive: true}); writeFileSync(join(tmp, 'repos', slug, path), text); };
const served = (path) => { const ov = join(tmp, 'overlay', slug, path); return existsSync(ov) ? readFileSync(ov, 'utf8') : readFileSync(join(tmp, 'repos', slug, path), 'utf8'); };
const store = async (name, text) => (await files.store(author, 'claude-fable-5-1', name, 'md', text)).sha;
const submit = async ({path = rel, text, base = files.sha256(served(path)), type = 'audit', jobId = null, resolves = null}) => {
  const sha = await store(path.split('/').pop(), text);
  const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, revision_path, revision_sha, revision_base_sha, paper_slug, job_id, resolves) VALUES ($1,$2,$3,'claude-fable-5-1','anthropic','A change.','t','pending',$4,$5,$6,$7,$8,$9) RETURNING id`,
    [pid, type, author, path, sha, base, path === rel ? 'beta' : null, jobId, resolves ? JSON.stringify(resolves) : null]);
  return Number(r.id);
};
const decide = async (id, verdict = 'accept') => {
  await q(`INSERT INTO reviews (return_id, user_id, model, provider, verdict, notes_md, weight, transcript, trusted) VALUES ($1,$2,'claude-opus-5-5','anthropic',$3,'Checked.',1,'',true)`, [id, reviewer, verdict]);
  return resolveReturn(id);
};
const paper = async () => (await listPapers(pid, slug)).find((p) => p.slug === 'beta');

before(async () => {
  await migrate();
  const mk = async (h) => Number((await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), `${tag}-${h}`, TERMS_VERSION])).id);
  author = await mk('author'); reviewer = await mk('reviewer');
  pid = Number((await one(`INSERT INTO problems (slug, name, repo_url, status_md, researcher_user_id) VALUES ($1,'Integrity test','https://example.org/r','open',$2) RETURNING id`, [slug, author])).id);
  await q(`UPDATE problems SET discovery_share = 0 WHERE id = $1`, [pid]);
  await q(`INSERT INTO channels (problem_id, path, title) VALUES ($1,'','Project')`, [pid]);
  await q(`INSERT INTO papers (problem_id, slug, title, path, kind, status, summary) VALUES ($1,'beta','Beta',$2,'draft','draft','A draft.')`, [pid, rel]);
  mirror(rel, ORIGINAL); mirror(note, '# Note\n\nA figure: 3.\n');
});

after(async () => {
  await q(`DELETE FROM findings WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM file_refs WHERE file_sha IN (SELECT sha256 FROM files WHERE user_id = ANY($1))`, [[author, reviewer]]);
  await q(`DELETE FROM document_versions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM credits WHERE user_id = ANY($1) OR problem_id = $2`, [[author, reviewer], pid]);
  await q(`DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM reviews WHERE user_id = ANY($1)`, [[author, reviewer]]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`UPDATE jobs SET follow_up_of = NULL, parent_return_id = NULL WHERE problem_id = $1`, [pid]);
  await q(`UPDATE papers SET current_return_id = NULL WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM papers WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM files WHERE user_id = ANY($1)`, [[author, reviewer]]);
  await q(`DELETE FROM reputation WHERE user_id = ANY($1)`, [[author, reviewer]]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [[author, reviewer]]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE id = ANY($1)) + (SELECT count(*) FROM problems WHERE id = $2) + (SELECT count(*) FROM returns WHERE problem_id = $2) + (SELECT count(*) FROM findings WHERE problem_id = $2) + (SELECT count(*) FROM files WHERE user_id = ANY($1)) AS n`, [[author, reviewer], pid]);
  await pool.end();
  rmSync(tmp, {recursive: true, force: true});
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

let correction;
test('an accepted revision of a paper binds its review to the served text', async () => {
  correction = await submit({text: CORRECTED});
  assert.equal(await decide(correction), 'accepted');
  assert.equal((await one(`SELECT integration FROM returns WHERE id = $1`, [correction])).integration, 'applied');
  assert.equal(served(rel), CORRECTED);
  const p = await paper();
  assert.equal(p.status, 'reviewed'); assert.equal(p.review.state, 'reviewed'); assert.equal(p.review.review_return_id, correction);
  assert.equal(p.review.current_sha, files.sha256(CORRECTED));
});

test('a stale mirror cut (the pre-correction text) keeps the accepted text and its review', async () => {
  const r = await recordMirrorCut(slug, pid);
  assert.deepEqual(r.find((x) => x.path === rel), {path: rel, action: 'stale', version: 2, matches: 1});
  assert.equal(served(rel), CORRECTED, 'the accepted correction is still served');
  assert.equal((await history(pid, rel)).length, 2, 'nothing recorded');
  assert.equal((await paper()).review.state, 'reviewed');
  assert.deepEqual((await inventory(pid, slug)).stale_mirror, [{path: rel, served_version: 2, mirror_equals_version: 1}]);
  assert.deepEqual(await recordMirrorCut(slug, pid), r, 'a repeat cut is the same no-op');
});

test('a cut equal to the accepted text catches up and keeps the review', async () => {
  mirror(rel, CORRECTED);
  const r = await recordMirrorCut(slug, pid);
  assert.equal(r.find((x) => x.path === rel).action, 'caught-up');
  assert.equal((await paper()).review.state, 'reviewed');
  assert.equal((await recordMirrorCut(slug, pid)).find((x) => x.path === rel).action, 'unchanged');
});

test('new owner text is recorded, served and shown as unreviewed; the accepted version it replaces is named', async () => {
  const OWNER = '# Beta\n\nThe exponent is conjectural; see the note.\n';
  mirror(rel, OWNER);
  assert.equal((await recordMirrorCut(slug, pid)).find((x) => x.path === rel).action, 'recorded');
  const h = await history(pid, rel);
  assert.match(h.at(-1).summary, new RegExp(`replaces version 2, accepted in return #${correction}`));
  const p = await paper();
  assert.equal(p.review.state, 'earlier_version_reviewed'); assert.equal(p.review.earlier_return_id, correction);
  assert.notEqual(p.status, 'reviewed'); assert.equal(p.registry_status, 'draft', 'the stored registry status no longer says reviewed');
  assert.equal(p.review.current_sha, files.sha256(OWNER));
});

test('a restore serves an accepted version again as a recorded version, bound to its review; a repeat is a no-op', async () => {
  const credits = async () => Number((await one(`SELECT count(*) AS n FROM credits WHERE user_id = ANY($1)`, [[author, reviewer]])).n);
  const paidBefore = await credits();
  const dry = await restoreVersion(slug, pid, rel, 2, 'the cut displaced an accepted correction', false);
  assert.equal(dry.action, 'would-restore'); assert.equal((await history(pid, rel)).length, 3, 'a dry run records nothing');
  const r = await restoreVersion(slug, pid, rel, 2, 'the cut displaced an accepted correction', true);
  assert.deepEqual([r.action, r.version, r.return_id], ['restored', 4, correction]);
  assert.equal(served(rel), CORRECTED);
  const v = (await history(pid, rel)).at(-1);
  assert.equal(v.return_id, null, 'no second acceptance: nothing paid again'); assert.match(v.summary, /restored version 2/);
  assert.equal((await paper()).review.state, 'reviewed');
  assert.equal((await restoreVersion(slug, pid, rel, 2, 'again', true)).action, 'unchanged');
  assert.equal(await credits(), paidBefore, 'a restore pays nothing');
});

test('two accepted revisions of the same text: the first applies, the second conflicts and gets a rebase job', async () => {
  const base = files.sha256(served(rel));
  const a = await submit({text: CORRECTED + '\nFirst addition.\n', base});
  const b = await submit({text: CORRECTED + '\nSecond addition.\n', base});
  await decide(a); await decide(b);
  assert.equal((await one(`SELECT integration FROM returns WHERE id = $1`, [a])).integration, 'applied');
  assert.equal((await one(`SELECT integration FROM returns WHERE id = $1`, [b])).integration, 'conflict');
  assert.match(served(rel), /First addition/); assert.doesNotMatch(served(rel), /Second addition/);
  const job = await one(`SELECT title, follow_up_of FROM jobs WHERE problem_id = $1 AND title LIKE 'Rebase return #%'`, [pid]);
  assert.equal(job.title, `Rebase return #${b} onto ${rel}`); assert.equal(Number(job.follow_up_of), b);
  const p = await paper();
  assert.equal(p.review.review_return_id, a);
  assert.deepEqual(p.review.awaiting_integration, [{return_id: b, integration: 'conflict'}]);
});

test('a revision without a recorded base (older returns) is integrated as before', async () => {
  const id = await submit({path: note, text: '# Note\n\nA figure: 4.\n', base: null});
  await decide(id);
  assert.equal((await one(`SELECT integration FROM returns WHERE id = $1`, [id])).integration, 'applied');
});

test('a before-circulation finding qualifies the status, survives job turnover, and closes only on an accepted revision that answers it', async () => {
  const head = files.sha256(served(rel));
  const f1 = await findings.recordFinding({problemId: pid, path: rel, note: 'State the sieve constant in dimension 2.', scope: 'before_circulation', contentSha: head, returnId: correction});
  assert.equal(await findings.recordFinding({problemId: pid, path: rel, note: 'State the sieve constant in dimension 2.', contentSha: head, returnId: correction}), f1, 'the same note from the same return is one finding');
  const job1 = await spawnFixJob(pid, null, slug, rel, 'State the sieve constant in dimension 2.', {findingId: f1, returnId: correction});
  let p = await paper();
  assert.equal(p.review.state, 'corrections_required'); assert.equal(p.status, 'reviewed');
  assert.deepEqual(p.review.findings.map((f) => f.id), [f1]);
  // The job is taken; a second finding arrives: it joins the same job's brief but was not in what the worker took.
  await q(`UPDATE jobs SET status = 'assigned', assigned_at = now() - interval '1 minute' WHERE id = $1`, [job1]);
  const f2 = await findings.recordFinding({problemId: pid, path: rel, note: 'Fix the typo in section 2.', scope: 'before_circulation', contentSha: head, returnId: correction});
  assert.equal(await spawnFixJob(pid, null, slug, rel, 'Fix the typo in section 2.', {findingId: f2, returnId: correction}), job1, 'one repair job per file');
  assert.match((await one(`SELECT brief_md FROM jobs WHERE id = $1`, [job1])).brief_md, /finding #\d+.*\n> Fix the typo/);
  // The first attempt is rejected: both findings stay open and move to the next fix job.
  const bad = await submit({text: served(rel) + '\nNo real change.\n', jobId: job1});
  await q(`UPDATE jobs SET status = 'returned' WHERE id = $1`, [job1]);
  await decide(bad, 'reject');
  const open = await findings.openFindings(pid, rel);
  assert.deepEqual(open.map((f) => f.id), [f1, f2]);
  const job2 = open[0].job_id; assert.notEqual(job2, job1); assert.equal(open[1].job_id, job2);
  assert.equal(open[0].job_status, 'queued');
  // The second attempt names only the first finding: it closes, the other stays open on the next job.
  await q(`UPDATE jobs SET status = 'returned', assigned_at = now() WHERE id = $1`, [job2]);
  const fixed = served(rel).replace('conjectural', 'conjectural (dimension 2 sieve constant)');
  const good = await submit({text: fixed, jobId: job2, resolves: [f1]});
  await decide(good);
  const f1row = await one(`SELECT status, resolved_by_return_id, resolved_sha FROM findings WHERE id = $1`, [f1]);
  assert.deepEqual([f1row.status, Number(f1row.resolved_by_return_id), f1row.resolved_sha], ['resolved', good, files.sha256(fixed)]);
  const still = await findings.openFindings(pid, rel);
  assert.deepEqual(still.map((f) => f.id), [f2]); assert.notEqual(still[0].job_id, job2); assert.equal(still[0].job_status, 'queued');
  p = await paper(); assert.equal(p.review.state, 'corrections_required'); assert.equal(p.review.review_return_id, good);
  const events = await q(`SELECT status FROM finding_events WHERE finding_id = $1 ORDER BY id`, [f1]);
  assert.equal(events.at(-1).status, 'resolved');
});

test('serving again the text a finding was made against reopens it', async () => {
  const f = await one(`SELECT id, content_sha FROM findings WHERE problem_id = $1 AND status = 'resolved' LIMIT 1`, [pid]);
  const v = await one(`SELECT version FROM document_versions WHERE problem_id = $1 AND path = $2 AND content_sha = $3 ORDER BY version DESC LIMIT 1`, [pid, rel, f.content_sha]);
  await restoreVersion(slug, pid, rel, Number(v.version), 'regression fixture', true);
  assert.equal((await one(`SELECT status FROM findings WHERE id = $1`, [f.id])).status, 'open');
});

test('a reopened decision on the served text shows as under reassessment', async () => {
  const p0 = await paper();
  const rid = p0.review.review_return_id;
  await q(`UPDATE returns SET status = 'pending' WHERE id = $1`, [rid]);
  const r = await paperReview(pid, {slug: 'beta', path: rel, current_file_sha: p0.review.current_sha});
  assert.equal(r.state, 'under_reassessment');
  await q(`UPDATE returns SET status = 'accepted' WHERE id = $1`, [rid]);
});

test('the inventory names unworked findings and never-integrated acceptances without changing anything', async () => {
  const before = await one(`SELECT (SELECT count(*) FROM document_versions WHERE problem_id = $1) AS v, (SELECT count(*) FROM jobs WHERE problem_id = $1) AS j`, [pid]);
  const inv = await inventory(pid, slug);
  assert.ok(inv.unintegrated.some((u) => u.integration === 'conflict'));
  assert.ok(Array.isArray(inv.findings_without_work));
  const after = await one(`SELECT (SELECT count(*) FROM document_versions WHERE problem_id = $1) AS v, (SELECT count(*) FROM jobs WHERE problem_id = $1) AS j`, [pid]);
  assert.deepEqual(after, before);
});
