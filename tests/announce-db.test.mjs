import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// Announcements end to end (#sah-discord-announcer): the review mark, the outbox, the hold, suppression, the approve page, the finder join,
// the ledger check, sending and correcting through a stubbed webhook. Real Postgres (TEST_DATABASE_URL); everything created is deleted.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the announce tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';
const tag = `announce-test-${Date.now().toString(36)}`;
const slug = tag;
// The project's config comes from project.json: a directory of our own, rewritten per test.
const projectsDir = mkdtempSync(join(tmpdir(), 'announce-projects-'));
process.env.PROJECTS_DIR = projectsDir;
mkdirSync(join(projectsDir, slug));
const setConfig = (announce) => writeFileSync(join(projectsDir, slug, 'project.json'), JSON.stringify({slug, name: 'Announce test', repo_url: 'https://example.org/r', announce}));
setConfig({discord: true});

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job, reopen} = await import('../src/routes/job.ts');
const {announcements} = await import('../src/routes/announcements.ts');
const roles = await import('../src/lib/roles.ts');
const {scan, dispatch} = await import('../src/lib/announce.ts');

const people = {};
let server, base, pid;
const mk = async (name) => {
  const handle = `${tag}-${name}`;
  const u = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [930_000_000 + Math.floor(Math.random() * 1e8), handle, TERMS_VERSION]);
  people[name] = {id: Number(u.id), handle, token: await issueToken(Number(u.id), 'announce-test')};
};

before(async () => {
  await migrate();
  for (const n of ['owner', 'granted', 'stranger', 'author', 'other']) await mk(n);
  const p = await one(`INSERT INTO problems (slug, name, repo_url, status_md, researcher_user_id) VALUES ($1,'Announce test','https://example.org/r','open',$2) RETURNING id`, [slug, people.owner.id]);
  pid = Number(p.id);
  await q(`UPDATE problems SET discovery_share = 0 WHERE id = $1`, [pid]);
  await q(`INSERT INTO channels (problem_id, path, title) VALUES ($1,'','Project')`, [pid]);
  await roles.grant(pid, people.granted.id, 'trusted', people.owner.id, 'test');
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job); app.use('/projects/:slug', announcements);
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/projects/${slug}`;
});

after(async () => {
  server?.close();
  const ids = Object.values(people).map(p => p.id);
  await q(`DELETE FROM announcements WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM credits WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM messages WHERE user_id = ANY($1) OR channel_id IN (SELECT id FROM channels WHERE problem_id = $2)`, [ids, pid]);
  await q(`DELETE FROM channel_members WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM reviews WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM sessions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM pool WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM project_roles WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM lanes WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM tokens WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM reputation WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE handle LIKE $1) + (SELECT count(*) FROM problems WHERE slug = $2) + (SELECT count(*) FROM announcements WHERE problem_id = $3) AS n`, [`${tag}-%`, slug, pid]);
  await pool.end();
  rmSync(projectsDir, {recursive: true, force: true});
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const call = (who, method, path, {model, body, cookie, effort = 'max'} = {}) => fetch(base + path, {
  method, headers: {...(cookie ? {cookie: `sah_session=${people[who].token}`, 'sec-fetch-site': 'same-origin'} : {authorization: `Bearer ${people[who].token}`}), accept: 'application/json', 'content-type': 'application/json', ...(model ? {'x-model': model, 'x-effort': effort} : {})},
  body: body ? JSON.stringify(body) : undefined,
});
const okJson = async (r) => { const t = await r.text(); assert.equal(r.status, 200, t); return JSON.parse(t); };
const mkReturn = async (type, extra = {}) => Number((await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, target, finding) VALUES ($1,$2,$3,'claude-opus-5','anthropic','work','t','pending',$4,$5) RETURNING id`, [pid, type, people.author.id, extra.target ? JSON.stringify(extra.target) : null, extra.finding ?? null])).id);
const review = (id, rung, extra = {}) => ({type: 'review', return_id: id, verdict: 'accept', rung, notes_md: 'checked it', transcript: 't', transcript_approved: true, ...extra});
const row = (returnId) => one(`SELECT * FROM announcements WHERE return_id = $1`, [returnId]);
const decidedAt = async (id) => new Date((await one(`SELECT max(decided_at) AS t FROM return_decisions WHERE return_id = $1`, [id])).t);
const hours = (d, h) => new Date(d.getTime() + h * 3600_000);

// A stub webhook: records every call, answers a message id.
const calls = [];
const stub = async (url, init) => { calls.push({url, method: init.method, body: JSON.parse(init.body)}); return {ok: true, status: 200, json: async () => ({id: `m${calls.length}`}), text: async () => ''}; };
const env = {DISCORD_PROGRESS_WEBHOOK_URL: 'http://127.0.0.1:9/api/webhooks/1/x'};

let proof;
test('a role-holder marks an accepted proof; the mark is on the review and the return is accepted at Proven', async () => {
  proof = await mkReturn('formalize');
  const r = await okJson(await call('granted', 'POST', '/result', {model: 'gpt-6-astra', body: review(proof, 'proven', {announce: true, announce_md: 'Lemma 3 holds for all $x \\ge 2$ at Proven.'})}));
  assert.equal(r.return_status, 'accepted'); assert.equal(r.final_rung, 'proven');
  assert.equal(r.warnings.filter(w => /^announce/.test(w)).length, 0, r.warnings.join(' | '));
  const rv = await one(`SELECT announce, announce_md FROM reviews WHERE return_id = $1`, [proof]);
  assert.deepEqual([rv.announce, rv.announce_md], [true, 'Lemma 3 holds for all $x \\ge 2$ at Proven.']);
});

test('trust by model marks nothing, and an acceptance without a role-holder\'s mark is never announced', async () => {
  const id = await mkReturn('formalize');
  const r = await okJson(await call('stranger', 'POST', '/result', {model: 'claude-opus-5-5', body: review(id, 'proven', {announce: true, announce_md: 'x'})}));
  assert.equal(r.return_status, 'accepted', 'a model-trusted session decides');
  assert.ok(r.warnings.some(w => /trust by model does not set it/.test(w)), r.warnings.join(' | '));
  assert.equal((await one(`SELECT announce FROM reviews WHERE return_id = $1`, [id])).announce, false);
  const rej = await mkReturn('formalize');
  const rr = await okJson(await call('granted', 'POST', '/result', {model: 'gpt-6-astra', body: {...review(rej, null, {announce: true}), verdict: 'reject', reject_reason: 'refuted'}}));
  assert.ok(rr.warnings.some(w => /on a reject no mark/.test(w)));
  await scan([slug]);
  assert.equal(await row(id), undefined, 'announced without a role-holder\'s mark');
  assert.equal(await row(rej), undefined);
});

test('the post goes out on the next pass with nobody approving it, naming only the return\'s author, joined at send time', async () => {
  await scan([slug]);   // the scan in the test above already made it
  const a = await row(proof);
  assert.ok(a, 'no row for a marked, trusted acceptance of a proof');
  assert.deepEqual([a.kind, a.final_rung, a.status, Number(a.finder_user_id), a.flag], ['proof', 'proven', 'held', people.author.id, null]);
  assert.deepEqual(await scan([slug]), [], 'one row per return, ever');
  const t = await decidedAt(proof);
  assert.equal(new Date(a.due_at).getTime(), t.getTime(), 'no hold by default: due at the decision');
  // No webhook: nothing is sent and the row waits for one.
  assert.match((await dispatch(slug, {now: new Date(), fetchImpl: stub, env: {}})).waiting[a.id], /DISCORD_PROGRESS_WEBHOOK_URL is unset/);
  assert.equal(calls.length, 0, 'sent without a webhook');
  const renamed = `${people.author.handle}-r`;
  await q(`UPDATE users SET handle = $2 WHERE id = $1`, [people.author.id, renamed]); people.author.handle = renamed;
  const d = await dispatch(slug, {now: new Date(), fetchImpl: stub, env});
  assert.deepEqual(d.sent, [Number(a.id)], JSON.stringify(d));
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.method, 'POST'); assert.match(c.url, /\?wait=true$/);
  assert.deepEqual(c.body.allowed_mentions, {parse: []});
  const e = c.body.embeds[0];
  assert.equal(e.finder_handle, undefined, 'internal field sent to Discord');
  assert.match(e.title, /^Proved: accepted at Proven by a trusted reviewer/);
  assert.ok(e.description.includes(`Found by **[@${renamed}]`), e.description);
  assert.ok(!e.description.includes(people.granted.handle) && !e.description.includes('gpt-6-astra'), 'the reviewer or the model is credited');
  assert.match(e.description, /x ≥ 2/);
  const sent = await row(proof);
  assert.deepEqual([sent.status, sent.discord_message_id, sent.approved_at], ['sent', 'm1', null]);
  assert.equal((await dispatch(slug, {now: new Date(), fetchImpl: stub, env})).sent.length, 0, 'sent twice');
  assert.deepEqual(await scan([slug]), [], 'a sent return queued again');
});

test('the log page is the owners\', on the site; no approve step unless a project turns approval back on', async () => {
  assert.equal((await call('granted', 'GET', '/announcements', {cookie: true})).status, 403);
  const page = await okJson(await call('owner', 'GET', '/announcements', {cookie: true}));
  assert.equal(page.config.approval, false); assert.ok(page.recent.some(r => Number(r.return_id) === proof && r.status === 'sent'));
  const html = await (await fetch(base + '/announcements', {headers: {cookie: `sah_session=${people.owner.token}`, accept: 'text/html'}})).text();
  assert.match(html, /with nobody approving it/); assert.doesNotMatch(html, /data-act="approve"/);
  // Opt back in: a row waits for an owner; bearer tokens and non-owners cannot approve.
  setConfig({discord: true, approval: true});
  const id = await mkReturn('explore');
  await okJson(await call('granted', 'POST', '/result', {model: 'gpt-6-astra', body: review(id, 'measured', {announce: true, announce_md: 'A route is opened at Measured.'})}));
  await scan([slug]);
  const a = await row(id);
  assert.equal((await dispatch(slug, {now: new Date(), fetchImpl: stub, env})).waiting[a.id], "waiting for an owner's approval");
  assert.equal((await call('owner', 'POST', `/announcements/${a.id}/approve`)).status, 403, 'an agent token approved');
  assert.equal((await call('granted', 'POST', `/announcements/${a.id}/approve`, {cookie: true})).status, 403, 'a non-owner approved');
  await okJson(await call('owner', 'POST', `/announcements/${a.id}/suppress`, {cookie: true, body: {reason: 'test of the opt-in path'}}));
  setConfig({discord: true});
});

test('a revisited acceptance corrects the sent post: the original is edited and a correction follows', async () => {
  const ret = await one(`SELECT * FROM returns WHERE id = $1`, [proof]);
  await reopen(ret, people.owner.id, 'test: looking again', 'reopen');
  const d = await dispatch(slug, {now: new Date(), fetchImpl: stub, env});
  const a = await row(proof);
  assert.deepEqual(d.corrected, [Number(a.id)]);
  assert.equal(a.status, 'corrected'); assert.match(a.correction, /is now pending/);
  const [edit, note] = calls.slice(-2);
  assert.equal(edit.method, 'PATCH'); assert.match(edit.url, /\/api\/webhooks\/1\/x\/messages\/m1$/);
  assert.match(edit.body.embeds[0].title, /^\[Revisited\]/);
  assert.ok(edit.body.embeds[0].description.includes(`The finding was @${people.author.handle}'s.`));
  assert.equal(note.method, 'POST'); assert.match(note.body.content, /^Correction: Revisited .*: return #\d+ is now pending/);
});

test('a decision that changes inside the hold suppresses the row before anything is sent', async () => {
  const id = await mkReturn('break');
  await okJson(await call('granted', 'POST', '/result', {model: 'gpt-6-astra', body: review(id, 'refuted', {announce: true, announce_md: 'The bound in return #1 fails at x = 10^6.'})}));
  await scan([slug]);
  const a = await row(id);
  assert.equal(a.kind, 'refutation');
  await reopen(await one(`SELECT * FROM returns WHERE id = $1`, [id]), people.owner.id, 'test', 'reopen');
  const before = calls.length;
  const d = await dispatch(slug, {now: hours(new Date(), 20), fetchImpl: stub, env});
  assert.deepEqual(d.suppressed, [Number(a.id)]);
  assert.match((await row(id)).suppressed_reason, /before posting: the return is pending/);
  assert.equal(calls.length, before);
});

test('credit never drifts: a ledger that pays someone else skips the post and says why; nobody is asked', async () => {
  const id = await mkReturn('explore');
  await okJson(await call('granted', 'POST', '/result', {model: 'gpt-6-astra', body: review(id, 'measured', {announce: true, announce_md: 'A new route: the gap statistic is measured to 10^9.'})}));
  await q(`UPDATE credits SET user_id = $2 WHERE source_type = 'return' AND source_id = $1 AND kind = 'result'`, [String(id), people.other.id]);
  await scan([slug]);
  const a = await row(id);
  assert.equal(a.kind, 'opening');
  const before = calls.length;
  const d = await dispatch(slug, {now: new Date(), fetchImpl: stub, env});
  assert.deepEqual(d.suppressed, [Number(a.id)]);
  assert.match((await row(id)).suppressed_reason, /^skipped: the ledger's result credit pays someone other than the return's author/);
  assert.equal(calls.length, before);
});

test('overclaiming wording never goes out: the note is left out, the post still goes, the row says what was left out', async () => {
  const id = await mkReturn('explore');
  await okJson(await call('granted', 'POST', '/result', {model: 'gpt-6-astra', body: review(id, 'measured', {announce: true, announce_md: 'This breakthrough has solved the gap question.'})}));
  await scan([slug]);
  const a = await row(id);
  assert.match(a.flag, /^validator's note left out \(wording to check: "solved"\)/);
  const d = await dispatch(slug, {now: new Date(), fetchImpl: stub, env});
  assert.deepEqual(d.sent, [Number(a.id)], JSON.stringify(d));
  const e = calls.at(-1).body.embeds[0];
  assert.doesNotMatch(e.description, /solved|breakthrough|Validator's note/i);
  assert.match(e.description, /^Found by \*\*\[@/);
});

test('rate limits: the daily cap and the burst guard hold rows back; an owner suppresses with a reason on the record', async () => {
  setConfig({discord: true, max_per_day: 1, burst_per_hour: 100});
  const id = await mkReturn('explore');
  await okJson(await call('granted', 'POST', '/result', {model: 'gpt-6-astra', body: review(id, 'measured', {announce: true, announce_md: 'Another route opened.'})}));
  await scan([slug]);
  const a = await row(id);
  const d = await dispatch(slug, {now: new Date(), fetchImpl: stub, env});
  assert.match(d.waiting[a.id], /daily limit/);
  setConfig({discord: true, approval: false, hold_hours: 0, burst_per_hour: 0});
  assert.equal((await dispatch(slug, {now: new Date(), fetchImpl: stub, env})).waiting[a.id], 'burst guard');
  setConfig({discord: true});
  await okJson(await call('owner', 'POST', `/announcements/${a.id}/suppress`, {cookie: true, body: {reason: 'test'}}));
  assert.match((await row(id)).suppressed_reason, /^by @announce-test-[a-z0-9]+-owner: test$/);
});
