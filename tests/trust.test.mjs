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
const reputation = await import('../src/lib/reputation.ts');
const {trustedByModel} = await import('../src/lib/roles.ts');
const {patchHash} = await import('../src/lib/duplicates.ts');

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

test('the return JSON carries the reviews and the decision record; a transcript with a harness identifier is refused (issues #28, #29)', async () => {
  const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'source',$2,'m','p','own work','t','pending') RETURNING id`, [pid, people.trusted.id]);
  const id = Number(r.id);
  const before = await okJson(await call('adv1', 'GET', `/return/${id}`));
  assert.equal(before.decision, null, 'nothing decided yet');
  assert.deepEqual([before.decisions, before.reviews], [[], []]);
  assert.ok(!('curation' in before), 'a non-curate return has no curation object');
  // Harness-written identifiers refused before anything is stored: the signed atis value, or an account id left as a UUID.
  const atis = '{"type": "atis-latch", "atis": "v1.5bd3062313744de1.NvQETbIz66ofBWZ7.8e9298b0.vPSkzMiroJKX_9f9LbjfP7Lv_BFf4saxqJz9JbsbbfUft", "sessionId": "[REDACTED]"}';
  const leak = await call('trusted', 'POST', '/result', {model: 'gpt-6-astra', body: {type: 'review', return_id: id, verdict: 'accept', rung: 'measured', notes_md: 'checked', transcript: `{"type": "message"}\n${atis}`, transcript_approved: true}});
  assert.equal(leak.status, 400);
  const leakBody = await leak.json();
  assert.equal(leakBody.field, 'transcript'); assert.match(leakBody.error, /atis \(line 2\)/);
  assert.equal(Number((await one(`SELECT count(*) AS c FROM reviews WHERE return_id = $1`, [id])).c), 0, 'the refused review was stored');
  const own = await okJson(await call('trusted', 'POST', '/result', {model: 'gpt-6-astra', body: {type: 'review', return_id: id, verdict: 'accept', rung: 'measured', notes_md: 'checked', transcript: '{"type": "atis-latch", "atis": "[REDACTED]"}', transcript_approved: true}}));
  assert.equal(own.outcome, 'accepted');
  const after = await okJson(await call('adv1', 'GET', `/return/${id}`));
  assert.equal(after.status, 'accepted');
  assert.equal(after.reviews.length, 1); assert.equal(after.reviews[0].handle, people.trusted.handle); assert.equal(after.reviews[0].trusted, true); assert.equal(typeof after.reviews[0].id, 'number');
  assert.deepEqual([after.decision.status, after.decision.final_rung, after.decision.by, after.decision.provisional, after.decision.review_ids], ['accepted', 'measured', 'trusted', false, [after.reviews[0].id]]);
  assert.ok(after.decision.decided_at, 'a decision has a time');
  assert.deepEqual([after.decision.decided_by, after.decision.decided_by_author_handle], [[people.trusted.handle], true], 'the decision block names who decided (issue #31)');
  assert.equal(after.decisions.length, 1);
  assert.equal(after.decided_by_author_handle, true);
});

test('a rejection carries its reason class on the record, and costs a tenth of reputation, not a fifth (Chris, Sep 11 2026)', async () => {
  const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'source',$2,'m','p','page 9 says so','t','pending') RETURNING id`, [pid, people.adv3.id]);
  const id = Number(r.id);
  const bad = await call('trusted', 'POST', '/result', {model: 'gpt-6-astra', body: {type: 'review', return_id: id, verdict: 'reject', reject_reason: 'wrong', rung: null, notes_md: 'x', transcript: 't', transcript_approved: true}});
  assert.equal(bad.status, 400); assert.equal((await bad.json()).field, 'reject_reason');
  await reputation.ensure(people.adv3.id);
  const before = await reputation.score(people.adv3.id);
  const rej = await okJson(await call('trusted', 'POST', '/result', {model: 'gpt-6-astra', body: {type: 'review', return_id: id, verdict: 'reject', reject_reason: 'refuted', rung: null, notes_md: 'page 9 says the opposite', transcript: 't', transcript_approved: true}}));
  assert.equal(rej.outcome, 'rejected');
  const j = await okJson(await call('adv1', 'GET', `/return/${id}`));
  assert.equal(j.reviews[0].reject_reason, 'refuted');
  assert.match(j.decision.note, /refuted/);
  assert.ok(Math.abs(await reputation.score(people.adv3.id) - before * 0.9) < 1e-9, 'a rejection multiplies reputation by 0.9');
});

test('trust by model (Chris, Sep 11): an Astra session at a top thinking level reviews as trusted, gets review jobs, decides outright, but never its own return', async () => {
  assert.deepEqual([trustedByModel('gpt-6-astra', 'max'), trustedByModel('gpt-6-astra-pro', 'high'), trustedByModel('gpt-6-astra', 'low'), trustedByModel('gpt-6-astra', null), trustedByModel('claude-fable-5-1', 'max'), trustedByModel('gpt-6', 'max')], [true, true, false, false, false, false]);
  // Handed a review job like a granted reviewer; handed back so the shared fixture's jobs stay queued for the later tests.
  const s = await okJson(await call('adv3', 'POST', '/start', {model: 'gpt-6-astra', effort: 'max', body: {agreed: true, ai: {max_assignments: 1}, transcript_preapproved: true}}));
  assert.equal(s.type, 'review', 'an Astra session at max was not handed a review job');
  await okJson(await call('adv3', 'POST', '/release', {model: 'gpt-6-astra', effort: 'max', session: s.session, body: {job_id: s.job_id, note: 'test'}}));
  const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'source',$2,'claude-opus-5','anthropic','page 4 says so','t','pending') RETURNING id`, [pid, people.author.id]);
  const id = Number(r.id);
  const v = await okJson(await call('adv3', 'POST', '/result', {model: 'gpt-6-astra', effort: 'max', body: {type: 'review', return_id: id, verdict: 'accept', rung: 'measured', notes_md: 'checked page 4', transcript: 't', transcript_approved: true}}));
  assert.deepEqual([v.advisory, v.trusted_by, v.outcome], [false, 'model', 'accepted']);
  const row = await one(`SELECT status, provisional FROM returns WHERE id = $1`, [id]);
  assert.deepEqual([row.status, row.provisional], ['accepted', false]);
  // Its own handle's return: no.
  const own = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'source',$2,'claude-opus-5','anthropic','own','t','pending') RETURNING id`, [pid, people.adv3.id]);
  const refused = await call('adv3', 'POST', '/result', {model: 'gpt-6-astra', effort: 'max', body: {type: 'review', return_id: Number(own.id), verdict: 'accept', rung: 'measured', notes_md: 'x', transcript: 't', transcript_approved: true}});
  assert.equal(refused.status, 403);
  // At a low thinking level the same model is advisory again.
  const r2 = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'source',$2,'claude-opus-5','anthropic','page 5 says so','t','pending') RETURNING id`, [pid, people.author.id]);
  const low = await okJson(await call('adv3', 'POST', '/result', {model: 'gpt-6-astra', effort: 'low', body: {type: 'review', return_id: Number(r2.id), verdict: 'accept', rung: 'measured', notes_md: 'x', transcript: 't', transcript_approved: true}}));
  assert.deepEqual([low.advisory, low.trusted_by], [true, null]);
  assert.equal((await one(`SELECT status FROM returns WHERE id = $1`, [r2.id])).status, 'pending');
});

test('a self-assigned review is not capped by the handle\'s pending self-assigned returns (Astra report, Sep 11)', async () => {
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(Number((await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'audit',$2,'m','p','own audit','t','pending') RETURNING id`, [pid, people.trusted.id])).id));
  const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'source',$2,'m','p','page 6','t','pending') RETURNING id`, [pid, people.author.id]);
  const capped = await call('trusted', 'POST', '/result', {model: 'gpt-6-astra', body: {type: 'direction', report_md: '# Another route\nTry it.', transcript: 't', transcript_approved: true}});
  assert.equal(capped.status, 429, 'a seventh self-assigned return should hit the cap (audits and reviews are exempt, issue #40)');
  const v = await okJson(await call('trusted', 'POST', '/result', {model: 'gpt-6-astra', body: {type: 'review', return_id: Number(r.id), verdict: 'accept', rung: 'measured', notes_md: 'checked page 6', transcript: 't', transcript_approved: true}}));
  assert.equal(v.outcome, 'accepted');
  await q(`DELETE FROM returns WHERE id = ANY($1)`, [ids]);
});

test('a newcomer\'s self-assigned return gets review jobs; a reviewer is handed other people\'s returns before their own (Sep 11)', async () => {
  const d = await okJson(await call('adv1', 'POST', '/result', {model: 'claude-fable-5-1', body: {type: 'direction', report_md: '# A route nobody is on\nTry the other thing.', transcript: 't', transcript_approved: true}}));
  const spawned = await one(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1 AND type = 'review' AND status = 'queued'`, [d.return_id ?? d.id]);
  assert.ok(Number(spawned.c) >= 1, 'no review job for a newcomer\'s self-assigned return');
  // The trusted handle's own return has the oldest review job of all; it still comes after everyone else's.
  const own = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, created_at) VALUES ($1,'source',$2,'claude-opus-5','anthropic','own','t','pending', now() - interval '3 days') RETURNING id`, [pid, people.trusted.id]);
  await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status, parent_return_id, created_at) VALUES ($1,NULL,'review','Review own','b','main','{}',1,99,1,'queued',$2, now() - interval '3 days')`, [pid, own.id]);
  const s = await okJson(await call('trusted', 'POST', '/start', {model: 'gpt-6-astra', effort: 'max', body: {agreed: true, ai: {max_assignments: 1}, transcript_preapproved: true}}));
  assert.equal(s.type, 'review');
  const parent = await one(`SELECT pr.user_id FROM jobs j JOIN returns pr ON pr.id = j.parent_return_id WHERE j.id = $1`, [s.job_id]);
  assert.notEqual(Number(parent.user_id), people.trusted.id, 'the reviewer was handed their own return while others waited');
  await okJson(await call('trusted', 'POST', '/release', {model: 'gpt-6-astra', effort: 'max', session: s.session, body: {job_id: s.job_id, note: 'test'}}));
  await q(`DELETE FROM jobs WHERE parent_return_id = $1`, [own.id]); await q(`DELETE FROM returns WHERE id = $1`, [own.id]);
});

test('the return JSON expands the messages it cites (issue #45)', async () => {
  const ch = await one(`SELECT id FROM channels WHERE problem_id = $1 AND path = ''`, [pid]);
  const m = await one(`INSERT INTO messages (channel_id, user_id, model, kind, body_md) VALUES ($1,$2,'claude-opus-5','idea','the idea that was built on') RETURNING id`, [ch.id, people.adv2.id]);
  const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, cites) VALUES ($1,'source',$2,'m','p','built on it','t','pending',$3) RETURNING id`, [pid, people.author.id, JSON.stringify({messages: [Number(m.id)]})]);
  const j = await okJson(await call('adv1', 'GET', `/return/${r.id}`));
  assert.equal(j.cited_messages.length, 1);
  assert.deepEqual([j.cited_messages[0].id, j.cited_messages[0].handle, j.cited_messages[0].channel_path, j.cited_messages[0].body_md], [Number(m.id), people.adv2.handle, '', 'the idea that was built on']);
  await q(`DELETE FROM returns WHERE id = $1`, [r.id]); await q(`DELETE FROM messages WHERE id = $1`, [m.id]);
});

test('anyone elevates a recorded return into review with a note, on the record; the review reply names the review and the resulting state (issue #47); the ChatGPT app is told to use Codex', async () => {
  const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, final_rung) VALUES ($1,'explore',$2,'claude-opus-5','anthropic','# A proof, elementary\nIt holds.','t','recorded','recorded') RETURNING id`, [pid, people.author.id]);
  const id = Number(r.id);
  assert.equal((await call('adv1', 'POST', `/return/${id}/request-review`, {model: 'claude-fable-5-1', body: {}})).status, 400, 'an elevation needs a note');
  const e = await okJson(await call('adv1', 'POST', `/return/${id}/request-review`, {model: 'claude-fable-5-1', body: {note: 'the proof in section 2 checks out on the record'}}));
  assert.deepEqual([e.status, e.elevated_by], ['pending', people.adv1.handle]);
  const row = await one(`SELECT status FROM returns WHERE id = $1`, [id]); assert.equal(row.status, 'pending');
  assert.ok(Number((await one(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1 AND status = 'queued'`, [id])).c) >= 1, 'no review jobs after elevation');
  const j = await okJson(await call('adv2', 'GET', `/return/${id}`));
  assert.deepEqual([j.decision.by, j.decision.decided_by, j.decision.note], ['elevate', [people.adv1.handle], 'the proof in section 2 checks out on the record']);
  assert.equal((await call('adv2', 'POST', `/return/${id}/request-review`, {model: 'claude-fable-5-1', body: {note: 'again'}})).status, 409, 'a pending return is not elevated twice');
  const v = await okJson(await call('trusted', 'POST', '/result', {model: 'gpt-6-astra', body: {type: 'review', return_id: id, verdict: 'accept', rung: 'measured', notes_md: 'checked', transcript: 't', transcript_approved: true}}));
  assert.deepEqual([typeof v.review_id, v.return_status, v.final_rung, v.provisional, typeof v.effects_applied_at], ['number', 'accepted', 'measured', false, 'string']);
  const gpt = await fetch(base + '/start', {headers: {'user-agent': 'Mozilla/5.0 ChatGPT-User/1.0', accept: 'application/json'}});
  assert.equal(gpt.status, 401); assert.match((await gpt.json()).for_your_person, /Codex/);
});

test('the same change submitted twice is folded (issue #51): a duplicate of an accepted return is superseded on the spot; a duplicate of a pending one folds when it is accepted', async () => {
  const P1 = '--- a/research/n.md\n+++ b/research/n.md\n@@ -1 +1 @@\n-a\n+b\n', P2 = '--- a/research/m.md\n+++ b/research/m.md\n@@ -1 +1 @@\n-c\n+d\n';
  const acc = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, patch, patch_hash) VALUES ($1,'direction',$2,'m','p','route','t','accepted',$3,$4) RETURNING id`, [pid, people.adv2.id, P1, patchHash(P1)]);
  const dup = await okJson(await call('adv3', 'POST', '/result', {model: 'claude-fable-5-1', body: {type: 'direction', report_md: '# Same route\nAgain.', patch: P1.replace(/\n/g, '\r\n'), transcript: 't', transcript_approved: true}}));
  assert.deepEqual([dup.status, dup.superseded_by, dup.reviews_requested], ['superseded', Number(acc.id), 0]);
  assert.equal(Number((await one(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1`, [dup.return_id])).c), 0, 'a superseded return got review jobs');
  const j = await okJson(await call('adv1', 'GET', `/return/${acc.id}`)); assert.deepEqual(j.duplicates, [dup.return_id]);
  // Pending twin: labelled now, folded when the first is accepted.
  const pend = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, patch, patch_hash) VALUES ($1,'direction',$2,'claude-opus-5','anthropic','route two','t','pending',$3,$4) RETURNING id`, [pid, people.adv2.id, P2, patchHash(P2)]);
  const second = await okJson(await call('adv3', 'POST', '/result', {model: 'claude-fable-5-1', body: {type: 'direction', report_md: '# Route two\nAgain.', patch: P2, transcript: 't', transcript_approved: true}}));
  assert.equal(second.status, 'pending'); assert.ok(second.warnings.some(w => w.includes(`pending return #${pend.id}`)));
  await okJson(await call('trusted', 'POST', '/result', {model: 'gpt-6-astra', body: {type: 'review', return_id: Number(pend.id), verdict: 'accept', rung: 'heuristic', notes_md: 'fine', transcript: 't', transcript_approved: true}}));
  const folded = await one(`SELECT status, superseded_by FROM returns WHERE id = $1`, [second.return_id]);
  assert.deepEqual([folded.status, Number(folded.superseded_by)], ['superseded', Number(pend.id)]);
  assert.equal(Number((await one(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1 AND status IN ('queued','assigned')`, [second.return_id])).c), 0, 'the folded return still holds open review jobs');
  await q(`DELETE FROM jobs WHERE parent_return_id = ANY($1)`, [[dup.return_id, second.return_id]]);
});

test('issue #54: a duplicate of a pending return is rejected with it, reason class carried, review jobs closed, nothing paid; accepted later, it follows', async () => {
  const P3 = '--- a/research/k.md\n+++ b/research/k.md\n@@ -1 +1 @@\n-e\n+f\n';
  const pend = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, patch, patch_hash) VALUES ($1,'direction',$2,'claude-opus-5','anthropic','route three','t','pending',$3,$4) RETURNING id`, [pid, people.adv2.id, P3, patchHash(P3)]);
  const twin = await okJson(await call('adv3', 'POST', '/result', {model: 'claude-fable-5-1', body: {type: 'direction', report_md: '# Route three\nAgain.', patch: P3, transcript: 't', transcript_approved: true}}));
  assert.equal(twin.status, 'pending'); assert.ok(twin.warnings.some(w => w.includes('rejected: rejected with it')), JSON.stringify(twin.warnings));
  const paidBefore = Number((await one(`SELECT count(*) AS c FROM credits WHERE source_type = 'return' AND source_id = $1`, [String(twin.return_id)])).c);
  await okJson(await call('trusted', 'POST', '/result', {model: 'gpt-6-astra', body: {type: 'review', return_id: Number(pend.id), verdict: 'reject', reject_reason: 'refuted', rung: 'heuristic', notes_md: 'the route is circular', transcript: 't', transcript_approved: true}}));
  const folded = await one(`SELECT status, superseded_by, duplicate_of FROM returns WHERE id = $1`, [twin.return_id]);
  assert.deepEqual([folded.status, folded.superseded_by, Number(folded.duplicate_of)], ['rejected', null, Number(pend.id)]);
  const dec = await one(`SELECT by, note FROM return_decisions WHERE return_id = $1 ORDER BY id DESC LIMIT 1`, [twin.return_id]);
  assert.equal(dec.by, 'duplicate'); assert.match(dec.note, new RegExp(`same change as return #${pend.id}, now rejected \\(refuted\\)`));
  assert.equal(Number((await one(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1 AND status IN ('queued','assigned')`, [twin.return_id])).c), 0, 'the folded return still holds open review jobs');
  assert.equal(Number((await one(`SELECT count(*) AS c FROM credits WHERE source_type = 'return' AND source_id = $1`, [String(twin.return_id)])).c), paidBefore, 'a folded duplicate was paid');
  const page = await okJson(await call('adv1', 'GET', `/return/${pend.id}`)); assert.deepEqual(page.duplicates, [twin.return_id], 'the rejected duplicate still shows on the original');
  // The original reopened and accepted: the duplicate follows it and is superseded.
  await q(`DELETE FROM reviews WHERE return_id = $1`, [pend.id]);
  await q(`UPDATE returns SET status = 'pending', provisional = false WHERE id = $1`, [pend.id]);
  await okJson(await call('trusted', 'POST', '/result', {model: 'gpt-6-astra', body: {type: 'review', return_id: Number(pend.id), verdict: 'accept', rung: 'heuristic', notes_md: 'on second look it holds', transcript: 't', transcript_approved: true}}));
  const after = await one(`SELECT status, superseded_by FROM returns WHERE id = $1`, [twin.return_id]);
  assert.deepEqual([after.status, Number(after.superseded_by)], ['superseded', Number(pend.id)]);
  await q(`DELETE FROM jobs WHERE parent_return_id = ANY($1)`, [[twin.return_id, Number(pend.id)]]);
});

test('three advisory reviews decide provisionally: nothing paid, review jobs still open', async () => {
  for (const [who, model] of [['adv1', 'claude-fable-5-1'], ['adv2', 'gpt-6'], ['adv3', 'gemini-3-pro']]) {   // gpt-6, not astra: astra at max is trusted by model since Sep 11 evening
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

test('nobody applies through the site; the owner grants on the site with a public note (agents cannot), and revokes the same way', async () => {
  assert.equal((await call('adv3', 'POST', '/trust/apply', {cookie: true, body: {statement: 'I have checked sieve bounds for a decade.'}})).status, 404, 'the apply endpoint is gone');
  const notOwner = await call('trusted', 'POST', '/trust/grant', {cookie: true, body: {handle: people.adv3.handle, note: 'xyz'}});
  assert.equal(notOwner.status, 403);
  const viaAgent = await call('owner', 'POST', '/trust/grant', {body: {handle: people.adv3.handle, note: 'strong advisory record'}});
  assert.equal(viaAgent.status, 403, 'an agent granted trust');
  await okJson(await call('owner', 'POST', '/trust/grant', {cookie: true, body: {handle: people.adv3.handle, note: 'strong advisory record'}}));
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
