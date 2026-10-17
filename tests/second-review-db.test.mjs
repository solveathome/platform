import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import express from 'express';
import {randomUUID} from 'node:crypto';

// Blind second review end to end (Oct 16 2026, src/lib/second-review.ts): a final acceptance is drawn and recorded; a sampled one
// gets one review job that only another family on another handle is dealt; the holder is not shown the first verdict anywhere in
// the API; the verdict is checked against the sending model, decides nothing, and a disagreement queues an ordinary review.
// Real Postgres; everything created is deleted, and a residue check fails the run.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = 'http://localhost:0';
delete process.env.SECOND_REVIEW_RATE;
const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job, resolveReturn, backfillSecondReviews} = await import('../src/routes/job.ts');
const {board} = await import('../src/routes/board.ts');
const {secondReviewDraw, secondReviewStats} = await import('../src/lib/second-review.ts');
const reputation = await import('../src/lib/reputation.ts');

const tag = `second-review-${Date.now().toString(36)}`;
const MARK = `first-reviewer-note-${randomUUID().slice(0, 8)}`;
const ids = {}, tokens = {};
let server, base, pid, slug;

before(async () => {
  await migrate();
  for (const name of ['author', 'first', 'second', 'third']) {
    ids[name] = Number((await one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [940_000_000 + Math.floor(Math.random() * 1e7), `${tag}-${name}`, TERMS_VERSION])).id);
    tokens[name] = await issueToken(ids[name]);
    await reputation.ensure(ids[name]);
  }
  slug = tag;
  pid = Number((await one(`INSERT INTO problems (slug,name,repo_url,status_md,discovery_share) VALUES ($1,'Second review test','https://example.org/r','open',0) RETURNING id`, [slug])).id);
  await q(`INSERT INTO channels (problem_id,path,title) VALUES ($1,'','Project')`, [pid]);
  await q(`INSERT INTO project_roles (problem_id,user_id,role,granted_by,note) VALUES ($1,$2,'trusted',$2,'test')`, [pid, ids.first]);
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job); app.use('/projects/:slug', board);
  app.use((error, req, res, next) => res.status(500).json({error: error.message}));
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/projects/${slug}`;
});
after(async () => {
  await new Promise(r => server.close(r));
  await q(`DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE problem_id=$1)`, [pid]);
  await q(`DELETE FROM channel_members WHERE channel_id IN (SELECT id FROM channels WHERE problem_id=$1)`, [pid]);
  await q(`DELETE FROM credits WHERE problem_id=$1`, [pid]);
  await q(`DELETE FROM counted_entries WHERE user_id = ANY($1)`, [Object.values(ids)]);
  await q(`DELETE FROM second_reviews WHERE problem_id=$1`, [pid]);
  await q(`DELETE FROM reviews WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`, [pid]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`, [pid]);
  await q(`UPDATE returns SET job_id=NULL WHERE problem_id=$1`, [pid]);
  await q(`DELETE FROM assignment_attempts WHERE problem_id=$1`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id=$1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id=$1`, [pid]);
  for (const table of ['project_roles', 'sessions', 'pool', 'channels', 'lanes']) await q(`DELETE FROM ${table} WHERE problem_id=$1`, [pid]);
  await q(`DELETE FROM problems WHERE id=$1`, [pid]);
  for (const table of ['tokens', 'reputation']) await q(`DELETE FROM ${table} WHERE user_id=ANY($1)`, [Object.values(ids)]);
  await q(`DELETE FROM users WHERE id=ANY($1)`, [Object.values(ids)]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE id = ANY($1)) + (SELECT count(*) FROM problems WHERE id = $2) + (SELECT count(*) FROM second_reviews WHERE problem_id = $2) + (SELECT count(*) FROM jobs WHERE problem_id = $2) AS n`, [Object.values(ids), pid]);
  await pool.end();
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

async function call(path, {method = 'GET', who, model, effort = 'high', session, attempt, launch, body} = {}) {
  const h = {authorization: `Bearer ${tokens[who]}`, accept: 'application/json', 'content-type': 'application/json'};
  if (model) h['x-model'] = model; if (effort) h['x-effort'] = effort; if (session) h['x-session'] = session; if (attempt) h['x-attempt'] = attempt; if (launch) h['x-launch-id'] = launch;
  const res = await fetch(base + path, {method, headers: h, body: body ? JSON.stringify(body) : undefined});
  const text = await res.text();
  return {status: res.status, text, body: text ? JSON.parse(text) : null};
}
const start = async (who, model) => { const r = await call('/start?share=0', {who, model, launch: randomUUID()}); assert.equal(r.status, 200, r.text); return {...r.body, _as: {who, model}, _text: r.text}; };
const release = (a) => call('/release', {method: 'POST', ...a._as, session: a.session, attempt: a.attempt_id, body: {job_id: a.job_id, note: 'test complete'}});

/** An accepted return: an Opus author, a trusted Opus review, decided by the ordinary resolver. */
async function acceptOne(id, authorModel = 'claude-opus-5-5') {
  const r = await one(`INSERT INTO returns (id, problem_id, type, user_id, model, provider, report_md, transcript, status, effort) VALUES ($3,$1,'direction',$2,$4,'anthropic','Return report: the gap statistic is exactly 3 at every fold to 41#.','t','pending','high') RETURNING id`, [pid, ids.author, id, authorModel]);
  await q(`INSERT INTO reviews (return_id, user_id, model, provider, verdict, rung, notes_md, weight, transcript, trusted, effort) VALUES ($1,$2,'claude-opus-5-5','anthropic','accept','verified',$3,1,'',true,'high')`, [r.id, ids.first, MARK]);
  await resolveReturn(Number(r.id));
  assert.equal((await one(`SELECT status FROM returns WHERE id=$1`, [r.id])).status, 'accepted');
  return Number(r.id);
}

let sampledId;
test('every final acceptance is drawn and recorded; a sampled one gets exactly one blind review job, an unsampled one none', async () => {
  // Ids far above the sequence, chosen by their draw: one sampled, one not (an id is all the draw reads).
  let id = 900_000_000 + Math.floor(Math.random() * 1e7), unsampled;
  while (!sampledId || !unsampled) { if (secondReviewDraw(id) < 0.15) sampledId ??= id; else unsampled ??= id; id++; }
  const seen = [await acceptOne(sampledId), await acceptOne(unsampled)];
  for (const id of seen) {
    const row = await one(`SELECT * FROM second_reviews WHERE return_id=$1`, [id]);
    assert.ok(row, `return #${id} has its draw on record`);
    assert.equal(Number(row.draw), secondReviewDraw(id)); assert.equal(Number(row.rate), 0.15); assert.equal(row.rule, 'sha256-v1');
    assert.equal(row.sampled, id === sampledId);
    const jobs = await q(`SELECT id FROM jobs WHERE parent_return_id=$1 AND second_review_id IS NOT NULL`, [id]);
    assert.equal(jobs.length, id === sampledId ? 1 : 0);
  }
  const row = await one(`SELECT * FROM second_reviews WHERE return_id=$1`, [sampledId]);
  assert.deepEqual(row.first_families, ['anthropic']); assert.deepEqual(row.excluded_families, ['anthropic']);
  assert.deepEqual(row.excluded_users.map(Number).sort(), [ids.author, ids.first].sort());
  // Resolving again, or the backfill, draws nothing new.
  await resolveReturn(sampledId); await backfillSecondReviews(14);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM jobs WHERE parent_return_id=$1 AND second_review_id IS NOT NULL`, [sampledId])).n), 1);
});

test('the family rule: not the author, not the first reviewer, not the same family; another family on another handle takes it blind', async () => {
  for (const [who, model] of [['author', 'gpt-6-1-sol'], ['first', 'gpt-6-1-sol'], ['second', 'claude-opus-5-5']]) {
    const a = await start(who, model);
    assert.notEqual(a.assignment_reason?.policy, 'blind second review', `${who} on ${model} must not get it`);
    if (a.job_id) await release(a);
  }
  const a = await start('second', 'gpt-6-1-sol');
  assert.equal(a.assignment_reason?.policy, 'blind second review', a._text.slice(0, 400));
  assert.equal(Number(a.job_id), Number((await one(`SELECT job_id FROM second_reviews WHERE return_id=$1`, [sampledId])).job_id));
  // Blind: the assignment carries no first verdict, reviewer or note.
  assert.match(a.brief_md, /Blind second review of return #/);
  assert.match(a.brief_md, /not shown whether anyone reviewed it before/);
  for (const leak of [MARK, `${tag}-first`]) assert.equal(a._text.includes(leak), false, `the assignment leaks ${leak}`);
  // Blind in the API: the return without its decision, and its reviews refused, for the holder only.
  const mine = await call(`/return/${sampledId}`, {who: 'second', model: 'gpt-6-1-sol'});
  assert.equal(mine.status, 200);
  for (const k of ['status', 'final_rung', 'reviews', 'decisions', 'decision', 'review_history']) assert.equal(k in mine.body, false, k);
  for (const leak of [MARK, `${tag}-first`, '"accepted"']) assert.equal(mine.text.includes(leak), false, `GET /return leaks ${leak}`);
  assert.match(mine.body.report_md, /gap statistic/);
  const html = await fetch(`${base}/return/${sampledId}`, {headers: {authorization: `Bearer ${tokens.second}`, accept: 'text/html', 'x-model': 'gpt-6-1-sol'}});
  const htmlText = await html.text();
  assert.equal(htmlText.includes(MARK), false, 'the page leaks the first note to the holder');
  const reviewId = Number((await one(`SELECT id FROM reviews WHERE return_id=$1`, [sampledId])).id);
  assert.equal((await call(`/review/${reviewId}`, {who: 'second', model: 'gpt-6-1-sol'})).status, 403);
  const other = await call(`/return/${sampledId}`, {who: 'third', model: 'gpt-6-1-sol'});
  assert.equal(other.body.status, 'accepted', 'everyone else sees the record as before');
  assert.equal(other.text.includes(MARK), true);
  // The verdict is checked against the model that sends it (the session pins its model too). Were OpenAI excluded, it is refused.
  await q(`UPDATE second_reviews SET excluded_families = excluded_families || ARRAY['openai'] WHERE return_id=$1`, [sampledId]);
  const wrong = await call('/result', {method: 'POST', who: 'second', model: 'gpt-6-1-sol', session: a.session, attempt: a.attempt_id, body: {job_id: a.job_id, verdict: 'reject', notes_md: 'I read the claim and the fold table and found a gap.', transcript: 't', transcript_approved: true}});
  assert.equal(wrong.status, 403, wrong.text); assert.match(wrong.body.error, /another model family/);
  await q(`UPDATE second_reviews SET excluded_families = array_remove(excluded_families, 'openai') WHERE return_id=$1`, [sampledId]);
  // A disagreement: recorded, the return stays accepted, one ordinary review job for a trusted reviewer.
  const sent = await call('/result', {method: 'POST', who: 'second', model: 'gpt-6-1-sol', session: a.session, attempt: a.attempt_id, body: {job_id: a.job_id, verdict: 'reject', rung: 'conjectured', notes_md: 'I read the claim and the fold table: fold 37# is not covered by the stated check.', transcript: 't', transcript_approved: true}});
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.body.agrees, false); assert.ok(sent.body.followup_review_job_id);
  assert.equal((await one(`SELECT status FROM returns WHERE id=$1`, [sampledId])).status, 'accepted', 'the second verdict decides nothing');
  assert.equal(Number((await one(`SELECT count(*) AS n FROM reviews WHERE return_id=$1`, [sampledId])).n), 1, 'it is not a vote');
  const follow = await one(`SELECT type, status, second_review_id, brief_md FROM jobs WHERE id=$1`, [sent.body.followup_review_job_id]);
  assert.equal(follow.type, 'review'); assert.equal(follow.status, 'queued'); assert.equal(follow.second_review_id, null);
  assert.match(follow.brief_md, /fold 37# is not covered/);
  const row = await one(`SELECT verdict, family, agrees, user_id FROM second_reviews WHERE return_id=$1`, [sampledId]);
  assert.deepEqual([row.verdict, row.family, row.agrees, Number(row.user_id)], ['reject', 'openai', false, ids.second]);
  // Once sent, the holder sees the record again.
  assert.equal((await call(`/return/${sampledId}`, {who: 'second', model: 'gpt-6-1-sol'})).body.status, 'accepted');
});

test('the board publishes the rate from the stored rows', async () => {
  const s = await secondReviewStats(pid, slug);
  assert.equal(s.checked, 1); assert.equal(s.agreed, 0); assert.equal(s.agreement_rate, 0); assert.equal(s.waiting, 0);
  assert.deepEqual(s.pairs.map((p) => [p.first, p.second, p.checked]), [['anthropic', 'openai', 1]]);
  const json = await (await fetch(`${base}/board?format=json`)).json();
  assert.equal(json.second_review.checked, 1);
  const page = await (await fetch(`${base}/board`, {headers: {accept: 'text/html'}})).text();
  assert.match(page, /Blind second review/); assert.match(page, /Anthropic \(Claude\)/); assert.match(page, /OpenAI \(GPT\)/);
});

test('a session that is not trusted takes turns: a blind second review at an even streak, a waiting triage at an odd one', async () => {
  // Oct 18 2026 (#sah-blind-review-returns-check): with triage always ahead, a tier-1 GPT session eligible for 36 blind reviews was
  // dealt only triages and research. The run of four now alternates, and each falls back to the other.
  process.env.REVIEW_TRIAGE_MIN_TIER = '2';
  try {
    let id = 910_000_000 + Math.floor(Math.random() * 1e7), blindId;
    while (!blindId) { if (secondReviewDraw(id) < 0.15) blindId = id; id++; }
    await acceptOne(blindId);
    const pending = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, effort) VALUES ($1,'direction',$2,'claude-opus-5-5','anthropic','Return report: a pending claim about fold 43#.','t','high') RETURNING id`, [pid, ids.author]);
    await q(`INSERT INTO jobs (problem_id,type,title,brief_md,parent_return_id,min_tier,budget_hours) VALUES ($1,'triage','Triage return','brief',$2,2,0.25)`, [pid, pending.id]);
    const first = await start('third', 'gpt-6-1-sol');
    assert.equal(first.assignment_reason?.policy, 'blind second review', first._text.slice(0, 400));
    await release(first);
    const next = await start('third', 'gpt-6-1-sol');
    assert.equal(next.assignment_reason?.policy, 'review triage', next._text.slice(0, 400));
    if (next.job_id) await release(next);
  } finally { delete process.env.REVIEW_TRIAGE_MIN_TIER; }
});

test('a GLM return goes blind to another family: never to a GLM or Anthropic session, to a Muse (Meta) one on another handle', async () => {
  // Oct 18 2026 (#sah-lean-family-glm-muse): glm-5.3-flash and muse-spark had no family, so their returns excluded nothing of their
  // own kind and their sessions could take no blind review at all. A judgment review asks tier 1, so the test's own GLM and Muse ids
  // are tier 1 here: the GLM sessions are then kept off by their family alone.
  const glm = `glm-9-${tag}`, glm2 = `glm-8-${tag}`, muse = `muse-${tag}`, tiers = [];
  for (const [model, provider] of [[glm, 'zhipu'], [glm2, 'zhipu'], [muse, 'meta']])
    if (await one(`INSERT INTO model_tiers (model, provider, tier, note) VALUES ($1,$2,1,'second review test') ON CONFLICT (model) DO NOTHING RETURNING model`, [model, provider])) tiers.push(model);
  try {
    let id = 920_000_000 + Math.floor(Math.random() * 1e7), glmId;
    while (!glmId) { if (secondReviewDraw(id) < 0.15) glmId = id; id++; }
    await q(`UPDATE jobs SET status='expired' WHERE problem_id=$1 AND status='queued'`, [pid]);
    await acceptOne(glmId, glm);
    const row = await one(`SELECT * FROM second_reviews WHERE return_id=$1`, [glmId]);
    assert.deepEqual(row.excluded_families, ['anthropic', 'zhipu']);
    for (const [who, model] of [['second', glm2], ['third', glm], ['third', 'claude-opus-5-5']]) {
      const a = await start(who, model);
      assert.notEqual(a.assignment_reason?.policy, 'blind second review', `${who} on ${model} must not get it`);
      if (a.job_id) await release(a);
    }
    const a = await start('third', muse);
    assert.equal(a.assignment_reason?.policy, 'blind second review', a._text.slice(0, 400));
    assert.equal(Number(a.job_id), Number(row.job_id));
    const sent = await call('/result', {method: 'POST', who: 'third', model: muse, session: a.session, attempt: a.attempt_id, body: {job_id: a.job_id, verdict: 'accept', rung: 'verified', notes_md: 'I reran the fold table to 41# and the gap statistic is 3 at every fold.', transcript: 't', transcript_approved: true}});
    assert.equal(sent.status, 200, sent.text);
    assert.equal((await one(`SELECT family FROM second_reviews WHERE return_id=$1`, [glmId])).family, 'meta');
  } finally { await q(`DELETE FROM model_tiers WHERE model = ANY($1)`, [tiers]); }
});
