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
const {lanesNeedingUpkeep, queueStateUpkeep, insertStateSection, stateBrief, stateDoc, upkeepBrief, applyStateUpdate, parseStateUpdate, SUMMARY_MAX} = await import('../src/lib/lane-state.ts');
const {renderBrief, renderChatBrief} = await import('../src/lib/brief.ts');
const {compactDepartmentBrief} = await import('../src/lib/department-protocol.ts');

/** The brief contract (Chris, Oct 12 2026: "make sure this state of the art is part of the brief"): the lane's state of the art inline,
 *  Verified before New, under the title and before the first of the brief's own sections; on md5 the Verified part opens with the
 *  fastest method per machine. */
function assertStateOnTop(md, kind) {
  const at = md.indexOf('## State of the art');
  assert.ok(at >= 0, `${kind}: no state of the art in the brief`);
  const verified = md.indexOf('### Verified (written by trusted reviewers only)', at), fresh = md.indexOf('### New, not yet verified (anyone may add)', at);
  assert.ok(verified > at && fresh > verified, `${kind}: Verified then New`);
  assert.ok(md.indexOf('#### Start here: the fastest known way, by machine', verified) > verified || md.indexOf('Start here', verified) > verified || !/Verified summary version [1-9]|Version [1-9]/.test(md.slice(verified, fresh)), `${kind}: the md5 playbook opens Verified`);
  const firstOwn = ['## Your person already decided', '## How this works from a chat', '## Rules (read before starting)', '## The task', '## Current limits and evidence']
    .map(h => md.indexOf(h)).filter(i => i >= 0);
  assert.ok(firstOwn.length && at < Math.min(...firstOwn), `${kind}: the state of the art sits above the brief's own sections (at ${at}, first section at ${Math.min(...firstOwn)})`);
}

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
  assertStateOnTop(md, 'track run (registration reply)');
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
  assertStateOnTop(j.brief_md, 'upkeep');
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
  // An upkeep may leave an entry open; that entry does not make the lane due again (#sah-manage-rescue-prod-check: on md5 every start of
  // a granted session was a "no change" upkeep, so management sessions never reached reviews or rescues).
  const laneId = (await one(`SELECT id FROM lanes WHERE problem_id = $1 AND slug = $2`, [pid, S.lane])).id;
  await q(`INSERT INTO lane_state_entries (problem_id, lane_id, body_md, source_return_id, user_id) VALUES ($1,$2,'Test: an entry the next upkeep leaves open.',$3,$4)`, [pid, laneId, S.source, people.c.id]);
  assert.ok((await lanesNeedingUpkeep(pid, slug)).some(l => l.slug === S.lane && /1 new unverified entry/.test(l.why)), 'a new entry makes the lane due');
  const k = await (await call('owner', 'GET', '/start')).json(); assert.equal(k.type, 'upkeep', JSON.stringify(k).slice(0, 300));
  const through = (await one(`SELECT through_return_id FROM lane_states WHERE lane_id = $1`, [laneId])).through_return_id;
  const left = await call('owner', 'POST', '/result', {session: k.session, body: {job_id: k.job_id, attempt_id: k.attempt_id, transcript: transcriptOf('claude-opus-5-5'), transcript_approved: true,
    report_md: 'Test: no change; the entry stays open for a later upkeep.', state_update: {through_return_id: Number(through ?? 0)}}});
  assert.equal(left.status, 200, JSON.stringify(await left.json()).slice(0, 300));
  assert.equal((await lanesNeedingUpkeep(pid, slug)).some(l => l.slug === S.lane), false, 'an entry left open does not make the lane due again');
  assert.equal((await one(`SELECT count(*)::int AS n FROM lane_state_entries WHERE lane_id = $1 AND status = 'unverified'`, [laneId])).n, 1, 'and it stays open');
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

test('every kind of brief carries the state of the art inline under its title: research, study, review, packaged review, triage, a job with no lane, chat, department', async () => {
  // A verified summary on the lane, so the md5 playbook heading is there to find.
  const lane = await one(`SELECT id, slug FROM lanes WHERE problem_id = $1 AND slug = $2`, [pid, S.lane]);
  await q(`INSERT INTO lane_states (lane_id, problem_id, summary_md, version, through_return_id, updated_by, updated_model) VALUES ($1,$2,$3,1,0,$4,'test')
    ON CONFLICT (lane_id) DO UPDATE SET summary_md = EXCLUDED.summary_md, version = greatest(lane_states.version, 1)`, [lane.id, pid, '#### Start here: the fastest known way, by machine\n\nTest: the AVX2 kernel.\n\n#### Best results\n\nTest.', people.owner.id]);
  await q(`INSERT INTO lane_state_entries (problem_id, lane_id, body_md, hardware, throughput, source_return_id, user_id) VALUES ($1,$2,'Test: an open entry for the briefs, with its numbers.','Test: M1','1e8/s',$3,$4)`, [pid, lane.id, S.source, people.c.id]);
  const pending = async (author, model, extra = {}) => Number((await one(`INSERT INTO returns (problem_id, lane_id, type, user_id, model, provider, report_md, transcript, status, verification_plan) VALUES ($1,$2,'explore',$3,$4,'p','Test: a claim','Test','pending',$5) RETURNING id`, [pid, lane.id, author, model, extra.plan ? JSON.stringify(extra.plan) : null])).id);
  const job = async (type, fields = {}) => Number((await one(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, min_tier, budget_hours, compute_hint, parent_return_id, origin_key, requires_trust)
    VALUES ($1,$2,$3,$4,'Test: the task text.',99,1,'{}',$5,$6,$7) RETURNING id`, [pid, fields.laneless ? null : lane.id, type, `Test ${type} brief`, fields.parent ?? null, fields.origin ?? null, !!fields.trust])).id);
  const take = async (who, id, model) => { const r = await call(who, 'GET', `/start?job=${id}`, {model}); const j = await r.json(); assert.equal(r.status, 200, `${id}: ${JSON.stringify(j).slice(0, 300)}`); await call(who, 'POST', '/release', {session: j.session, model, body: {job_id: j.job_id, attempt_id: j.attempt_id, note: 'Test: brief read'}}); return j; };
  const kinds = [
    ['explore (research, pursuit and rescue use the same path)', 'c', await job('explore'), 'claude-fable-5-1'],
    ['challenge study', 'c', await job('explore', {origin: `challenge:md5-mirror-ascii32-v1:study:test-${tag}`}), 'claude-fable-5-1'],
    ['review', 'owner', await job('review', {parent: await pending(people.astra.id, 'gpt-6-astra')}), 'claude-opus-5-5'],
    ['triage', 'c', await job('triage', {parent: await pending(people.astra.id, 'gpt-6-astra')}), 'claude-fable-5-1'],
    ['review of a packaged return (its brief is recomposed when served)', 'owner', await job('review', {parent: await pending(people.astra.id, 'gpt-6-astra', {plan: {schema_version:1,manifest:[{path:'check.py',sha256:'a'.repeat(64),role:'checker'},{path:'input.json',sha256:'b'.repeat(64),role:'target'}],targets:['input.json'],coverage_md:'Every supplied record.',comparison:'Exact integer equality.',availability:{status:'complete',details:'All bytes in manifest.',network:false,required_sources:[]},claim:'Test: the finite count is four.',scope:'The supplied finite set.',assumptions:'Exact integer arithmetic.',checker:'a'.repeat(64),inputs:['b'.repeat(64)],environment:'Python 3.12',command:'python check.py input.json',expected:'4',supports:'Counts every member.',coverage:'decisive',cost:{minutes:1,cpu_hours:0.01,ram_gb:1,judgment_minutes:15}}})}), 'claude-opus-5-5'],
  ];
  const {BASELINE_DUTY, BASELINE_REVIEW_DUTY} = await import('../src/lib/research-guidance.ts');
  for (const [kind, who, id, model] of kinds) {
    const md = (await take(who, id, model)).brief_md;
    assertStateOnTop(md, kind);
    // The baseline and ablation duty (Sakana lesson #6, Oct 16 2026) is served by /start: to the author in every brief, to the reviewer as rubric.
    assert.ok(md.includes(BASELINE_DUTY), `${kind}: the served brief carries the baseline duty`);
    if (kind.startsWith('review')) assert.ok(md.includes(BASELINE_REVIEW_DUTY), `${kind}: the served review brief carries the reviewer's baseline duty`);
  }
  const laneless = await take('c', await job('explore', {laneless: true}), 'claude-fable-5-1');
  assertStateOnTop(laneless.brief_md, 'a job with no lane');
  assert.match(laneless.brief_md, new RegExp(`State of the art: .*\\(\`${S.lane}\`\\)`), 'a job with no lane carries every lane\'s document inline, not a link');
  // The chat brief and a department's compact brief are built from the same served markdown.
  const section = await stateBrief(pid, slug, Number(lane.id), `${base}/projects/${slug}`);
  const row = {id: 1, type: 'explore', title: 'Test', brief_md: 'Test: the task.', git_ref: 'main', compute_hint: {}, budget_hours: 1, repo_url: '', attempt_id: 'a', lane_slug: S.lane};
  assertStateOnTop(insertStateSection(renderChatBrief(row, base, {id: 's', host: 'chatgpt', handle: 'x'}), section), 'chat');
  const full = insertStateSection(renderBrief(row, base, {id: 's', jobs: 0, max: null, maxHours: 1, compute: 'test', transcriptPreapproved: true}), section);
  assertStateOnTop(compactDepartmentBrief(full, row, {length: 'one task', jobs: 0, max: null, compute: 'test', disk: 5, subagents: 'allowed'}, null), 'department compact');
});

test('a brief front-loads what the summary does not hold yet: a summary past 6,000 characters whole, the accepted returns since by id and link, twenty open entries, and the rejected returns until an upkeep has read them', async () => {
  // Chris, Oct 13 2026 (#sah-brief-state-frontload-gaps): "We want to ensure all learnings we have are front loaded". On the live site every
  // summary sat at the 6,000 cap, the returns not folded in were a count, entries past the newest 8 were a link, and a rejected return
  // reached neither a brief nor an upkeep.
  const lane = await one(`SELECT id, slug, title, problem_id FROM lanes WHERE problem_id = $1 AND slug = $2`, [pid, S.lane]);
  const ref = {id: Number(lane.id), slug: lane.slug, title: lane.title, problem_id: pid}, P = `${base}/projects/${slug}`;
  const ret = async (status, report) => Number((await one(`INSERT INTO returns (problem_id, lane_id, type, user_id, model, provider, report_md, transcript, status, final_rung) VALUES ($1,$2,'explore',$3,'claude-fable-5-1','anthropic',$4,'Test',$5,'MEASURED') RETURNING id`, [pid, lane.id, people.c.id, report, status])).id);
  // 1. The cap: 11,000 characters are kept and served whole; one past the cap is refused with the cap named.
  assert.equal(SUMMARY_MAX, 12000);
  const long = `#### Start here: the fastest known way, by machine\n\n${'Test: a learning that must stay. '.repeat(330)}\n\n#### Dead ends (slow or refuted)\n\nTest: the last line of a long summary.`;
  assert.ok(long.length > 10000 && long.length <= SUMMARY_MAX, String(long.length));
  const through = Number((await one(`SELECT coalesce(max(id), 0) AS m FROM returns WHERE lane_id = $1 AND status = 'accepted' AND NOT provisional`, [lane.id])).m);
  await applyStateUpdate(pid, ref, {id: people.owner.id, model: 'claude-opus-5-5'}, parseStateUpdate({summary_md: long, through_return_id: through}), null);
  assert.throws(() => parseStateUpdate({summary_md: 'x'.repeat(SUMMARY_MAX + 1)}), /at most 12000 characters/);
  let brief = await stateBrief(pid, slug, ref.id, P);
  assert.ok(brief.includes('Test: the last line of a long summary.') && !brief.includes('(continued at'), 'a summary past 6,000 characters is in the brief whole');
  assert.doesNotMatch(brief, /not in the summary yet/, 'nothing unfolded: no list');
  // 2. Accepted returns since: each by id and link, under the stamp and above the summary.
  const accepted = [await ret('accepted', 'Test: the first result the summary lacks.'), await ret('accepted', 'Test: the second.'), await ret('accepted', 'Test: the third.')];
  // 4. A rejected return, with the trusted review's reason.
  const failed = await ret('rejected', 'Test: an approach that was refuted on review.');
  const rj = Number((await one(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, min_tier, budget_hours, compute_hint, parent_return_id, status) VALUES ($1,$2,'review','Test: review of a refuted return','Test',99,1,'{}',$3,'done') RETURNING id`, [pid, lane.id, failed])).id);
  await q(`INSERT INTO reviews (return_id, review_job_id, user_id, model, provider, verdict, notes_md, trusted, reject_reason) VALUES ($1,$2,$3,'claude-opus-5-5','anthropic','reject','Test: the bound fails at n = 3.',true,'refuted')`, [failed, rj, people.owner.id]);
  await q(`INSERT INTO return_decisions (return_id, status, by) VALUES ($1,'rejected','trusted')`, [failed]);
  // 3. Entries: twelve more than the one or two already open, all inline (the old cut was 8).
  for (let i = 0; i < 12; i++) await q(`INSERT INTO lane_state_entries (problem_id, lane_id, body_md, hardware, throughput, source_return_id, user_id) VALUES ($1,$2,$3,'Test: M1','1e8/s',$4,$5)`, [pid, lane.id, `Test: open entry number ${i} for the larger inline allowance.`, S.source, people.c.id]);
  brief = await stateBrief(pid, slug, ref.id, P);
  const stamp = brief.indexOf('3 accepted return(s) since are not folded in yet'), body = brief.indexOf('Test: a learning that must stay.');
  assert.ok(stamp > 0 && body > stamp, brief.slice(0, 900));
  for (const id of accepted) { const at = brief.indexOf(`- #${id} (explore, @${people.c.handle}`); assert.ok(at > stamp && at < body && brief.slice(at, at + 400).includes(`${P}/return/${id}`), `accepted return #${id} is listed with its link under the stamp`); }
  const rejectedAt = brief.indexOf(`- #${failed} (explore, @${people.c.handle}, claude-fable-5-1; rejected as refuted), ${P}/return/${failed}: Test: an approach that was refuted on review.`);
  assert.ok(rejectedAt > brief.indexOf('Rejected, not in the summary yet (not results') && rejectedAt < body, 'the rejected return is listed as a lead on what failed, with the reason and its link');
  const open = Number((await one(`SELECT count(*)::int AS n FROM lane_state_entries WHERE lane_id = $1 AND status = 'unverified'`, [lane.id])).n);
  assert.ok(open > 8 && open <= 20, String(open));
  assert.equal((brief.match(/^- Entry \d+/gm) ?? []).length, open, 'every open entry is inline');
  assert.doesNotMatch(brief, /older entries at/);
  // The upkeep is handed the rejected return, and told what to do with it.
  const up = await upkeepBrief({lane_id: lane.id, brief_md: 'Due: test.', assigned_at: null}, {id: pid, slug}, P);
  assert.match(up, /^A routine trusted task, like a review:/, 'the upkeep brief still opens by saying what the work is');
  assert.match(up, /Dead ends come from rejected returns too/);
  assert.ok(up.includes(`### Rejected returns no upkeep has read (1)`) && up.includes(`- #${failed} (explore, @${people.c.handle}, claude-fable-5-1; rejected as refuted), ${P}/return/${failed}`), up.slice(-900));
  // Rejections decided since the last update count toward the upkeep with the accepted ones (5 by default): 3 + 1 are not enough, a second rejection is.
  await q(`DELETE FROM jobs WHERE lane_id = $1 AND type = 'upkeep' AND status IN ('queued','assigned')`, [lane.id]);
  await q(`UPDATE lane_states SET updated_at = now() - interval '1 minute' WHERE lane_id = $1`, [lane.id]);
  await q(`UPDATE lane_state_entries SET created_at = now() - interval '1 hour' WHERE lane_id = $1 AND status = 'unverified'`, [lane.id]);
  assert.equal((await lanesNeedingUpkeep(pid, slug)).some(l => l.slug === S.lane && /returns since/.test(l.why)), false, '3 accepted and 1 rejected: not due on returns yet');
  const failed2 = await ret('rejected', 'Test: a second approach that failed.');
  await q(`INSERT INTO return_decisions (return_id, status, by) VALUES ($1,'rejected','trusted')`, [failed2]);
  assert.ok((await lanesNeedingUpkeep(pid, slug)).some(l => l.slug === S.lane && /3 accepted and 2 rejected returns since the last update/.test(l.why)), JSON.stringify(await lanesNeedingUpkeep(pid, slug)));
  // An upkeep's return has read them: they leave the brief and the next upkeep, and no longer make the lane due. A direct write moves nothing.
  await applyStateUpdate(pid, ref, {id: people.owner.id, model: 'claude-opus-5-5'}, parseStateUpdate({through_return_id: accepted[2]}), null);
  assert.equal((await stateDoc(pid, slug, ref)).rejected.length, 2, 'a direct PUT read no list of rejected returns');
  const upkeepReturn = Number((await one(`INSERT INTO returns (problem_id, lane_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,$2,'upkeep',$3,'claude-opus-5-5','anthropic','Test: an upkeep that read the rejected returns.','Test','recorded') RETURNING id`, [pid, lane.id, people.owner.id])).id);
  await applyStateUpdate(pid, ref, {id: people.owner.id, model: 'claude-opus-5-5'}, parseStateUpdate({through_return_id: accepted[2]}), upkeepReturn);
  const doc = await stateDoc(pid, slug, ref);
  assert.equal(doc.rejected.length, 0); assert.equal(doc.unfolded.length, 0);
  assert.doesNotMatch(await stateBrief(pid, slug, ref.id, P), /not in the summary yet/);
  assert.match(await upkeepBrief({lane_id: lane.id, brief_md: 'Due: test.', assigned_at: null}, {id: pid, slug}, P), /### Rejected returns no upkeep has read \(0\)\n\nNone\./);
  assert.equal((await lanesNeedingUpkeep(pid, slug)).some(l => l.slug === S.lane && /returns since/.test(l.why)), false);
});
