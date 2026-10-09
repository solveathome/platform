import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// The record path of a challenge project end to end (Oct 9 2026, the MD5 challenge; acceptance tests 3 to 5 of its proposal): an agent
// joins through /start and gets a track, submissions are received in order under the project lock, milestones and records have one
// winner each, duplicates and replays keep priority, corrections never rewrite, demo data stays apart and can be deleted, and a
// hidden project is reachable but never listed. Real Postgres (TEST_DATABASE_URL); everything created is deleted.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the challenge tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';
const tag = `chal-test-${Date.now().toString(36)}`;
const slug = tag;
const projectsDir = mkdtempSync(join(tmpdir(), 'challenge-projects-'));
process.env.PROJECTS_DIR = projectsDir;
mkdirSync(join(projectsDir, slug));
const md5 = JSON.parse(readFileSync(new URL('../projects/md5/project.json', import.meta.url), 'utf8'));
// The collision target's bytes are left out here, so the record mechanics can use the one collision a test can carry; the last test
// lists it as published and checks it is refused.
const testConfig = structuredClone(md5);
testConfig.challenge.tracks[2].targets = testConfig.challenge.tracks[2].targets.map(({inputs, ...t}) => t);
writeFileSync(join(projectsDir, slug, 'project.json'), JSON.stringify({...testConfig, slug, name: 'Challenge test'}));

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job, settleChallengeRun, settlePendingChallengeRuns} = await import('../src/routes/job.ts');
const {challenges} = await import('../src/routes/challenges.ts');
const {projects} = await import('../src/routes/projects.ts');
const {board} = await import('../src/routes/board.ts');
const {ensureChallengeProjects, trackView, challengeConfig, forgetKnown, challengeJob} = await import('../src/lib/challenges.ts');
const {ensureChannels} = await import('../src/routes/chat.ts');
const {listProjectConfigs, featuredProject, isListed} = await import('../src/lib/projects.ts');
const {noindexPath} = await import('../src/lib/seo.ts');

const people = {};
let server, base, pid;
const S = {};
const A = md5.challenge.tracks[2].targets[0].inputs.a_hex, B = md5.challenge.tracks[2].targets[0].inputs.b_hex;
const MIRROR = 'md5-mirror-ascii32-v1', ZERO = 'md5-zero-bytes1024-v1', COLL = 'md5-collision-totalbytes1024-v1';

before(async () => {
  await migrate();
  for (const n of ['a', 'b', 'owner']) {
    const handle = `${tag}-${n}`;
    const u = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [940_000_000 + Math.floor(Math.random() * 1e8), handle, TERMS_VERSION]);
    people[n] = {id: Number(u.id), handle, token: await issueToken(Number(u.id), 'challenge-test')};
  }
  process.env.OWNER_HANDLES = people.owner.handle;
  await ensureChallengeProjects(listProjectConfigs(), ensureChannels);
  pid = Number((await one(`SELECT id FROM problems WHERE slug = $1`, [slug])).id);
  const app = express(); app.use(express.json());
  app.use('/projects/:slug', challenges); app.use('/projects/:slug', job); app.use('/projects/:slug', board); app.use(projects);
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  const ids = Object.values(people).map(p => p.id);
  await q(`DELETE FROM challenge_corrections WHERE submission_id IN (SELECT id FROM challenge_submissions WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM challenge_events WHERE problem_id = $1`, [pid]);
  await q(`UPDATE challenge_submissions SET duplicate_of = NULL WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM challenge_submissions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM challenge_reports WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM credits WHERE problem_id = $1 OR user_id = ANY($2)`, [pid, ids]);
  await q(`DELETE FROM counted_entries WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM reviews WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`UPDATE jobs SET parent_return_id = NULL WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM assignment_attempts WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM mutation_receipts WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM assignment_attempts WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM sessions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM pool WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM channel_members WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM lanes WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM tokens WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM reputation WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE handle LIKE $1) + (SELECT count(*) FROM problems WHERE slug = $2) + (SELECT count(*) FROM challenge_submissions WHERE problem_id = $3) AS n`, [`${tag}-%`, slug, pid]);
  await pool.end();
  rmSync(projectsDir, {recursive: true, force: true});
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const MODELS = {a: 'claude-opus-5-5', b: 'gpt-6-astra', owner: 'gpt-6-astra'};
const call = (who, method, path, {body, session, model = MODELS[who], accept = 'application/json'} = {}) => fetch(`${base}/projects/${slug}${path}`, {
  method, headers: {authorization: `Bearer ${people[who].token}`, accept, 'content-type': 'application/json', 'x-model': model, 'x-effort': 'high', ...(session ? {'x-session': session} : {})},
  body: body ? JSON.stringify(body) : undefined,
});
let n = 0;
const transcriptOf = (model) => [
  {type: 'user', message: {role: 'user', content: 'Test: run the search'}, timestamp: '2026-10-09T10:00:00Z'},
  {type: 'assistant', message: {role: 'assistant', model, content: [{type: 'text', text: 'ran it'}], usage: {input_tokens: 100, output_tokens: 50}}, timestamp: '2026-10-09T10:01:00Z'},
].map((l) => JSON.stringify(l)).join('\n');
const submit = async (who, body, extra = {}) => { const r = await call(who, 'POST', '/submissions', {session: S[who], body: {idempotency_key: `k-${tag}-${++n}`, ...body}, ...extra}); return {status: r.status, body: await r.json()}; };

test('an agent joins through /start and gets a track assignment with the submission API; no session, no submission', async () => {
  for (const who of ['a', 'b']) {
    const r = await call(who, 'GET', '/start');
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j).slice(0, 300));
    assert.match(j.brief_md, /POST .*\/submissions/);
    assert.match(j.brief_md, /Track `md5-/);
    assert.equal(j.type, 'measure', 'a track run is an ordinary measure assignment, reviewed and credited like any other');
    assert.match(j.brief_md, /POST .*\/result/);
    S[who] = j.session;
  }
  const none = await call('a', 'POST', '/submissions', {body: {challenge_id: MIRROR, idempotency_key: 'nosession01', candidate: '0'.repeat(32)}});
  assert.equal(none.status, 400);
  assert.equal(Number((await one(`SELECT count(*) AS c FROM challenge_submissions WHERE problem_id = $1`, [pid])).c), 0);
});

test('receipts: score jump awards every milestone to one submission, ties and duplicates keep the earlier receipt, replays return the original', async () => {
  const s1 = await submit('a', {challenge_id: MIRROR, candidate: '000000000000000000000000000000e6'});
  assert.equal(s1.status, 201); assert.equal(s1.body.score, 2); assert.deepEqual(s1.body.achievements.filter(x => x.kind === 'milestone').map(x => x.value), [1, 2]);
  const zero = await submit('b', {challenge_id: MIRROR, candidate: '00000000000000000000000000000000'});
  assert.equal(zero.body.score, 0); assert.equal(zero.body.achievements.length, 0, 'score 0 earns no milestone');
  const jump = await submit('b', {challenge_id: MIRROR, candidate: '72690dc972013c32bce5e984a6681b99'});   // 5, found by a plain random search
  assert.deepEqual(jump.body.achievements.filter(x => x.kind === 'milestone').map(x => x.value), [3, 4, 5]);
  const dup = await submit('a', {challenge_id: MIRROR, candidate: '72690dc972013c32bce5e984a6681b99'});
  assert.equal(dup.body.duplicate, true); assert.equal(dup.body.duplicate_of, jump.body.submission_id); assert.equal(dup.body.site_record, false); assert.equal(dup.body.personal_best, true);
  const view = await trackView(pid, challengeConfig(slug).tracks[0]);
  assert.equal(view.best.submission_id, jump.body.submission_id);
  assert.equal(view.milestones.find(m => m.value === 5).handle, people.b.handle);
  // Idempotency: same key and body returns the original; same key, other body is refused.
  const key = `idem-${tag}`;
  const r1 = await call('a', 'POST', '/submissions', {session: S.a, body: {challenge_id: ZERO, idempotency_key: key, input_hex: '06'}});
  const r2 = await call('a', 'POST', '/submissions', {session: S.a, body: {challenge_id: ZERO, idempotency_key: key, input_hex: '06'}});
  const o1 = await r1.json(), o2 = await r2.json();
  assert.equal(o2.submission_id, o1.submission_id); assert.equal(o2.replayed, true);
  const r3 = await call('a', 'POST', '/submissions', {session: S.a, body: {challenge_id: ZERO, idempotency_key: key, input_hex: '07'}});
  assert.equal(r3.status, 409);
  // Supplied results are refused, never trusted.
  assert.equal((await submit('a', {challenge_id: ZERO, input_hex: '06', digest: '0'.repeat(32)})).status, 400);
  assert.equal((await submit('a', {challenge_id: ZERO, input_hex: '06', received_at: '2020-01-01'})).status, 400);
});

test('concurrent submissions get distinct ordered receipts and exactly one winner per milestone', async () => {
  const many = await Promise.all(Array.from({length: 8}, (_, i) => submit(i % 2 ? 'a' : 'b', {challenge_id: ZERO, input_hex: '9b37e36766f0622f34777adbc78a4ab0'})));   // 6 leading zeros, found by a plain random search
  assert.ok(many.every(m => m.status === 201));
  const ids = many.map(m => m.body.submission_id);
  assert.equal(new Set(ids).size, 8);
  const firsts = many.filter(m => !m.body.duplicate);
  assert.equal(firsts.length, 1, 'one original, seven duplicates');
  assert.equal(firsts[0].body.submission_id, Math.min(...ids), 'the earliest receipt holds the priority');
  const winners = await q(`SELECT value, count(*)::int AS c FROM challenge_events WHERE problem_id = $1 AND challenge_id = $2 AND kind = 'milestone' GROUP BY value`, [pid, ZERO]);
  assert.ok(winners.every(w => w.c === 1)); assert.equal(winners.length, 6);
  const order = await q(`SELECT id, received_at FROM challenge_submissions WHERE problem_id = $1 ORDER BY id`, [pid]);
  for (let i = 1; i < order.length; i++) assert.ok(new Date(order[i].received_at) >= new Date(order[i - 1].received_at), 'receipt order and time agree');
});

test('collisions: only full collisions count, shrinking totals each make a step, the swapped pair is a duplicate', async () => {
  const pad = 'ab'.repeat(64);   // an identical suffix after a colliding block keeps the collision
  const long = await submit('a', {challenge_id: COLL, a_hex: A + pad, b_hex: B + pad});
  assert.equal(long.status, 201); assert.equal(long.body.total_bytes, 256);
  const short = await submit('b', {challenge_id: COLL, a_hex: B, b_hex: A});
  assert.equal(short.body.total_bytes, 128); assert.equal(short.body.site_record, true);
  const swapped = await submit('a', {challenge_id: COLL, a_hex: A, b_hex: B});
  assert.equal(swapped.body.duplicate, true);
  assert.equal((await submit('a', {challenge_id: COLL, a_hex: A, b_hex: A})).status, 400);
  assert.equal((await submit('a', {challenge_id: COLL, a_hex: '00', b_hex: '01'})).status, 400);
  const view = await trackView(pid, challengeConfig(slug).tracks[2]);
  assert.deepEqual(view.steps.map(s => s.value), [256, 128]);
});

test('corrections withdraw and restore without rewriting; demo data stays apart and only its submitter deletes it', async () => {
  const track = challengeConfig(slug).tracks[0];
  const best = (await trackView(pid, track)).best;
  assert.equal((await call('a', 'POST', '/challenge/corrections', {body: {submission_id: best.submission_id, kind: 'void', note: 'test'}})).status, 403);
  assert.equal((await call('owner', 'POST', '/challenge/corrections', {body: {submission_id: best.submission_id, kind: 'void', note: 'test: verifier defect drill'}})).status, 200);
  const after = await trackView(pid, track);
  assert.notEqual(after.best?.submission_id, best.submission_id);
  assert.ok(await one(`SELECT 1 FROM challenge_submissions WHERE id = $1`, [best.submission_id]), 'the receipt itself is kept');
  await call('owner', 'POST', '/challenge/corrections', {body: {submission_id: best.submission_id, kind: 'restore', note: 'test: restored'}});
  assert.equal((await trackView(pid, track)).best.submission_id, best.submission_id);

  const demo = await submit('a', {challenge_id: MIRROR, candidate: '00000000000000000000000000001efd', demo: true});
  assert.equal(demo.body.namespace, 'demo'); assert.equal(demo.body.site_record, true, 'records in the demo namespace are its own');
  assert.ok(!(await trackView(pid, track)).steps.some(s => s.submission_id === demo.body.submission_id));
  const live = (await submit('a', {challenge_id: MIRROR, candidate: '00000000000000000000000000001efd'})).body.submission_id;
  assert.equal((await call('a', 'DELETE', `/submissions/${live}`)).status, 409, 'a live receipt is never deleted');
  assert.equal((await call('b', 'DELETE', `/submissions/${demo.body.submission_id}`)).status, 403);
  assert.equal((await call('a', 'DELETE', `/submissions/${demo.body.submission_id}`)).status, 200);
  assert.equal(await one(`SELECT 1 FROM challenge_submissions WHERE id = $1`, [demo.body.submission_id]), undefined);
});

test('a track run with a verified submission of its own settles on return: accepted at verified, result points paid, nothing queued for review', async () => {
  const held = await one(`SELECT id, attempt_id FROM jobs WHERE problem_id = $1 AND assigned_session = $2 AND status = 'assigned'`, [pid, S.a]);
  const long = '5a'.repeat(40);   // a 40-byte input: 80 hex characters, which hold a 64-character run that looks like a sha256
  assert.equal((await submit('a', {challenge_id: ZERO, input_hex: long})).status, 201);
  const r = await call('a', 'POST', '/result', {session: S.a, body: {job_id: Number(held.id), attempt_id: held.attempt_id, transcript: transcriptOf('claude-opus-5-5'), transcript_approved: true,
    report_md: 'Test: a plain random search, receipts above.', recipe_md: `Test: node search.mjs zero 15 7 prints the input and its score; reproduce with the same seed. Best input ${long}.`}});
  const ret = await r.json();
  assert.equal(r.status, 200, JSON.stringify(ret).slice(0, 300));
  assert.equal(ret.status, 'accepted'); assert.equal(ret.final_rung, 'verified'); assert.equal(ret.reviews_requested, 0);
  assert.ok(!ret.warnings.some((w) => /sha256 value/.test(w)), 'the run\'s own candidate in its recipe is not taken for a file hash');
  assert.equal((await one(`SELECT by FROM return_decisions WHERE return_id = $1`, [ret.return_id])).by, 'verifier');
  assert.equal(Number((await one(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1 AND status IN ('queued','assigned')`, [ret.return_id])).c), 0);
  const paid = await one(`SELECT sum(points)::float AS p, count(*)::int AS n FROM credits WHERE source_type = 'return' AND source_id = $1 AND kind = 'result'`, [String(ret.return_id)]);
  assert.ok(paid.p > 0); assert.equal(paid.n, 1, 'paid once');
  assert.equal(await settlePendingChallengeRuns(pid), 0, 'settling again changes nothing');
});

test('a run without a verified submission goes to review; a trusted review accepts it and pays points', async () => {
  const next = await (await call('a', 'GET', '/start', {session: S.a})).json();
  assert.match(next.brief_md, /solveathome job #\d+/);
  const held = await one(`SELECT id, attempt_id FROM jobs WHERE problem_id = $1 AND assigned_session = $2 AND status = 'assigned'`, [pid, S.a]);
  const r = await call('a', 'POST', '/result', {session: S.a, body: {job_id: Number(held.id), attempt_id: held.attempt_id, transcript: transcriptOf('claude-opus-5-5'), transcript_approved: true,
    report_md: 'Test: a negative run, nothing submitted.', recipe_md: 'Test: node search.mjs mirror 15 9 found nothing above the platform best; rerun with the same seed.'}});
  const ret = await r.json();
  assert.equal(r.status, 200, JSON.stringify(ret).slice(0, 300));
  assert.equal(ret.status, 'pending');
  const rv = await call('owner', 'POST', '/result', {body: {type: 'review', return_id: ret.return_id, verdict: 'accept', rung: 'measured', notes_md: 'Test: the negative result is sound.', transcript: transcriptOf('gpt-6-astra'), transcript_approved: true}});
  const review = await rv.json();
  assert.equal(rv.status, 200, JSON.stringify(review).slice(0, 300)); assert.equal(review.return_status, 'accepted');
});

test('settlement never applies outside a record challenge: a project without challenge tracks keeps its review', async () => {
  const other = await one(`INSERT INTO problems (slug, name, repo_url) VALUES ($1,'Plain test','https://example.org/r') RETURNING id`, [`${tag}-plain`]);
  const j = await one(`INSERT INTO jobs (problem_id, type, title, brief_md, origin_key, status) VALUES ($1,'measure','Test: plain','x',$2,'returned') RETURNING id`, [other.id, `challenge:${MIRROR}:test`]);
  const r = await one(`INSERT INTO returns (problem_id, job_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,$2,'measure',$3,'claude-opus-5-5','anthropic','Test','t','pending') RETURNING id`, [other.id, j.id, people.a.id]);
  await q(`INSERT INTO challenge_submissions (problem_id, challenge_id, user_id, job_id, idempotency_key, request_sha256, identity_sha256, inputs, digest, score, verifier_version, checks) VALUES ($1,$2,$3,$4,$5,'x','x','{}','x',3,'v','{}')`, [other.id, MIRROR, people.a.id, j.id, `plain-${tag}`]);
  assert.equal(await settleChallengeRun(Number(r.id)), false);
  assert.equal((await one(`SELECT status FROM returns WHERE id = $1`, [r.id])).status, 'pending');
  await q(`DELETE FROM challenge_submissions WHERE problem_id = $1`, [other.id]);
  await q(`DELETE FROM returns WHERE id = $1`, [r.id]);
  await q(`DELETE FROM jobs WHERE id = $1`, [j.id]);
  await q(`DELETE FROM problems WHERE id = $1`, [other.id]);
});

test('pages render: overview with three charts, track, record; JSON for agents', async () => {
  const html = await (await call('a', 'GET', '', {accept: 'text/html'})).text();
  assert.equal((html.match(/class="cc-chart"/g) ?? []).length, 3, 'the three charts are inline on the project page');
  assert.match(html, /id="startfield"/, 'the standard sign-in and limits start field');
  assert.match(html, /id="highscores"/, 'the standard points leaderboard');
  // Each platform best links to the receipt that holds it, each published value to its source (Chris, Oct 9 2026).
  for (const t of md5.challenge.tracks) {
    const best = (await trackView(pid, challengeConfig(slug).tracks.find((x) => x.id === t.id))).best;
    if (best) assert.ok(html.includes(`Platform best: <a href="/projects/${slug}/submissions/${best.submission_id}"`), `${t.id} best links to #${best.submission_id}`);
    const target = [...t.targets].reverse().find((x) => !x.superseded_on);
    assert.ok(html.includes(`Published: <a href="${target.source_url}"`), `${t.id} published links to ${target.source_url}`);
  }
  assert.match(html, /noindex/);
  for (const t of md5.challenge.tracks) assert.equal((await call('a', 'GET', `/tracks/${t.lane}`, {accept: 'text/html'})).status, 200);
  const sub = await one(`SELECT id FROM challenge_submissions WHERE problem_id = $1 AND challenge_id = $2 ORDER BY id LIMIT 1`, [pid, COLL]);
  const page = await (await call('a', 'GET', `/submissions/${sub.id}`, {accept: 'text/html'})).text();
  assert.match(page, /Download a \(/);
  const bin = Buffer.from(await (await call('a', 'GET', `/submissions/${sub.id}/a.bin`)).arrayBuffer());
  const json = await (await call('a', 'GET', `/submissions/${sub.id}`)).json();
  assert.equal(bin.toString('hex'), json.inputs.a_hex);
  assert.equal(json.session_id, undefined, 'no session ids in public records');
  const csv = await (await call('a', 'GET', '/challenge/export.csv')).text();
  assert.match(csv.split('\n')[0], /^id,challenge_id,handle/);
});

test('a hidden project is reachable but never listed, featured or indexed', async () => {
  assert.equal(isListed(slug), false);
  const list = await (await fetch(`${base}/projects`, {headers: {accept: 'application/json'}})).json();
  assert.ok(!list.some(p => p.slug === slug));
  assert.notEqual((await featuredProject())?.slug, slug);
  assert.equal(noindexPath(`/projects/${slug}`), true);
  assert.equal(noindexPath(`/projects/${slug}/tracks/self-match`), true);
});

test('published answers are refused with the reason, a known collision with bytes appended too; a claimed result must match the recomputation', async () => {
  const before = Number((await one(`SELECT count(*) AS c FROM challenge_submissions WHERE problem_id = $1`, [pid])).c);
  writeFileSync(join(projectsDir, slug, 'known-results.json'), JSON.stringify({[COLL]: [{a_hex: A, b_hex: B, total_bytes: 128, credit: 'Marc Stevens', source_url: 'https://marc-stevens.nl/research/md5-1block-collision/'}]}));
  forgetKnown();
  for (const body of [
    {challenge_id: MIRROR, candidate: '54db1011d76dc70a0a9df3ff3e0b390f'},
    {challenge_id: ZERO, input_hex: '7b626b674e52354553377d2d307836394245303237433937'},
    {challenge_id: COLL, a_hex: B, b_hex: A},
    {challenge_id: COLL, a_hex: A + 'cd'.repeat(10), b_hex: B + 'cd'.repeat(10)},
  ]) {
    const r = await submit('a', body);
    assert.equal(r.status, 422, JSON.stringify(r.body).slice(0, 200));
    assert.match(r.body.error, /published answer/);
    assert.ok(r.body.published.credit);
  }
  const wrong = await submit('a', {challenge_id: ZERO, input_hex: '06', claimed_score: 3});
  assert.equal(wrong.status, 422); assert.match(wrong.body.error, /does not match/); assert.equal(wrong.body.recomputed.score, 1);
  const wrongDigest = await submit('a', {challenge_id: MIRROR, candidate: '00000000000000000000000000001efd', claimed_digest: '0'.repeat(32)});
  assert.equal(wrongDigest.status, 422);
  assert.equal((await submit('a', {challenge_id: COLL, a_hex: '00', b_hex: '01', claimed_score: 1})).status, 400, 'a collision is claimed in bytes, never as a score');
  assert.equal(Number((await one(`SELECT count(*) AS c FROM challenge_submissions WHERE problem_id = $1`, [pid])).c), before, 'nothing refused was recorded');
  const right = await submit('a', {challenge_id: MIRROR, candidate: '00000000000000000000000000001efd', claimed_digest: '0005b7062c52fc4ee9762f633adb35fa', claimed_score: 3});
  assert.equal(right.status, 201);
});

test('two agents on one track each get work of their own, and runs alternate with studies of MD5 structure (cycle 1: a 500 on /start; Chris: understanding first)', async () => {
  await q(`UPDATE jobs SET status = 'expired' WHERE problem_id = $1 AND status = 'queued'`, [pid]);   // start the track from a clean queue
  const first = await challengeJob(pid, slug, 'all-zeros');
  await q(`UPDATE jobs SET status = 'assigned' WHERE id = $1`, [first.id]);
  const second = await challengeJob(pid, slug, 'all-zeros');
  assert.notEqual(Number(second.id), Number(first.id), 'a held run never blocks a new assignment');
  const kinds = [first, second].map((j) => j.type).sort();
  assert.deepEqual(kinds, ['explore', 'measure'], 'a run and a study, in either order');
  const study = [first, second].find((j) => j.type === 'explore');
  assert.match(study.origin_key, /^challenge:md5-zero-bytes1024-v1:study:/);
  assert.ok(md5.challenge.tracks[1].studies.includes(study.brief_md), 'the study asks one of the track\'s open questions');
  await q(`UPDATE jobs SET status = 'expired' WHERE problem_id = $1 AND status IN ('queued','assigned') AND origin_key LIKE 'challenge:md5-zero-bytes1024-v1%'`, [pid]);
});
