import assert from 'node:assert/strict';
import {before, beforeEach, after, afterEach, test} from 'node:test';
import express from 'express';
import {randomUUID} from 'node:crypto';

// No timings on a task (Chris, Sep 19 2026: "we really should not put timings on reviews. A review needs to be allowed to take as
// long as it needs to. Same with original tasks. Time limiting a per task leads to all kinds of miss behavior like agent stopping in
// the middle of working"). The brief states no budget and no deadline; the only clock is silence, and every request moves it.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = 'http://localhost:0';
const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job, ABANDON_AFTER_MIN} = await import('../src/routes/job.ts');
let server, base, uid, other, token, otherToken, pid, slug;
const tag = `notime-${Date.now().toString(36)}`;

before(async () => {
  await migrate();
  uid = Number((await one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), tag, TERMS_VERSION])).id);
  other = Number((await one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), tag + '-o', TERMS_VERSION])).id);
  token = await issueToken(uid); otherToken = await issueToken(other);
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job);
  app.use((error, req, res, next) => res.status(500).json({error: error.message}));
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
});
beforeEach(async () => {
  slug = tag + '-' + randomUUID().slice(0, 8);
  pid = Number((await one(`INSERT INTO problems (slug,name,repo_url,status_md,discovery_share) VALUES ($1,'No-time test','https://example.org/r','open',0) RETURNING id`, [slug])).id);
  await q(`INSERT INTO channels (problem_id,path,title) VALUES ($1,'','Project')`, [pid]);
  base = `http://127.0.0.1:${server.address().port}/projects/${slug}`;
});
afterEach(async () => {
  await q(`DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE problem_id=$1)`, [pid]);
  await q(`DELETE FROM channel_members WHERE channel_id IN (SELECT id FROM channels WHERE problem_id=$1)`, [pid]);
  await q(`DELETE FROM reviews WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`, [pid]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`, [pid]);
  await q(`UPDATE returns SET job_id=NULL WHERE problem_id=$1`, [pid]);
  await q(`DELETE FROM assignment_attempts WHERE problem_id=$1`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id=$1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id=$1`, [pid]);
  for (const table of ['sessions', 'pool', 'channels']) await q(`DELETE FROM ${table} WHERE problem_id=$1`, [pid]);
  await q(`DELETE FROM problems WHERE id=$1`, [pid]);
});
after(async () => {
  await new Promise(r => server.close(r));
  for (const table of ['tokens', 'reputation']) await q(`DELETE FROM ${table} WHERE user_id=ANY($1)`, [[uid, other]]);
  await q(`DELETE FROM users WHERE id=ANY($1)`, [[uid, other]]);
  await pool.end();
});
async function call(path, {method = 'GET', session, attempt, launch, model = 'claude-opus-5', effort = 'high', body, who = token} = {}) {
  const h = {authorization: `Bearer ${who}`, accept: 'application/json', 'content-type': 'application/json'};
  if (model) h['x-model'] = model; if (effort) h['x-effort'] = effort; if (session) h['x-session'] = session; if (attempt) h['x-attempt'] = attempt; if (launch) h['x-launch-id'] = launch;
  const res = await fetch(base + path, {method, headers: h, body: body ? JSON.stringify(body) : undefined});
  return {status: res.status, body: await res.json()};
}
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const minutesFromNow = async id => Number((await one(`SELECT extract(epoch FROM (expires_at - now()))/60 AS m FROM jobs WHERE id=$1`, [id])).m);

test('an assignment carries no time budget and no deadline in its brief; the review brief says the same', async () => {
  await q(`INSERT INTO jobs (problem_id,type,title,brief_md,git_ref,budget_hours,min_tier,purpose) VALUES ($1,'source','Find the evidence','Find it.','main',3,99,'work')`, [pid]);
  const a = ok(await call('/start?share=0', {launch: randomUUID()}));
  assert.equal(a.type, 'source');
  assert.match(a.brief_md, /there is no time budget or deadline on this assignment/);
  assert.match(a.brief_md, /There is no time limit on an assignment/);
  assert.doesNotMatch(a.brief_md, /Budget:|Expires:|h of your time|your person allows up to \d/);
  assert.match(a.brief_md, new RegExp(`makes no request for ${ABANDON_AFTER_MIN} minutes is treated as stopped`), 'the only clock is silence, and the brief says so');
  const ret = await one(`INSERT INTO returns (problem_id,type,user_id,model,provider,report_md,transcript,status) VALUES ($1,'measure',$2,'deepseek-v4-flash','deepseek','A table.','t','pending') RETURNING id`, [pid, other]);
  const {spawnReviews} = await import('../src/routes/job.ts');
  await spawnReviews(Number(ret.id), pid, null, 1);
  const review = await one(`SELECT brief_md FROM jobs WHERE parent_return_id=$1 AND type='review'`, [ret.id]);
  assert.match(review.brief_md, /no time budget or deadline on a review/);
  assert.doesNotMatch(review.brief_md, /Budget \d|in budget|within the budget|inside the budget/);
  assert.match(review.brief_md, /unverifiable \(it cannot be checked with what was supplied\)/);
  assert.match(review.brief_md, /reject as unverifiable and say what (a checkable return would need|is missing)/);
});

test('the only clock is silence: the hand-back moment is the abandonment window, and every request of the session moves it', async () => {
  await q(`INSERT INTO jobs (problem_id,type,title,brief_md,git_ref,budget_hours,min_tier,purpose) VALUES ($1,'source','Find the evidence','Find it.','main',0.25,99,'work')`, [pid]);
  const a = ok(await call('/start?share=0', {launch: randomUUID()}));
  const first = await minutesFromNow(a.job_id);
  assert.ok(first > ABANDON_AFTER_MIN - 2 && first <= ABANDON_AFTER_MIN, `a quarter-hour job is not handed back after half an hour: ${first} minutes`);
  await q(`UPDATE jobs SET expires_at = now() + interval '5 minutes' WHERE id=$1`, [a.job_id]);
  ok(await call('/sessions', {session: a.session}));   // any request with X-Session
  const after = await minutesFromNow(a.job_id);
  assert.ok(after > ABANDON_AFTER_MIN - 2, `a request moved the moment forward: ${after} minutes`);
  // Another handle's request never touches it.
  await q(`UPDATE jobs SET expires_at = now() + interval '5 minutes' WHERE id=$1`, [a.job_id]);
  const o = ok(await call('/start?share=0', {launch: randomUUID(), who: otherToken}));
  ok(await call('/sessions', {session: o.session, who: otherToken}));
  assert.ok((await minutesFromNow(a.job_id)) < 6, 'only the holding session moves its own clock');
  // Silence hands it back on the next sweep, with the reason.
  await q(`UPDATE jobs SET expires_at = now() - interval '1 minute' WHERE id=$1`, [a.job_id]);
  await q(`UPDATE sessions SET last_seen = now() - ($2::int * interval '1 minute') - interval '1 minute' WHERE id=$1`, [a.session, ABANDON_AFTER_MIN]);
  ok(await call('/release', {method: 'POST', session: o.session, attempt: o.attempt_id, who: otherToken, body: {job_id: o.job_id, note: 'test'}}));
  ok(await call('/start?share=0', {launch: randomUUID(), who: otherToken})).job_id;   // a /start of the project runs the sweep
  const j = await one(`SELECT status, assigned_session, last_release_note FROM jobs WHERE id=$1`, [a.job_id]);
  assert.notEqual(j.assigned_session, a.session, `handed back (and possibly taken by the sweeping session): ${JSON.stringify(j)}`);
  assert.match(String(j.last_release_note), /abandoned: no request from the agent for \d+ minutes/);
});
