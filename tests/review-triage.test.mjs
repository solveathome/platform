import assert from 'node:assert/strict';
import {before, beforeEach, after, afterEach, test} from 'node:test';
import express from 'express';
import {randomUUID} from 'node:crypto';

// Review triage (Chris, Sep 18 2026, #sah-review-only-meaningful: "let a tier 2 agent do a first review to see if it's worth
// escalating"). A return that asks for review first gets one bounded triage assignment; a trusted verdict is spent only where
// the first reader says it would change the record. Trusted-only verdicts and never-your-own-return do not move.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = 'http://localhost:0';
process.env.REVIEW_QUEUE_NOTE_FROM = '2';
const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job, composeTriageBrief} = await import('../src/routes/job.ts');
const {reviewTriage} = await import('../src/lib/scheduler.ts');
let server, base, author, triager, second, trusted, tokens = {}, pid, slug;
const tag = `triage-${Date.now().toString(36)}`;

before(async () => {
  await migrate(); await migrate();
  for (const [name, handle] of [['author', tag], ['triager', tag + '-t1'], ['second', tag + '-t2'], ['trusted', tag + '-tr']]) {
    const id = Number((await one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), handle, TERMS_VERSION])).id);
    tokens[name] = await issueToken(id);
    if (name === 'author') author = id; if (name === 'triager') triager = id; if (name === 'second') second = id; if (name === 'trusted') trusted = id;
  }
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job);
  app.use((error, req, res, next) => res.status(500).json({error: error.message}));
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
});
beforeEach(async () => {
  slug = tag + '-' + randomUUID().slice(0, 8);
  pid = Number((await one(`INSERT INTO problems (slug,name,repo_url,status_md,discovery_share) VALUES ($1,'Triage test','https://example.org/r','open',0) RETURNING id`, [slug])).id);
  await q(`INSERT INTO channels (problem_id,path,title) VALUES ($1,'','Project')`, [pid]);
  await q(`INSERT INTO project_roles (problem_id,user_id,role,granted_by,note) VALUES ($1,$2,'trusted',$2,'test')`, [pid, trusted]);
  base = `http://127.0.0.1:${server.address().port}/projects/${slug}`;
  process.env.REVIEW_TRIAGE_MIN_TIER = '2';
});
afterEach(async () => {
  delete process.env.REVIEW_TRIAGE_MIN_TIER;
  await q(`DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE problem_id=$1)`, [pid]);
  await q(`DELETE FROM channel_members WHERE channel_id IN (SELECT id FROM channels WHERE problem_id=$1)`, [pid]);
  await q(`DELETE FROM credits WHERE problem_id=$1`, [pid]);
  await q(`DELETE FROM counted_entries WHERE user_id = ANY($1)`, [[author, triager, second, trusted]]);
  await q(`DELETE FROM triages WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`, [pid]);
  await q(`DELETE FROM reviews WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`, [pid]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`, [pid]);
  await q(`DELETE FROM research_events WHERE route_id IN (SELECT id FROM research_routes WHERE problem_id=$1)`, [pid]).catch(() => {});
  await q(`UPDATE returns SET job_id=NULL WHERE problem_id=$1`, [pid]);
  await q(`DELETE FROM assignment_attempts WHERE problem_id=$1`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id=$1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id=$1`, [pid]);
  for (const table of ['project_roles', 'sessions', 'pool', 'channels', 'lanes']) await q(`DELETE FROM ${table} WHERE problem_id=$1`, [pid]);
  await q(`DELETE FROM problems WHERE id=$1`, [pid]);
});
after(async () => {
  await new Promise(r => server.close(r));
  for (const table of ['tokens', 'reputation']) await q(`DELETE FROM ${table} WHERE user_id=ANY($1)`, [[author, triager, second, trusted]]);
  await q(`DELETE FROM users WHERE id=ANY($1)`, [[author, triager, second, trusted]]);
  await pool.end();
});
async function call(path, {method = 'GET', session, attempt, launch, model = 'claude-opus-5', effort = 'high', body, who = tokens.author} = {}) {
  const h = {authorization: `Bearer ${who}`, accept: 'application/json', 'content-type': 'application/json'};
  if (model) h['x-model'] = model; if (effort) h['x-effort'] = effort; if (session) h['x-session'] = session;
  if (attempt) h['x-attempt'] = attempt; if (launch) h['x-launch-id'] = launch;
  const res = await fetch(base + path, {method, headers: h, body: body ? JSON.stringify(body) : undefined});
  return {status: res.status, body: await res.json()};
}
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const start = async opts => ({...ok(await call('/start?share=0', {launch: randomUUID(), ...opts})), _as: {who: opts.who, model: opts.model, effort: opts.effort}});
const release = async a => { const r = await call('/release', {method: 'POST', ...a._as, session: a.session, attempt: a.attempt_id, body: {job_id: a.job_id, note: 'test complete'}}); assert.equal(r.status, 200, `release: ${JSON.stringify(r.body)}`); return r; };
const answer = (a, body, who) => call('/result', {method: 'POST', ...(a._as ?? {}), session: a.session, attempt: a.attempt_id, who, body: {job_id: a.job_id, transcript: 't', transcript_approved: true, ...body}});
/** A self-assigned direction that asks for review: the plain way a return reaches the review queue. */
async function askForReview(who = tokens.author, model = 'deepseek-v4-flash') {
  return ok(await call('/result', {method: 'POST', who, model, effort: 'max', body: {type: 'direction', report_md: 'A bounded finding with a claim somebody could build on: the gap statistic is exactly 3 at every fold to 41#.', transcript: 't', transcript_approved: true, request_review: true}}));
}
const jobsOf = async (returnId, type) => q(`SELECT id, status, min_tier, budget_hours FROM jobs WHERE parent_return_id=$1 AND type=$2 ORDER BY id`, [returnId, type]);

test('the config: off unless the project or the environment sets it; the tier is checked', () => {
  delete process.env.REVIEW_TRIAGE_MIN_TIER;
  assert.equal(reviewTriage(slug), null, 'off by default');
  assert.deepEqual(reviewTriage(slug, {min_tier: 3}), {minTier: 3, budgetHours: 0.25});
  assert.equal(reviewTriage(slug, false), null, 'a project can switch it off in so many words');
  assert.throws(() => reviewTriage(slug, {min_tier: 0}), /min_tier/);
  process.env.REVIEW_TRIAGE_MIN_TIER = '2';
  assert.deepEqual(reviewTriage(slug), {minTier: 2, budgetHours: 0.25});
});

test('a return that asks for review gets a triage job, not a review job; off, it gets the review jobs as before', async () => {
  const r = await askForReview();
  assert.equal(r.triage_requested, true); assert.equal(r.reviews_requested, 0);
  assert.match(r.note, /Triage first/);
  const triageJobs = await jobsOf(r.return_id, 'triage'), reviewJobs = await jobsOf(r.return_id, 'review');
  assert.equal(triageJobs.length, 1); assert.equal(reviewJobs.length, 0);
  assert.equal(Number(triageJobs[0].min_tier), 2); assert.equal(Number(triageJobs[0].budget_hours), 0.25);
  const page = ok(await call(`/return/${r.return_id}?json=1`));
  assert.equal(page.in_triage, true); assert.equal(page.status, 'pending');
  delete process.env.REVIEW_TRIAGE_MIN_TIER;
  const plain = await askForReview(tokens.triager);
  assert.equal(plain.triage_requested, false); assert.ok(plain.reviews_requested > 0);
  assert.equal((await jobsOf(plain.return_id, 'triage')).length, 0);
  assert.ok((await jobsOf(plain.return_id, 'review')).length > 0);
});

test('who triages: tier 2 or better, never trusted, never the author\'s handle or model, never twice; a trusted session gets nothing to review until triage says yes', async () => {
  const r = await askForReview(tokens.author, 'deepseek-v4-flash');
  // The trusted reviewer finds no review: the return is in triage, and a trusted session never triages.
  const t = await start({who: tokens.trusted, model: 'claude-fable-5-1', effort: 'max'});
  assert.notEqual(t.type, 'triage'); assert.notEqual(t.type, 'review'); await release(t);
  // Tier 3 is below the triage tier here.
  const flash = await start({who: tokens.second, model: 'gemini-3.8-flash', effort: 'high'});
  assert.notEqual(flash.type, 'triage'); await release(flash);
  // The author's other agent, on another model, does not triage its own handle's return.
  const own = await start({who: tokens.author, model: 'claude-opus-5', effort: 'high'});
  assert.notEqual(own.type, 'triage'); await release(own);
  // Another handle on the author's model does not either (a model never reads its own kind first).
  const sameKind = await start({who: tokens.triager, model: 'deepseek-v4-flash', effort: 'max'});
  assert.notEqual(sameKind.type, 'triage'); await release(sameKind);
  // An Opus session of another handle takes it, ahead of its research, with the policy on the record.
  const a = await start({who: tokens.triager, model: 'claude-opus-5', effort: 'high'});
  assert.equal(a.type, 'triage', JSON.stringify(a.assignment_reason));
  assert.equal(a.assignment_reason.policy, 'review triage');
  assert.deepEqual(a.assignment_reason.review_triage, {min_tier: 2});
  assert.match(a.brief_md, /would a trusted verdict on this return change the record/);
  assert.match(a.brief_md, /"escalate": true \| false/);
  assert.match(a.brief_md, /cited by 0 returns of other handles/);
  await release(a);
  // A frontier model at a low thinking level works at tier 2 and may triage too.
  const low = await start({who: tokens.second, model: 'claude-fable-5-1', effort: 'medium'});
  assert.equal(low.type, 'triage', JSON.stringify(low.assignment_reason)); await release(low);
  // A trusted session at top effort is trusted by grant here: it reviews, never triages, even at tier 2 effort.
  const tr = await start({who: tokens.trusted, model: 'claude-opus-5', effort: 'high'});
  assert.notEqual(tr.type, 'triage'); await release(tr);
});

test('escalate: the review jobs are made and the review brief carries the triage note; the triager is paid tokens only', async () => {
  const r = await askForReview();
  const a = await start({who: tokens.triager, model: 'claude-opus-5', effort: 'high'});
  assert.equal(a.type, 'triage');
  const refused = await answer(a, {notes_md: 'A claim somebody would build on.'}, tokens.triager);
  assert.equal(refused.status, 400); assert.match(refused.body.error, /escalate/);
  const short = await answer(a, {escalate: true, notes_md: 'yes'}, tokens.triager);
  assert.equal(short.status, 400); assert.match(short.body.error, /notes_md/);
  const yes = ok(await answer(a, {escalate: true, notes_md: 'The exact-3 statistic is a finite claim the g2 lane builds on; a verdict fixes its rung.'}, tokens.triager));
  assert.equal(yes.escalated, true); assert.equal(yes.status, 'pending'); assert.ok(yes.reviews_requested > 0);
  const reviews = await jobsOf(r.return_id, 'review');
  assert.equal(reviews.length, yes.reviews_requested);
  const brief = (await one(`SELECT brief_md FROM jobs WHERE id=$1`, [reviews[0].id])).brief_md;
  assert.match(brief, /Triage \(a first read/); assert.match(brief, /said a trusted verdict would change the record: The exact-3 statistic/);
  assert.equal((await one(`SELECT status FROM jobs WHERE id=$1`, [a.job_id])).status, 'returned');
  const page = ok(await call(`/return/${r.return_id}?json=1`));
  assert.equal(page.in_triage, false); assert.equal(page.triage.length, 1); assert.equal(page.triage[0].escalate, true);
  assert.ok(page.decisions.some(d => d.by === 'triage' && d.status === 'pending'));
  const paid = await q(`SELECT kind, points, source_type FROM credits WHERE user_id=$1 AND problem_id=$2`, [triager, pid]);
  assert.ok(paid.every(c => c.kind === 'tokens' && c.source_type === 'triage'), JSON.stringify(paid));
  // The trusted reviewer now finds the review.
  const t = await start({who: tokens.trusted, model: 'claude-fable-5-1', effort: 'max'});
  assert.equal(t.type, 'review'); assert.equal(Number((await one(`SELECT parent_return_id FROM jobs WHERE id=$1`, [t.job_id])).parent_return_id), r.return_id);
  assert.match(t.brief_md, /Triage \(a first read/);
  await release(t);
  // One triage per person per return.
  assert.equal((await answer(a, {escalate: false, notes_md: 'Changing my mind after the fact is not a second triage.'}, tokens.triager)).status, 409);
});

test('no: the return is recorded as it stands, with the reason on its page; elevation with a note sends it to a different triager', async () => {
  const r = await askForReview();
  const a = await start({who: tokens.triager, model: 'claude-opus-5', effort: 'high'});
  const no = ok(await answer(a, {escalate: false, notes_md: 'A failed attempt: the report says the statistic did not hold past 23# and proposes nothing further.'}, tokens.triager));
  assert.equal(no.escalated, false); assert.equal(no.status, 'recorded'); assert.equal(no.reviews_requested, 0);
  assert.match(no.note, /recorded as it stands/);
  const ret = await one(`SELECT status, final_rung FROM returns WHERE id=$1`, [r.return_id]);
  assert.equal(ret.status, 'recorded'); assert.equal(ret.final_rung, 'recorded');
  assert.equal((await jobsOf(r.return_id, 'review')).length, 0, 'no review job was ever made');
  const page = ok(await call(`/return/${r.return_id}?json=1`));
  assert.ok(page.decisions.some(d => d.by === 'triage' && d.status === 'recorded' && /would not change the record/.test(d.note)));
  // Elevation puts it before a triager again, and the first triager is not offered it.
  const up = ok(await call(`/return/${r.return_id}/request-review`, {method: 'POST', who: tokens.second, body: {note: 'My return #0 builds on this statistic.'}}));
  assert.equal(up.triage_requested, true); assert.equal(up.reviews_requested, 0); assert.match(up.note_triage, /Triage first/);
  assert.equal((await one(`SELECT status FROM returns WHERE id=$1`, [r.return_id])).status, 'pending');
  const again = await start({who: tokens.triager, model: 'claude-opus-5', effort: 'high'});
  assert.notEqual(again.type, 'triage', 'the same person does not triage the same return twice'); await release(again);
  const other = await start({who: tokens.second, model: 'claude-opus-5', effort: 'high'});
  assert.equal(other.type, 'triage');
  assert.match(other.brief_md, /record so far: .*triage: Triage by @\S+ \(claude-opus-5\): a trusted verdict would not change the record/);
  const yes = ok(await answer(other, {escalate: true, notes_md: 'Somebody now builds on it: a verdict fixes what they build on.'}, tokens.second));
  assert.equal(yes.status, 'pending'); assert.ok((await jobsOf(r.return_id, 'review')).length > 0);
});

test('nothing reaches a trusted reviewer by itself: a triage nobody takes waits, however long', async () => {
  const r = await askForReview();
  const [t] = await jobsOf(r.return_id, 'triage');
  await q(`UPDATE jobs SET created_at = now() - interval '30 days' WHERE id=$1`, [t.id]);
  const s = await start({who: tokens.second, model: 'gemini-3.8-flash', effort: 'high'}); await release(s);   // a /start of the project runs every sweep
  assert.equal((await one(`SELECT status FROM jobs WHERE id=$1`, [t.id])).status, 'queued');
  assert.equal((await jobsOf(r.return_id, 'review')).length, 0, 'no review job was made');
  const tr = await start({who: tokens.trusted, model: 'claude-fable-5-1', effort: 'max'});
  assert.notEqual(tr.type, 'review'); await release(tr);
  assert.equal(ok(await call(`/return/${r.return_id}?json=1`)).in_triage, true);
});

test('a series read as one: a triage covers other returns of the same lane; one trusted review decides them all, and what it leaves out gets its own review', async () => {
  const lane = await one(`INSERT INTO lanes (problem_id,slug,title) VALUES ($1,'d','Direction D') RETURNING id`, [pid]);
  const inLane = (who, model) => ok(call('/result', {method: 'POST', who, model, effort: 'max', body: {type: 'direction', lane: 'd', report_md: 'One step of direction D: the shift family spans the stated interval at this fold.', transcript: 't', transcript_approved: true, request_review: true}}));
  const wait = async (who, model) => ok(await call('/result', {method: 'POST', who, model, effort: 'max', body: {type: 'direction', lane: 'd', report_md: 'One step of direction D: the shift family spans the stated interval at this fold.', transcript: 't', transcript_approved: true, request_review: true}}));
  const lead = await wait(tokens.author, 'deepseek-v4-flash');
  const two = await wait(tokens.author, 'deepseek-v4-flash');
  const three = await wait(tokens.second, 'gemini-3.8-flash');
  const elsewhere = await askForReview(tokens.author, 'deepseek-v4-flash');   // no lane: not part of the series
  const a = await start({who: tokens.triager, model: 'claude-opus-5', effort: 'high'});
  assert.equal(a.type, 'triage'); assert.equal(Number((await one(`SELECT parent_return_id FROM jobs WHERE id=$1`, [a.job_id])).parent_return_id), lead.return_id);
  assert.match(a.brief_md, /Other returns of the same lane waiting in triage/);
  assert.match(a.brief_md, new RegExp(`- #${two.return_id} by @`)); assert.match(a.brief_md, new RegExp(`- #${three.return_id} by @`));
  assert.doesNotMatch(a.brief_md, new RegExp(`- #${elsewhere.return_id} by @`));
  const yes = ok(await answer(a, {escalate: true, notes_md: 'Direction D as a whole: the three steps together bound the interval; one verdict settles the direction.', covers: [two.return_id, three.return_id, elsewhere.return_id, 999999]}, tokens.triager));
  assert.deepEqual(yes.covers, [two.return_id, three.return_id]);
  assert.ok(yes.warnings.some(w => new RegExp(`return #${elsewhere.return_id} not covered: is not of the same lane`).test(w)), JSON.stringify(yes.warnings));
  assert.ok(yes.warnings.some(w => /return #999999 not covered: not a return of this project/.test(w)));
  assert.equal((await jobsOf(lead.return_id, 'review')).length, yes.reviews_requested, 'the lead gets its usual review jobs (the consensus minimum for a plain direction), and nothing else does');
  for (const c of [two, three]) {
    assert.equal((await jobsOf(c.return_id, 'review')).length, 0, 'a covered return has no review of its own');
    const row = await one(`SELECT status, triage_lead FROM returns WHERE id=$1`, [c.return_id]);
    assert.equal(row.status, 'pending'); assert.equal(Number(row.triage_lead), lead.return_id);
    assert.equal((await jobsOf(c.return_id, 'triage'))[0].status, 'expired');
    assert.ok(await one(`SELECT 1 FROM triages WHERE return_id=$1 AND user_id=$2`, [c.return_id, triager]), 'the covered return carries the triage too');
  }
  const brief = (await one(`SELECT brief_md FROM jobs WHERE parent_return_id=$1 AND type='review'`, [lead.return_id])).brief_md;
  assert.match(brief, /This return leads a series the first reader read as one/); assert.match(brief, new RegExp(`- #${two.return_id} \\(direction\\)`)); assert.match(brief, /also_verdicts/);
  const tr = await start({who: tokens.trusted, model: 'claude-fable-5-1', effort: 'max'});
  assert.equal(tr.type, 'review'); assert.equal(Number((await one(`SELECT parent_return_id FROM jobs WHERE id=$1`, [tr.job_id])).parent_return_id), lead.return_id);
  const decided = ok(await answer(tr, {verdict: 'accept', rung: 'measured', notes_md: 'The interval bound holds at this fold; the series stands as measured.', also_verdicts: {[two.return_id]: {verdict: 'accept', rung: 'measured'}, [String(three.return_id)]: 'nonsense'}}, tokens.trusted));
  assert.equal(decided.outcome, 'accepted');
  assert.equal(decided.series[String(two.return_id)], 'accepted');
  assert.ok(decided.warnings.some(w => new RegExp(`return #${three.return_id}: verdict must be accept or reject`).test(w)), JSON.stringify(decided.warnings));
  assert.equal((await one(`SELECT status, final_rung FROM returns WHERE id=$1`, [two.return_id])).status, 'accepted');
  assert.equal((await one(`SELECT count(*)::int AS n FROM reviews WHERE return_id=$1 AND user_id=$2 AND trusted`, [two.return_id, trusted])).n, 1);
  // The one left out gets its own review now that the lead is decided.
  assert.equal((await one(`SELECT status FROM returns WHERE id=$1`, [three.return_id])).status, 'pending');
  assert.ok((await jobsOf(three.return_id, 'review')).length >= 1, 'its own review assignment');
  assert.ok((await q(`SELECT note FROM return_decisions WHERE return_id=$1`, [three.return_id])).some(d => /gave no verdict on this return/.test(d.note)));
  // A no over a series records the whole series with the reason.
  const skip = await start({who: tokens.second, model: 'claude-opus-5', effort: 'high'});   // the older return outside the lane is still in triage
  assert.equal(Number((await one(`SELECT parent_return_id FROM jobs WHERE id=$1`, [skip.job_id])).parent_return_id), elsewhere.return_id);
  ok(await answer(skip, {escalate: false, reason: 'known', notes_md: 'Restates what the closed-routes register already holds.'}, tokens.second));
  const four = await wait(tokens.author, 'deepseek-v4-flash'); const five = await wait(tokens.triager, 'gemini-3.8-flash');
  const b = await start({who: tokens.second, model: 'claude-opus-5', effort: 'high'});
  assert.equal(b.type, 'triage');
  const leadId = Number((await one(`SELECT parent_return_id FROM jobs WHERE id=$1`, [b.job_id])).parent_return_id);
  assert.equal(leadId, four.return_id);
  const no = ok(await answer(b, {escalate: false, reason: 'uninteresting', notes_md: 'Both restate the accepted bound at a smaller fold; nothing a verdict would change.', covers: [five.return_id]}, tokens.second));
  assert.equal(no.status, 'recorded'); assert.equal(no.reason, 'uninteresting'); assert.deepEqual(no.covers, [five.return_id]);
  for (const id of [leadId, five.return_id]) {
    assert.equal((await one(`SELECT status FROM returns WHERE id=$1`, [id])).status, 'recorded');
    assert.ok((await q(`SELECT note FROM return_decisions WHERE return_id=$1`, [id])).some(d => /uninteresting; recorded as it stands/.test(d.note)));
  }
  assert.equal((await jobsOf(five.return_id, 'triage'))[0].status, 'expired');
  assert.equal((await answer(b, {escalate: false, reason: 'boring', notes_md: 'A second answer with a made-up reason is refused before anything.'}, tokens.second)).status, 409);
});

test('a session that cannot review reads that the first read is its part; after a run of four triages it gets research', async () => {
  for (let i = 0; i < 5; i++) await askForReview(tokens.author, 'deepseek-v4-flash');
  await q(`INSERT INTO jobs (problem_id,type,title,brief_md,git_ref,budget_hours,min_tier,purpose) VALUES ($1,'source','Find the evidence','Find it.','main',1,99,'work')`, [pid]);
  const first = await start({who: tokens.triager, model: 'claude-opus-5', effort: 'high'});
  assert.equal(first.type, 'triage');
  assert.match(first.brief_md, /The review queue, and why this is your assignment/);
  assert.match(first.brief_md, /What is yours: the first read/);
  let a = first;
  for (let n = 1; n < 4; n++) {
    await q(`UPDATE jobs SET status='returned' WHERE id=$1`, [a.job_id]); await q(`UPDATE assignment_attempts SET status='completed' WHERE id=$1`, [a.attempt_id]);
    a = ok(await call('/start', {session: first.session, who: tokens.triager, model: 'claude-opus-5', effort: 'high'}));
    assert.equal(a.type, 'triage', `triage ${n + 1} of the run`);
  }
  await q(`UPDATE jobs SET status='returned' WHERE id=$1`, [a.job_id]); await q(`UPDATE assignment_attempts SET status='completed' WHERE id=$1`, [a.attempt_id]);
  const fifth = {...ok(await call('/start', {session: first.session, who: tokens.triager, model: 'claude-opus-5', effort: 'high'})), _as: first._as};
  assert.equal(fifth.type, 'source', 'after four first reads, research');
  await release(fifth);
});

test('the triage brief names what the record shows about the return', async () => {
  const r = await askForReview();
  const brief = await composeTriageBrief(r.return_id, {minTier: 2, budgetHours: 0.25});
  assert.match(brief, /type `direction`/); assert.match(brief, /no verification package/); assert.doesNotMatch(brief, /Budget/);
  assert.match(brief, /nothing goes before a trusted reviewer until a first reader has said it is worth it/); assert.match(brief, /"covers": \[/);
});

// Reviews only falls back to triage (Chris, Sep 23 2026, ask 387: "for a review only agent, if there is nothing to review because
// triage has not happened yet, do triage"). Under the review rules: never the author's model, the author's handle only by grant.
const reviewsOnly = async (who, model = 'claude-opus-5-5') => ({...ok(await call('/start?share=0&work=reviews', {launch: randomUUID(), who, model, effort: 'high'})), _as: {who, model, effort: 'high'}});
const ready = async (who, model = 'claude-opus-5-5') => ok(await call('/ready?work=reviews', {who, model, effort: 'high'}));

test('reviews only: with no review waiting a trusted session takes the triage, answers it, and then the review it opened', async () => {
  const r = await askForReview();
  assert.deepEqual(await ready(tokens.second), {ready: 1, urgency: 'normal', reviews: 0, triage: 1, trusted: true, tier: 1, facts: '0 reviews and 1 triage this agent may take (never its own model\'s returns, nor its handle\'s)'});
  const a = await reviewsOnly(tokens.second);
  assert.equal(a.type, 'triage'); assert.equal(a.assignment_reason.policy, 'reviews only: triage, no review waiting');
  ok(await answer(a, {escalate: true, notes_md: 'A finite claim a later route step would cite; a verdict decides it.'}, tokens.second));
  assert.equal((await jobsOf(r.return_id, 'review')).length > 0, true, 'the yes opened the review');
  const b = await reviewsOnly(tokens.trusted);
  assert.equal(b.type, 'review'); assert.equal(b.assignment_reason.policy, 'reviews only');
});

test('reviews only: never a triage of its own model; its own handle only by grant; nothing to take is still no_review_waiting and ready 0', async () => {
  await askForReview(tokens.author, 'claude-opus-5-5');
  const own = await reviewsOnly(tokens.second);
  assert.equal(own.state, 'no_review_waiting'); assert.equal(own.job_id, undefined);
  assert.equal((await ready(tokens.second)).ready, 0);
  const mine = await askForReview(tokens.second);
  assert.equal((await ready(tokens.second)).ready, 0, 'no grant: its own handle is not its to triage');
  await q(`UPDATE jobs SET status='expired' WHERE parent_return_id=$1`, [mine.return_id]);
  const granted = await askForReview(tokens.trusted);
  assert.equal((await ready(tokens.trusted)).triage, 1, 'a grant triages its own handle\'s return');
  const t = await reviewsOnly(tokens.trusted);
  assert.equal(t.type, 'triage'); assert.equal(Number((await one(`SELECT parent_return_id FROM jobs WHERE id=$1`, [t.job_id])).parent_return_id), Number(granted.return_id));
  ok(await answer(t, {escalate: false, reason: 'uninteresting', notes_md: 'A progress note that closes nothing; the record stands as it is.'}, tokens.trusted));
  assert.equal((await one(`SELECT status FROM returns WHERE id=$1`, [granted.return_id])).status, 'recorded');
});

test('ready: a session that is not trusted gets 0 for reviews only; work is all or reviews', async () => {
  await askForReview();
  const b = await ready(tokens.second, 'claude-opus-5');
  assert.equal(b.ready, 0); assert.equal(b.trusted, false);
  assert.equal((await call('/ready?work=everything', {who: tokens.second, model: 'claude-opus-5-5', effort: 'high'})).status, 400);
});
