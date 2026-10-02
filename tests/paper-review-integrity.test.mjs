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
const {recordMirrorCut, restoreVersion, history, servedDrift} = await import('../src/lib/revisions.ts');
const {resolveReturn, spawnFixJob, recoverCorrectionJobs, staleRevision, composeReviewBrief} = await import('../src/routes/job.ts');
const {selectJob, whyNotEligible} = await import('../src/lib/scheduler.ts');
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

// Whole-file revisions from a stale base erased accepted edits (#mba-sah-bot-feedback-fixes, fix 4, ~100 bot posts Sep 22-27).
test('a whole-file revision needs the base it was made against, and that base must still be served', async () => {
  const head = files.sha256(served(note));
  const missing = await staleRevision(undefined, slug, note, pid, 'revision');
  assert.equal(missing.status, 400); assert.match(missing.error, /revision\.base is required/); assert.equal(missing.head, head);
  const stale = await staleRevision('a'.repeat(64), slug, note, pid, 'revision');
  assert.equal(stale.status, 409); assert.match(stale.error, /would erase the accepted edits in between/);
  assert.equal(await staleRevision(head.toUpperCase(), slug, note, pid, 'revision'), null, 'the served base passes');
  assert.equal(await staleRevision(undefined, slug, 'paper/new-one.md', pid, 'paper'), null, 'a text nothing serves needs no base');
});

test('an older return without a base conflicts once a later version exists, and the drift check names lost integrated returns', async () => {
  const older = await submit({path: note, text: '# Note\n\nAn older whole file.\n', base: null});
  await q(`UPDATE returns SET created_at = now() - interval '1 hour' WHERE id = $1`, [older]);
  await decide(older);
  assert.equal((await one(`SELECT integration FROM returns WHERE id = $1`, [older])).integration, 'conflict', 'a version newer than the return exists');
  assert.ok(await one(`SELECT 1 FROM jobs WHERE problem_id = $1 AND title = $2`, [pid, `Rebase return #${older} onto ${note}`]));
  assert.deepEqual(await servedDrift(pid, slug), [], 'every document serves its latest version');
  const latest = await one(`SELECT version, return_id FROM document_versions WHERE problem_id = $1 AND path = $2 ORDER BY version DESC LIMIT 1`, [pid, note]);
  writeFileSync(join(tmp, 'overlay', slug, note), '# Note\n\nA figure: 3.\n');   // the text before the swarm, as a whole-file overwrite would leave it
  const drift = await servedDrift(pid, slug);
  assert.equal(drift.length, 1); assert.equal(drift[0].path, note); assert.equal(drift[0].served_version, 1); assert.equal(drift[0].latest, Number(latest.version));
  assert.ok(drift[0].lost_returns.includes(Number(latest.return_id)));
  writeFileSync(join(tmp, 'overlay', slug, note), '# Note\n\nA figure: 4.\n');
});

test('a before-circulation finding qualifies the status, survives job turnover, and closes only on an accepted revision that answers it', async () => {
  const head = files.sha256(served(rel));
  const f1 = await findings.recordFinding({problemId: pid, path: rel, note: 'State the sieve constant in dimension 2.', scope: 'before_circulation', contentSha: head, returnId: correction});
  assert.equal(await findings.recordFinding({problemId: pid, path: rel, note: 'State the sieve constant in dimension 2.', contentSha: head, returnId: correction}), f1, 'the same note from the same return is one finding');
  const job1 = await spawnFixJob(pid, null, slug, rel, 'State the sieve constant in dimension 2.', {findingId: f1, returnId: correction});
  const agent = {problemId: pid, slug, sessionId: 'repair-test', uid: author, tier: 1, model: 'claude-fable-5-1', provider: 'anthropic', trusted: false, granted: false, lane: null, cpuHours: 0, ramGb: 8, hasGpu: false, disk: 1, maxHours: 2, reviewStreak: 0, capabilities: {}, jobId: job1};
  assert.equal((await one(`SELECT min_tier,requires_trust FROM jobs WHERE id=$1`, [job1])).min_tier, 1);
  assert.equal(await selectJob(agent, true), undefined, 'Tier 1 alone does not authorize a correction');
  assert.ok((await whyNotEligible(agent, job1)).includes('it requires a trusted session'));
  assert.equal(await selectJob({...agent, tier: 2, trusted: true}, true), undefined, 'trust alone does not authorize a correction');
  assert.equal(Number((await selectJob({...agent, trusted: true}, true)).id), job1, 'a trusted Tier 1 session can carry the correction');
  assert.match((await one(`SELECT brief_md FROM jobs WHERE id=$1`, [job1])).brief_md, /For a manuscript/);
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

test('historical and reopened required findings recover work once; advisory findings do not generate work', async () => {
  const required = await findings.recordFinding({problemId: pid, path: note, note: 'Correct the cited definition.', scope: 'before_circulation', contentSha: files.sha256(served(note)), returnId: correction});
  const optional = await findings.recordFinding({problemId: pid, path: note, note: 'Optional editorial preference.', scope: 'advisory', contentSha: files.sha256(served(note)), returnId: correction});
  assert.equal(await spawnFixJob(pid, null, slug, note, 'Optional editorial preference.', {findingId: optional}), null, 'optional annotations do not schedule work at intake either');
  await recoverCorrectionJobs(pid, slug);
  const f = (await findings.findingsByIds([required]))[0];
  assert.equal(f.job_status, 'queued');
  assert.equal((await one(`SELECT requires_trust FROM jobs WHERE id=$1`, [f.job_id])).requires_trust, true);
  assert.equal((await findings.findingsByIds([optional]))[0].job_id, null);
  await recoverCorrectionJobs(pid, slug);
  assert.equal((await findings.findingsByIds([required]))[0].job_id, f.job_id);
  await q(`UPDATE jobs SET status='expired' WHERE id=$1`, [f.job_id]);
  await recoverCorrectionJobs(pid, slug);
  assert.notEqual((await findings.findingsByIds([required]))[0].job_id, f.job_id, 'expired work never leaves a required correction without work');
});

test('an accepted audit queues its required corrections to another document immediately', async () => {
  const id = await submit({path: note, text: served(note) + '\nA supported citation.\n'});
  await q(`UPDATE returns SET also_fix=$2 WHERE id=$1`, [id, JSON.stringify([{path: rel, note: 'Update the related citation.', scope: 'before_circulation'}])]);
  await decide(id);
  const f = (await findings.openFindings(pid, rel)).find(f => f.note === 'Update the related citation.');
  assert.ok(f.job_id); assert.equal(f.job_status, 'queued');
  assert.equal((await one(`SELECT requires_trust,min_tier FROM jobs WHERE id=$1`, [f.job_id])).requires_trust, true);
});

test('a conflicting correction carries its finding through one rebase and closes after reconciliation', async () => {
  const path = 'research/conflicting-correction.md'; mirror(path, '# Original\n');
  const f = await findings.recordFinding({problemId: pid, path, note: 'Qualify the estimate.', scope: 'before_circulation', contentSha: files.sha256(served(path)), returnId: correction});
  const jobId = await spawnFixJob(pid, null, slug, path, 'Qualify the estimate.', {findingId: f});
  const base = files.sha256(served(path));
  const earlier = await submit({path, text: '# Original\n\nA citation.\n', base});
  const repair = await submit({path, text: '# Original\n\nA conditional estimate.\n', base, jobId, resolves: [f]});
  await q(`UPDATE jobs SET status='returned',assigned_at=now() WHERE id=$1`, [jobId]);
  await decide(earlier); await decide(repair);
  const rebase = await one(`SELECT * FROM jobs WHERE follow_up_of=$1 AND status='queued'`, [repair]);
  assert.ok(rebase); assert.equal(rebase.requires_trust, true); assert.equal(rebase.min_tier, 1);
  assert.equal((await findings.findingsByIds([f]))[0].job_id, Number(rebase.id));
  assert.equal(Number((await one(`SELECT count(*) AS n FROM jobs WHERE problem_id=$1 AND status='queued' AND (title=$2 OR title=$3)`, [pid, `Fix ${path}`, `Rebase return #${repair} onto ${path}`])).n), 1, 'no parallel redo of the accepted correction');
  assert.match(rebase.brief_md, new RegExp(`finding #${f}:`));
  assert.match(rebase.brief_md, /"resolves"/);
  await q(`UPDATE jobs SET status='returned',assigned_at=now() WHERE id=$1`, [rebase.id]);
  const reconciled = await submit({path, text: '# Original\n\nA citation.\n\nA conditional estimate.\n', jobId: Number(rebase.id)});
  await decide(reconciled);
  assert.equal((await findings.findingsByIds([f]))[0].status, 'resolved');
  assert.match(served(path), /A citation/); assert.match(served(path), /A conditional estimate/);
});

test('review and closure use the same path-filtered assignment targets; later findings stay open', async () => {
  const path = 'research/target-snapshot.md'; mirror(path, '# Snapshot\n');
  const first = await findings.recordFinding({problemId: pid, path, note: 'Correct the original statement.', contentSha: null, returnId: correction});
  const jobId = await spawnFixJob(pid, null, slug, path, 'Correct the original statement.', {findingId: first});
  await q(`UPDATE jobs SET status='assigned',assigned_at=now() WHERE id=$1`, [jobId]);
  const later = await findings.recordFinding({problemId: pid, path, note: 'A finding after assignment.', contentSha: null, returnId: correction});
  await spawnFixJob(pid, null, slug, path, 'A finding after assignment.', {findingId: later});
  const ret = await submit({path, text: '# Snapshot\n\nCorrected original statement.\n', jobId});
  const brief = (await composeReviewBrief(ret, pid)).brief;
  assert.match(brief, new RegExp(`finding #${first}:`));
  assert.doesNotMatch(brief, new RegExp(`finding #${later}:`));
  assert.match(brief, /notes alone do not exclude/);
  await q(`UPDATE jobs SET status='returned' WHERE id=$1`, [jobId]);
  await decide(ret);
  assert.equal((await findings.findingsByIds([first]))[0].status, 'resolved');
  assert.equal((await findings.findingsByIds([later]))[0].status, 'open');
  const foreign = await findings.recordFinding({problemId: pid, path: note, note: 'Different document obligation.', contentSha: null, returnId: ret});
  const explicit = await submit({path, text: served(path) + '\nEditorial addition.\n', resolves: [later, foreign]});
  const explicitBrief = (await composeReviewBrief(explicit, pid)).brief;
  assert.match(explicitBrief, new RegExp(`finding #${later}:`));
  assert.doesNotMatch(explicitBrief, new RegExp(`finding #${foreign}:`));
  const empty = await submit({path, text: served(path) + '\nA citation only.\n', jobId: (await findings.findingsByIds([later]))[0].job_id, resolves: []});
  assert.doesNotMatch((await composeReviewBrief(empty, pid)).brief, /This revision claims to answer/);
  await decide(empty);
  assert.equal((await findings.findingsByIds([later]))[0].status, 'open', 'an explicit empty target never closes a required correction');
});

test('an unverifiable trusted correction retains eligibility and findings in one follow-up', async () => {
  const path = 'research/checkable-correction.md'; mirror(path, '# Checkable\n');
  const jobId = Number((await one(`INSERT INTO jobs (problem_id,type,title,brief_md,min_tier,requires_trust,status) VALUES ($1,'audit','Clarify the cited lemma','Correct the lemma.',1,true,'returned') RETURNING id`, [pid])).id);
  const f = await findings.recordFinding({problemId: pid, path, note: 'Correct the lemma.', contentSha: null, returnId: correction});
  await findings.linkToJob(f, jobId);
  const ret = await submit({path, text: '# Checkable\n\nClaim without the promised source.\n', jobId, resolves: [f]});
  await q(`INSERT INTO reviews (return_id,user_id,model,provider,verdict,notes_md,weight,transcript,trusted,unverifiable,needs_md,reject_reason) VALUES ($1,$2,'claude-opus-5-5','anthropic','reject','Missing cited source.',1,'',true,true,'Supply the cited source.','unverifiable')`, [ret, reviewer]);
  await resolveReturn(ret);
  const follow = await one(`SELECT * FROM jobs WHERE follow_up_of=$1`, [ret]);
  assert.ok(follow); assert.equal(follow.requires_trust, true); assert.equal(follow.min_tier, 1);
  assert.equal((await findings.findingsByIds([f]))[0].job_id, Number(follow.id));
  assert.equal(Number((await one(`SELECT count(*) AS n FROM jobs WHERE problem_id=$1 AND title=$2 AND status='queued'`, [pid, `Fix ${path}`])).n), 0, 'the continuation already carries this repair');
});

test('an advisory annotation can become required, and schema replay preserves historical explicit scopes', async () => {
  const path = 'research/scope-recovery.md'; mirror(path, '# Scope\n');
  const promoted = await findings.recordFinding({problemId: pid, path, note: 'An obligation becomes mandatory.', scope: 'advisory', contentSha: null, returnId: correction});
  assert.equal(await findings.recordFinding({problemId: pid, path, note: 'An obligation becomes mandatory.', scope: 'before_circulation', contentSha: null, returnId: correction}), promoted);
  assert.equal((await findings.findingsByIds([promoted]))[0].scope, 'before_circulation');
  assert.match((await one(`SELECT note FROM finding_events WHERE finding_id=$1 ORDER BY id DESC LIMIT 1`,[promoted])).note,/scope changed: advisory/);
  const ret = await submit({path, text: '# Scope\n\nCitation.\n'});
  await q(`UPDATE returns SET status='accepted',also_fix=$2 WHERE id=$1`, [ret, JSON.stringify([{path, note: 'Optional historical suggestion.', scope: 'advisory'}])]);
  const optional = await findings.recordFinding({problemId: pid, path, note: 'Optional historical suggestion.', contentSha: null, returnId: ret});
  const archived = await findings.recordFinding({problemId: pid, path, note: 'An archived optional suggestion.', contentSha: null, returnId: ret});
  await q(`INSERT INTO review_history (return_id,review) VALUES ($1,$2)`, [ret,JSON.stringify({trusted:true,also_fix:[{path,note:'An archived optional suggestion.',scope:'advisory'}]})]);
  await q(`INSERT INTO reviews (return_id,user_id,model,provider,verdict,notes_md,weight,transcript,trusted,also_fix) VALUES ($1,$2,'claude-opus-5-5','anthropic','accept','Historical annotation.',1,'',true,$3)`, [ret, reviewer, JSON.stringify([{path, note: 'Optional review suggestion.', scope: 'advisory'}, {path, note: 'Mandatory review correction.', scope: 'before_circulation'}])]);
  await migrate();
  assert.equal((await findings.findingsByIds([optional]))[0].scope, 'advisory');
  assert.equal((await findings.findingsByIds([archived]))[0].scope, 'advisory', 'archiving a review does not erase its optional scope');
  const recovered = await findings.openFindings(pid, path);
  assert.equal(recovered.find(f => f.note === 'Optional review suggestion.').scope, 'advisory');
  assert.equal(recovered.find(f => f.note === 'Mandatory review correction.').scope, 'before_circulation');
  await recoverCorrectionJobs(pid, slug);
  assert.equal((await findings.findingsByIds([optional]))[0].job_id, null);
  const legacy = Number((await one(`INSERT INTO jobs (problem_id,type,title,brief_md,status) VALUES ($1,'audit',$2,'Legacy optional assignment.','queued') RETURNING id`,[pid,`Fix ${path}`])).id);
  await findings.linkToJob(optional,legacy);
  await recoverCorrectionJobs(pid,slug);
  assert.equal((await one(`SELECT status FROM jobs WHERE id=$1`,[legacy])).status,'expired', 'an unheld optional-only legacy job is retired');
  const events = Number((await one(`SELECT count(*) AS n FROM finding_events WHERE finding_id=$1`, [optional])).n);
  await migrate();
  assert.equal(Number((await one(`SELECT count(*) AS n FROM finding_events WHERE finding_id=$1`, [optional])).n), events, 'scope recovery is idempotent');
});

test('unavailable old findings cannot starve a later served correction in bounded recovery batches', async () => {
  await q(`INSERT INTO findings (problem_id,path,note) SELECT $1,'research/unavailable-' || n || '.md','Old unavailable correction.' FROM generate_series(1,100) n`, [pid]);
  const path = 'research/available-recovery.md'; mirror(path, '# Available\n');
  const f = await findings.recordFinding({problemId: pid, path, note: 'Repair an available document.', contentSha: null, returnId: correction});
  for (let i=0; i<3; i++) await recoverCorrectionJobs(pid, slug);
  assert.equal((await findings.findingsByIds([f]))[0].job_status, 'queued');
  assert.equal(Number((await one(`SELECT count(*) AS n FROM findings WHERE problem_id=$1 AND path LIKE 'research/unavailable-%' AND last_recovery_at IS NOT NULL`, [pid])).n), 100);
});

test('a superseded return does not strand corrections on a returned job, while provisional review still counts as work', async () => {
  const path = 'research/superseded-correction.md'; mirror(path, '# Superseded\n');
  const f = await findings.recordFinding({problemId: pid, path, note: 'Preserve the outstanding correction.', contentSha: null, returnId: correction});
  const jobId = await spawnFixJob(pid, null, slug, path, 'Preserve the outstanding correction.', {findingId: f});
  const ret = await submit({path, text: '# Superseded\n\nUnintegrated fix.\n', jobId});
  await q(`UPDATE jobs SET status='returned' WHERE id=$1`, [jobId]);
  await q(`UPDATE returns SET status='accepted',provisional=true WHERE id=$1`, [ret]);
  assert.equal((await inventory(pid,slug)).findings_without_work.some(x => x.id === f),false);
  await recoverCorrectionJobs(pid, slug);
  assert.equal((await findings.findingsByIds([f]))[0].job_id, jobId);
  await q(`UPDATE returns SET status='superseded',provisional=false WHERE id=$1`, [ret]);
  assert.equal((await inventory(pid,slug)).findings_without_work.some(x => x.id === f),true,'the inventory sees an unworked obligation before recovery');
  await recoverCorrectionJobs(pid, slug);
  assert.notEqual((await findings.findingsByIds([f]))[0].job_id, jobId);
});
