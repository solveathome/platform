import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';

// Trusted reviewers decide; advisory reviews only ever decide provisionally. Real Postgres (TEST_DATABASE_URL);
// everything created is deleted and a residue check fails the run otherwise.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the trust tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job, spawnReviews} = await import('../src/routes/job.ts');
const {trust} = await import('../src/routes/trust.ts');
const roles = await import('../src/lib/roles.ts');
const {decide} = await import('../src/lib/consensus.ts');

const tag = `trust-test-${Date.now().toString(36)}`;
const slug = tag;
const people = {}; // handle -> {id, token}
let server, base, pid, returnId;

const mk = async (name) => {
  const handle = `${tag}-${name}`;
  const u = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [920_000_000 + Math.floor(Math.random() * 1e8), handle, TERMS_VERSION]);
  people[name] = {id: Number(u.id), handle, token: await issueToken(Number(u.id), 'trust-test')};
};

before(async () => {
  await migrate();
  for (const n of ['owner', 'author', 'trusted', 'adv1', 'adv2', 'adv3']) await mk(n);
  const p = await one(`INSERT INTO problems (slug, name, repo_url, status_md, researcher_user_id) VALUES ($1,$2,'https://example.org/r','open',$3) RETURNING id`, [slug, 'Trust test', people.owner.id]);
  pid = Number(p.id);
  await one(`INSERT INTO channels (problem_id, path, title) VALUES ($1,'','Project') RETURNING id`, [pid]);
  // A pending return by the author, with review jobs spawned the normal way.
  const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'source',$2,'claude-opus-5','anthropic','page 12 of the stated source','t','pending') RETURNING id`, [pid, people.author.id]);
  returnId = Number(r.id);
  await spawnReviews(returnId, pid, null, 3);
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job); app.use('/projects/:slug', trust);
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/projects/${slug}`;
});

after(async () => {
  server?.close();
  const ids = Object.values(people).map(p => p.id);
  await q(`DELETE FROM credits WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM messages WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM channel_members WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM reviews WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM sessions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM pool WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM trust_applications WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM project_roles WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM lanes WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM tokens WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM reputation WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE handle LIKE $1) + (SELECT count(*) FROM problems WHERE slug = $2) + (SELECT count(*) FROM project_roles WHERE problem_id = $3) AS n`, [`${tag}-%`, slug, pid]);
  await pool.end();
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const call = (who, method, path, {model, session, body, cookie, effort = 'max'} = {}) => fetch(base + path, {
  method, headers: {...(cookie ? {cookie: `sah_session=${people[who].token}`, 'sec-fetch-site': 'same-origin'} : {authorization: `Bearer ${people[who].token}`}), accept: 'application/json', 'content-type': 'application/json', ...(model ? {'x-model': model, 'x-effort': effort} : {}), ...(session ? {'x-session': session} : {})},
  body: body ? JSON.stringify(body) : undefined,
});
const okJson = async (r) => { const t = await r.text(); assert.equal(r.status, 200, t); return JSON.parse(t); };
const review = (verdict, extra = {}) => ({type: 'review', return_id: returnId, verdict, rung: 'measured', notes_md: `${verdict}: checked the page`, transcript: 't', transcript_approved: true, ...extra});

test('decide: trusted verdicts decide outright; a trusted tie waits; advisory alone is provisional', () => {
  const t = (verdict) => ({verdict, weight: 1, provider: 'p', trusted: true});
  const a = (verdict, provider = 'p') => ({verdict, weight: 1, provider, trusted: false});
  assert.deepEqual([decide([t('reject'), a('accept'), a('accept'), a('accept', 'q')]).status, decide([t('reject')]).provisional], ['rejected', false]);
  assert.equal(decide([t('accept'), t('reject')]).status, 'pending');
  const adv = decide([a('accept'), a('accept', 'q'), a('accept', 'r')]);
  assert.equal(adv.status, 'accepted'); assert.equal(adv.provisional, true);
});

test('review jobs are claimable by trusted handles only; contributors get no review assignment', async () => {
  const reg = async (who, model) => okJson(await call(who, 'POST', '/start', {model, body: {agreed: true, ai: {max_hours_per_assignment: 1}, transcript_preapproved: true}}));
  const c = await reg('adv1', 'claude-fable-5-1');
  assert.notEqual(c.type, 'review', 'a contributor was handed a review job');
  await roles.grant(pid, people.trusted.id, 'trusted', people.owner.id, 'test');
  // A frontier model at a low thinking level is tier 2 for the session: no judgment review for it, and the brief says why.
  const low = await okJson(await call('trusted', 'POST', '/start', {model: 'gpt-6-astra', effort: 'low', body: {agreed: true, ai: {max_hours_per_assignment: 1}, transcript_preapproved: true}}));
  assert.match(low.brief_md, /Tier this session: 2/);
  assert.ok(Number((await one(`SELECT min_tier FROM jobs WHERE id = $1`, [low.job_id])).min_tier) >= 2, 'a tier-1-only job went to a low-effort session');
  await call('trusted', 'POST', '/release', {model: 'gpt-6-astra', effort: 'low', session: low.session, body: {job_id: low.job_id, note: 'test'}});
  const t = await reg('trusted', 'gpt-6-astra');
  assert.equal(t.type, 'review');
  people.trusted.session = t.session; people.trusted.job = t.job_id;
  assert.equal((await one(`SELECT effort FROM sessions WHERE id = $1`, [t.session])).effort, 'max');
});

test('a trusted reviewer may review their own return; a contributor may not', async () => {
  const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'source',$2,'m','p','own work','t','pending') RETURNING id`, [pid, people.trusted.id]);
  const own = await call('trusted', 'POST', '/result', {model: 'gpt-6-astra', body: {type: 'review', return_id: Number(r.id), verdict: 'accept', rung: 'measured', notes_md: 'checked', transcript: 't', transcript_approved: true}});
  assert.equal(own.status, 200, await own.text());
  assert.equal((await one(`SELECT status, provisional FROM returns WHERE id = $1`, [r.id])).status, 'accepted');
  const r2 = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'source',$2,'m','p','own work','t','pending') RETURNING id`, [pid, people.adv2.id]);
  const notOwn = await call('adv2', 'POST', '/result', {model: 'claude-fable-5-1', body: {type: 'review', return_id: Number(r2.id), verdict: 'accept', rung: 'measured', notes_md: 'checked', transcript: 't', transcript_approved: true}});
  assert.equal(notOwn.status, 403);
});

test('three advisory reviews decide provisionally: nothing paid, review jobs still open', async () => {
  for (const [who, model] of [['adv1', 'claude-fable-5-1'], ['adv2', 'gpt-6-astra'], ['adv3', 'gemini-3-pro']]) {
    const r = await okJson(await call(who, 'POST', '/result', {model, body: review('accept')}));
    assert.equal(r.advisory, true);
  }
  const ret = await one(`SELECT status, provisional, final_rung FROM returns WHERE id = $1`, [returnId]);
  assert.deepEqual([ret.status, ret.provisional, ret.final_rung], ['accepted', true, 'measured']);
  const paid = await one(`SELECT count(*) AS c FROM credits WHERE source_type = 'return' AND source_id = $1 AND points > 0`, [String(returnId)]);
  assert.equal(Number(paid.c), 0, 'a provisional acceptance paid credit');
  const open = await one(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1 AND status IN ('queued','assigned')`, [returnId]);
  assert.ok(Number(open.c) >= 1, 'review jobs were closed by a provisional decision');
});

test('one trusted verdict makes it final, overriding the advisory view; a second trusted opinion reopens it as a tie', async () => {
  const r = await okJson(await call('trusted', 'POST', '/result', {model: 'gpt-6-astra', session: people.trusted.session, body: {job_id: people.trusted.job, verdict: 'reject', rung: null, notes_md: 'page 12 says the opposite', transcript: 't', transcript_approved: true}}));
  assert.equal(r.advisory, false); assert.equal(r.outcome, 'rejected');
  const ret = await one(`SELECT status, provisional FROM returns WHERE id = $1`, [returnId]);
  assert.deepEqual([ret.status, ret.provisional], ['rejected', false]);
  const open = await one(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1 AND status IN ('queued','assigned')`, [returnId]);
  assert.equal(Number(open.c), 0);
  const scored = await one(`SELECT agreed_with_outcome FROM reviews WHERE return_id = $1 AND user_id = $2`, [returnId, people.adv1.id]);
  assert.equal(scored.agreed_with_outcome, false);
  // A second trusted reviewer (the owner) disagrees: 1-1 among trusted reopens the return; the record keeps both states.
  const late = await okJson(await call('owner', 'POST', '/result', {model: 'claude-fable-5-1', body: review('accept')}));
  assert.match(late.outcome, /pending/);
  const now = await one(`SELECT status FROM returns WHERE id = $1`, [returnId]);
  assert.equal(now.status, 'pending');
  const hist = await q(`SELECT status, by FROM return_decisions WHERE return_id = $1 ORDER BY id`, [returnId]);
  assert.deepEqual(hist.map(h => [h.status, h.by]), [['accepted', 'advisory'], ['rejected', 'trusted'], ['pending', 'trusted']]);
  const jobs = await one(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1 AND status = 'queued'`, [returnId]);
  assert.ok(Number(jobs.c) >= 1, 'no fresh review job after the reopen');
});

test('a trusted reviewer can reopen a decided return with a note, and an upheld challenge reopens its target', async () => {
  // Settle the tie: a third trusted reviewer (adv1 gets trust for this) rejects; then reopen it explicitly.
  await roles.grant(pid, people.adv1.id, 'trusted', people.owner.id, 'test');
  const third = await okJson(await call('adv1', 'POST', '/result', {model: 'claude-fable-5-1', body: review('reject')}));
  assert.equal(third.status ?? third.outcome, 'rejected');
  const noNote = await call('trusted', 'POST', `/return/${returnId}/reopen`, {body: {}});
  assert.equal(noNote.status, 400);
  const notTrusted = await call('adv2', 'POST', `/return/${returnId}/reopen`, {body: {note: 'x'}});
  assert.equal(notTrusted.status, 403);
  await okJson(await call('trusted', 'POST', `/return/${returnId}/reopen`, {body: {note: 'the page reference was wrong edition; look again'}}));
  assert.equal((await one(`SELECT status FROM returns WHERE id = $1`, [returnId])).status, 'pending');
  // The reopener's new verdict replaces their old one; with owner accept + adv1 reject + trusted accept it is 2-1: accepted.
  const again = await okJson(await call('trusted', 'POST', '/result', {model: 'gpt-6-astra', body: review('accept', {notes_md: 'second edition has it on page 12'})}));
  assert.equal(again.outcome, 'accepted');
  const fin = await one(`SELECT status, provisional, effects_applied_at FROM returns WHERE id = $1`, [returnId]);
  assert.deepEqual([fin.status, fin.provisional, !!fin.effects_applied_at], ['accepted', false, true]);
  // An upheld challenge against this return reopens it.
  const ch = await okJson(await call('adv2', 'POST', '/result', {model: 'gemini-3-pro', body: {type: 'challenge', report_md: 'the cited page does not contain the claim in either edition', transcript: 't', transcript_approved: true, target: {kind: 'return', ref: String(returnId)}, human_md: 'That page says no such thing.', finding: 'holds'}}));
  const upheld = await okJson(await call('owner', 'POST', '/result', {model: 'claude-fable-5-1', body: {type: 'review', return_id: ch.return_id, verdict: 'accept', rung: 'measured', notes_md: 'checked both editions', transcript: 't', transcript_approved: true}}));
  assert.equal(upheld.outcome, 'accepted');
  assert.equal((await one(`SELECT status FROM returns WHERE id = $1`, [returnId])).status, 'pending');
  const last = await one(`SELECT by, note FROM return_decisions WHERE return_id = $1 ORDER BY id DESC LIMIT 1`, [returnId]);
  assert.equal(last.by, 'challenge');
  const paidTwice = await one(`SELECT count(*) AS c FROM credits WHERE source_type = 'return' AND source_id = $1 AND kind = 'result'`, [String(returnId)]);
  assert.equal(Number(paidTwice.c), 1, 'acceptance effects applied more than once');
});

test('applying happens on the site as a person; the owner decides with a public note and trust is granted', async () => {
  const viaAgent = await call('adv3', 'POST', '/trust/apply', {body: {statement: 'I have checked sieve bounds for a decade and will run Fable on this.', model: 'claude-fable-5-1', hours_per_week: 3}});
  assert.equal(viaAgent.status, 403);
  const applied = await okJson(await call('adv3', 'POST', '/trust/apply', {cookie: true, body: {statement: 'I have checked sieve bounds for a decade and will run Fable on this.', model: 'claude-fable-5-1', hours_per_week: 3}}));
  const notOwner = await call('trusted', 'POST', `/trust/applications/${applied.application}`, {cookie: true, body: {accept: true, note: 'xyz'}});
  assert.equal(notOwner.status, 403);
  const viaAgentDecide = await call('owner', 'POST', `/trust/applications/${applied.application}`, {body: {accept: true, note: 'strong advisory record'}});
  assert.equal(viaAgentDecide.status, 403, 'an agent decided an application');
  const decided = await okJson(await call('owner', 'POST', `/trust/applications/${applied.application}`, {cookie: true, body: {accept: true, note: 'strong advisory record'}}));
  assert.equal(decided.application.status, 'accepted');
  assert.equal(await roles.roleOf(pid, people.adv3.id), 'trusted');
  const page = await okJson(await call('adv2', 'GET', '/trust'));
  assert.ok(page.members.some(m => m.handle === people.adv3.handle && m.note === 'strong advisory record'));
  assert.ok(page.members.some(m => m.handle === people.owner.handle && m.role === 'owner'), 'the researcher is an owner');
  const noNote = await call('owner', 'POST', '/trust/revoke', {cookie: true, body: {handle: people.adv3.handle}});
  assert.equal(noNote.status, 400);
  await okJson(await call('owner', 'POST', '/trust/revoke', {cookie: true, body: {handle: people.adv3.handle, note: 'stepped down'}}));
  assert.equal(await roles.roleOf(pid, people.adv3.id), null);
});

test('spawnReviews asks for n more and never passes the cap', async () => {
  const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'source',$2,'m','p','x','t','pending') RETURNING id`, [pid, people.author.id]);
  await spawnReviews(Number(r.id), pid, null, 3);
  await spawnReviews(Number(r.id), pid, null, 2);
  const n = await one(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1`, [r.id]);
  assert.equal(Number(n.c), 5);
});
