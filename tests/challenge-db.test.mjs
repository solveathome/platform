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
writeFileSync(join(projectsDir, slug, 'project.json'), JSON.stringify({...md5, slug, name: 'Challenge test'}));

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job} = await import('../src/routes/job.ts');
const {challenges} = await import('../src/routes/challenges.ts');
const {projects} = await import('../src/routes/projects.ts');
const {ensureChallengeProjects, trackView, challengeConfig} = await import('../src/lib/challenges.ts');
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
  app.use('/projects/:slug', challenges); app.use('/projects/:slug', job); app.use(projects);
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

const MODELS = {a: 'claude-opus-5-5', b: 'gpt-6-astra', owner: 'claude-opus-5-5'};
const call = (who, method, path, {body, session, model = MODELS[who], accept = 'application/json'} = {}) => fetch(`${base}/projects/${slug}${path}`, {
  method, headers: {authorization: `Bearer ${people[who].token}`, accept, 'content-type': 'application/json', 'x-model': model, 'x-effort': 'high', ...(session ? {'x-session': session} : {})},
  body: body ? JSON.stringify(body) : undefined,
});
let n = 0;
const submit = async (who, body, extra = {}) => { const r = await call(who, 'POST', '/submissions', {session: S[who], body: {idempotency_key: `k-${tag}-${++n}`, ...body}, ...extra}); return {status: r.status, body: await r.json()}; };

test('an agent joins through /start and gets a track assignment with the submission API; no session, no submission', async () => {
  for (const who of ['a', 'b']) {
    const r = await call(who, 'GET', '/start');
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j).slice(0, 300));
    assert.match(j.brief_md, /POST .*\/submissions/);
    assert.match(j.brief_md, /Track `md5-/);
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
  const jump = await submit('b', {challenge_id: MIRROR, candidate: '54db1011d76dc70a0a9df3ff3e0b390f', attribution: 'Thomas Egense'});
  assert.deepEqual(jump.body.achievements.filter(x => x.kind === 'milestone').map(x => x.value), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(jump.body.known_result, true); assert.ok(jump.body.achievements.some(x => x.kind === 'target' && !x.exceeded));
  const dup = await submit('a', {challenge_id: MIRROR, candidate: '54db1011d76dc70a0a9df3ff3e0b390f'});
  assert.equal(dup.body.duplicate, true); assert.equal(dup.body.duplicate_of, jump.body.submission_id); assert.equal(dup.body.site_record, false); assert.equal(dup.body.personal_best, true);
  const view = await trackView(pid, challengeConfig(slug).tracks[0]);
  assert.equal(view.best.submission_id, jump.body.submission_id);
  assert.equal(view.milestones.find(m => m.value === 12).handle, people.b.handle);
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
  const many = await Promise.all(Array.from({length: 8}, (_, i) => submit(i % 2 ? 'a' : 'b', {challenge_id: ZERO, input_hex: '6231303064343734656231303064363064303432653836336331653061646565'})));
  assert.ok(many.every(m => m.status === 201));
  const ids = many.map(m => m.body.submission_id);
  assert.equal(new Set(ids).size, 8);
  const firsts = many.filter(m => !m.body.duplicate);
  assert.equal(firsts.length, 1, 'one original, seven duplicates');
  assert.equal(firsts[0].body.submission_id, Math.min(...ids), 'the earliest receipt holds the priority');
  const winners = await q(`SELECT value, count(*)::int AS c FROM challenge_events WHERE problem_id = $1 AND challenge_id = $2 AND kind = 'milestone' GROUP BY value`, [pid, ZERO]);
  assert.ok(winners.every(w => w.c === 1)); assert.equal(winners.length, 13);
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

test('finishing closes the assignment with its report; the next /start hands out another track', async () => {
  const held = await one(`SELECT id, attempt_id FROM jobs WHERE problem_id = $1 AND assigned_session = $2 AND status = 'assigned'`, [pid, S.a]);
  const r = await call('a', 'POST', '/challenge/finish', {session: S.a, body: {job_id: Number(held.id), attempt_id: held.attempt_id, report_md: 'Test: baseline only.'}});
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await one(`SELECT status FROM jobs WHERE id = $1`, [held.id])).status, 'returned');
  const next = await (await call('a', 'GET', '/start', {session: S.a})).json();
  assert.match(next.brief_md, /solveathome job #\d+/);
});

test('pages render: overview with three charts, track, record; JSON for agents', async () => {
  const html = await (await call('a', 'GET', '', {accept: 'text/html'})).text();
  assert.equal((html.match(/class="cc-chart"/g) ?? []).length, 3);
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
