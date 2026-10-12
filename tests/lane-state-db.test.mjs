import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// The lane state of the art (Oct 12 2026, #sah-sota-trusted-upkeep): trust comes from a grant only (a frontier model at a top thinking
// level no longer makes a session trusted); anyone adds an unverified entry, only a reviewer trusted by grant writes the Verified
// section; an upkeep is queued when a lane has news, offered only to a grant, and taken before anything else; every brief carries both
// sections. Real Postgres (TEST_DATABASE_URL); everything created is deleted.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the lane state tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';
process.env.TRUSTED_MODEL_FAMILIES = 'astra,claude-opus-5-5,gpt-6-1-sol';   // the old setting, still in production's env: it must grant nothing
const tag = `sota-test-${Date.now().toString(36)}`;
const slug = tag;
const projectsDir = mkdtempSync(join(tmpdir(), 'sota-projects-'));
process.env.PROJECTS_DIR = projectsDir;
mkdirSync(join(projectsDir, slug));
const md5 = JSON.parse(readFileSync(new URL('../projects/md5/project.json', import.meta.url), 'utf8'));
writeFileSync(join(projectsDir, slug, 'project.json'), JSON.stringify({...md5, slug, name: 'Test: state of the art', listed: false}));

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job} = await import('../src/routes/job.ts');
const {state} = await import('../src/routes/state.ts');
const {challenges} = await import('../src/routes/challenges.ts');
const {ensureChallengeProjects} = await import('../src/lib/challenges.ts');
const {ensureChannels} = await import('../src/routes/chat.ts');
const {listProjectConfigs} = await import('../src/lib/projects.ts');
const {isTrusted, isGrantedTrusted} = await import('../src/lib/roles.ts');
const {lanesNeedingUpkeep, queueStateUpkeep} = await import('../src/lib/lane-state.ts');

const people = {};
let server, base, pid;
const S = {};
const madeTiers = [];
const MODELS = {owner: 'claude-opus-5-5', astra: 'gpt-6-astra', c: 'claude-fable-5-1'};

before(async () => {
  await migrate();
  for (const [model, provider] of [['gpt-6-astra', 'openai'], ['claude-fable-5-1', 'anthropic'], ['claude-opus-5-5', 'anthropic']])
    if (await one(`INSERT INTO model_tiers (model, provider, tier, note) VALUES ($1,$2,1,'sota test') ON CONFLICT (model) DO NOTHING RETURNING model`, [model, provider])) madeTiers.push(model);
  for (const n of ['owner', 'astra', 'c']) {
    const handle = `${tag}-${n}`;
    const u = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [950_000_000 + Math.floor(Math.random() * 1e8), handle, TERMS_VERSION]);
    people[n] = {id: Number(u.id), handle, token: await issueToken(Number(u.id), 'sota-test')};
  }
  await ensureChallengeProjects(listProjectConfigs(), ensureChannels);
  pid = Number((await one(`SELECT id FROM problems WHERE slug = $1`, [slug])).id);
  await q(`INSERT INTO project_roles (problem_id, user_id, role, note) VALUES ($1,$2,'trusted','Test: a grant')`, [pid, people.owner.id]);
  const app = express(); app.use(express.json());
  app.use('/projects/:slug', challenges); app.use('/projects/:slug', job); app.use('/projects/:slug', state);
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  const ids = Object.values(people).map(p => p.id);
  await q(`DELETE FROM lane_state_entries WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM lane_state_versions WHERE lane_id IN (SELECT id FROM lanes WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM lane_states WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM credits WHERE problem_id = $1 OR user_id = ANY($2)`, [pid, ids]);
  await q(`DELETE FROM counted_entries WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM reviews WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`UPDATE jobs SET parent_return_id = NULL WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM file_refs WHERE ref_type = 'return' AND ref_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM assignment_attempts WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM mutation_receipts WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM messages WHERE job_id IN (SELECT id FROM jobs WHERE problem_id = $1) OR channel_id IN (SELECT id FROM channels WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM sessions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM pool WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM channel_members WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM project_roles WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM lanes WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM tokens WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM reputation WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
  if (madeTiers.length) await q(`DELETE FROM model_tiers WHERE model = ANY($1)`, [madeTiers]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE handle LIKE $1) + (SELECT count(*) FROM problems WHERE slug = $2) AS n`, [`${tag}-%`, slug]);
  await pool.end();
  rmSync(projectsDir, {recursive: true, force: true});
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const call = (who, method, path, {body, session, model = MODELS[who], accept = 'application/json'} = {}) => fetch(`${base}/projects/${slug}${path}`, {
  method, headers: {authorization: `Bearer ${people[who].token}`, accept, 'content-type': 'application/json', 'x-model': model, 'x-effort': 'max', ...(session ? {'x-session': session} : {})},
  body: body ? JSON.stringify(body) : undefined,
});
const transcriptOf = (model) => [
  {type: 'user', message: {role: 'user', content: 'Test: keep the state current'}, timestamp: '2026-10-12T10:00:00Z'},
  {type: 'assistant', message: {role: 'assistant', model, content: [{type: 'text', text: 'done'}], usage: {input_tokens: 100, output_tokens: 50}}, timestamp: '2026-10-12T10:01:00Z'},
].map((l) => JSON.stringify(l)).join('\n');

test('trust comes from a grant only: a frontier model at a top thinking level is not trusted, the granted handle is', async () => {
  assert.equal(await isTrusted(pid, people.astra.id, people.astra.handle, {model: 'gpt-6-astra', effort: 'max'}), false, 'astra at max is no longer trusted');
  assert.equal(await isTrusted(pid, people.c.id, people.c.handle, {model: 'claude-opus-5-5', effort: 'high'}), false, 'nor Opus 5.5 at high');
  assert.equal(await isTrusted(pid, people.owner.id, people.owner.handle, {model: 'claude-fable-5-1', effort: 'low'}), true, 'a grant is trusted whatever its model');
  assert.equal(await isGrantedTrusted(pid, people.owner.id, people.owner.handle), true);
});

test('anyone adds an unverified entry, with its source and, on md5, its hardware and measured throughput; only a grant writes Verified', async () => {
  const s = await call('c', 'GET', '/start'); const j = await s.json(); assert.equal(s.status, 200, JSON.stringify(j).slice(0, 300)); S.c = j.session;
  const lane = j.lane_slug ?? (await one(`SELECT l.slug FROM jobs x JOIN lanes l ON l.id = x.lane_id WHERE x.id = $1`, [j.job_id])).slug;
  S.lane = lane;
  const ret = await one(`INSERT INTO returns (problem_id, lane_id, type, user_id, model, provider, report_md, transcript, status, final_rung) SELECT $1, id, 'measure', $2, 'claude-fable-5-1', 'anthropic', 'Test: a measured run', 'Test', 'recorded', 'recorded' FROM lanes WHERE problem_id = $1 AND slug = $3 RETURNING id`, [pid, people.c.id, lane]);
  S.source = Number(ret.id);
  const missing = await call('c', 'POST', `/state/${lane}/entries`, {session: S.c, body: {body_md: 'Test: an AVX2 kernel with early exit at step 60 runs faster than the scalar loop.', source_return_id: S.source}});
  assert.equal(missing.status, 400, 'md5 asks every entry for its hardware and measured throughput');
  assert.match((await missing.json()).error, /hardware/);
  const ok = await call('c', 'POST', `/state/${lane}/entries`, {session: S.c, body: {body_md: 'Test: an AVX2 kernel with early exit at step 60 runs faster than the scalar loop.', source_return_id: S.source, hardware: 'Test: Ryzen 9 7950X, 16 cores', throughput: '4.1e9 MD5/s'}});
  const okBody = await ok.json(); assert.equal(ok.status, 200, JSON.stringify(okBody)); S.entry = okBody.entry_id;
  const write = await call('c', 'PUT', `/state/${lane}`, {body: {summary_md: '#### Best results\n\nTest: a summary a contributor may not write, long enough to be one.'}});
  assert.equal(write.status, 403, 'a contributor never writes the Verified section');
  const astra = await call('astra', 'PUT', `/state/${lane}`, {body: {summary_md: '#### Best results\n\nTest: a summary a model-trusted session may not write any more.'}});
  assert.equal(astra.status, 403, 'nor does a session that was trusted by its model');
  const doc = await (await call('c', 'GET', `/state/${lane}`)).json();
  assert.equal(doc.verified.version, 0); assert.equal(doc.unverified.length, 1); assert.equal(doc.unverified[0].hardware, 'Test: Ryzen 9 7950X, 16 cores');
});

test('every brief carries its lane\'s state of the art, both sections, clearly labelled', async () => {
  const attempt = await one(`SELECT assignment_payload FROM assignment_attempts WHERE session_id = $1 ORDER BY started_at DESC LIMIT 1`, [S.c]);
  const md = attempt.assignment_payload.brief_md;
  assert.match(md, /## State of the art: /);
  assert.match(md, /### Verified \(written by trusted reviewers only\)/);
  assert.match(md, /### New, not yet verified \(anyone may add\)/);
  assert.match(md, /Platform best \(verified by the server\)/, 'the records are the server\'s own');
  assert.match(md, /fastest known way/, 'md5 frames it as a performance playbook');
});

test('an upkeep is queued when a lane has news, offered only to a grant, and taken before anything else; its return writes Verified', async () => {
  const due = await lanesNeedingUpkeep(pid, slug);
  assert.ok(due.some(l => l.slug === S.lane && /unverified entr/.test(l.why)), 'an open entry makes the lane due');
  // The model-trusted session of old is not offered it.
  const a = await (await call('astra', 'GET', '/start')).json();
  S.astra = a.session;
  assert.notEqual(a.type, 'upkeep', 'a session without a grant never gets an upkeep');
  const upkeep = await one(`SELECT id FROM jobs WHERE problem_id = $1 AND type = 'upkeep' AND status = 'queued'`, [pid]) ?? (await queueStateUpkeep(pid, slug), await one(`SELECT id FROM jobs WHERE problem_id = $1 AND type = 'upkeep' AND status = 'queued'`, [pid]));
  assert.ok(upkeep, 'one upkeep is queued for the lane');
  if (a.job_id) await call('astra', 'POST', '/release', {session: S.astra, body: {job_id: a.job_id, attempt_id: a.attempt_id, note: 'Test: hand back to ask for the upkeep by id'}});
  const why = await (await call('astra', 'GET', `/start?job=${upkeep.id}`, {session: S.astra})).json();
  assert.match(JSON.stringify(why), /trusted by grant|trusted session/, 'asked for by id, it is refused with the reason');
  const ready = await (await call('owner', 'GET', '/ready?work=reviews')).json();
  assert.ok(ready.upkeep >= 1 && ready.ready >= 1, `a reviews-only trusted agent is told there is upkeep: ${JSON.stringify(ready)}`);
  const s = await call('owner', 'GET', '/start'); const j = await s.json(); assert.equal(s.status, 200, JSON.stringify(j).slice(0, 300));
  assert.equal(j.type, 'upkeep', 'the grant takes the upkeep first');
  assert.equal(j.assignment_reason?.policy ?? (await one(`SELECT reason FROM assignment_attempts WHERE id = $1`, [j.attempt_id])).reason.policy, 'state-of-the-art upkeep');
  assert.match(j.brief_md, /Entry \d+/); assert.match(j.brief_md, /state_update/); assert.match(j.brief_md, /Start here: the fastest known way, by machine/);
  const summary = '#### Start here: the fastest known way, by machine\n\nTest: the AVX2 early-exit kernel of #' + S.source + ' (4.1e9 MD5/s on a 16-core Ryzen, checked against its receipts).\n\n#### Best results\n\nTest only.';
  const bad = await call('owner', 'POST', '/result', {session: j.session, body: {job_id: j.job_id, attempt_id: j.attempt_id, transcript: transcriptOf('claude-opus-5-5'), transcript_approved: true, report_md: 'Test: upkeep', state_update: {promote: [S.entry]}}});
  assert.equal(bad.status, 400, 'a promoted entry comes with the rewritten summary');
  const r = await call('owner', 'POST', '/result', {session: j.session, body: {job_id: j.job_id, attempt_id: j.attempt_id, transcript: transcriptOf('claude-opus-5-5'), transcript_approved: true,
    report_md: 'Test: folded the AVX2 entry in.', state_update: {summary_md: summary, promote: [S.entry]}}});
  const body = await r.json(); assert.equal(r.status, 200, JSON.stringify(body).slice(0, 400));
  assert.equal(body.status, 'recorded'); assert.equal(body.reviews_requested, 0); assert.equal(body.state_update.version, 1);
  const doc = await (await call('c', 'GET', `/state/${S.lane}`)).json();
  assert.equal(doc.verified.version, 1); assert.equal(doc.verified.updated_by, people.owner.handle); assert.equal(doc.unverified.length, 0);
  assert.equal(doc.decided_entries[0].status, 'verified');
  assert.equal((await lanesNeedingUpkeep(pid, slug)).some(l => l.slug === S.lane), false, 'nothing new: no upkeep due');
});

test('a return may carry an unverified entry; a bad one is a warning, never a refused return', async () => {
  const s = await (await call('c', 'GET', '/start', {session: S.c})).json();
  const held = await one(`SELECT id, attempt_id, lane_id FROM jobs WHERE assigned_session = $1 AND status = 'assigned'`, [S.c]);
  assert.ok(held, JSON.stringify(s).slice(0, 200));
  const r = await call('c', 'POST', '/result', {session: S.c, body: {job_id: Number(held.id), attempt_id: held.attempt_id, transcript: transcriptOf('claude-fable-5-1'), transcript_approved: true,
    report_md: 'Test: a run with nothing submitted.', recipe_md: 'Test: node search.mjs 1 prints nothing; rerun with the same seed.', state_entry: {body_md: 'Test: too short'}}});
  const body = await r.json(); assert.equal(r.status, 200, JSON.stringify(body).slice(0, 300));
  assert.ok(body.warnings.some(w => /state_entry not recorded/.test(w)), JSON.stringify(body.warnings));
});
