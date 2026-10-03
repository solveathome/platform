import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';

// Progress emails against a real Postgres (TEST_DATABASE_URL), #sah-progress-emails: events become items, one email per person per
// day (the database refuses a second), no news means no email, choices and the holdout are respected, the address is the person's
// alone (an agent is refused), one-click unsubscribe and the bounce webhook work. Sending goes to a stub. Everything created is deleted.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the email tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';
process.env.EMAIL_LINK_SECRET = 'email-db-test';
process.env.POSTMARK_SERVER_TOKEN = 'stub';
process.env.POSTMARK_WEBHOOK_AUTH = 'hook:secret';
delete process.env.EMAIL_HOLDOUT_UNTIL;
const tag = `email-test-${Date.now().toString(36)}`;
process.env.OWNER_HANDLES = `${tag}-owner`;

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken, issueBrowserSession, hashToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const PM = await import('../src/lib/postmark.ts');
const E = await import('../src/lib/email.ts');
const U = await import('../src/lib/email-update.ts');
const {email} = await import('../src/routes/email.ts');

const sent = [];
PM.setTransport(async (body) => { sent.push(body); return new Response(JSON.stringify({ErrorCode: 0, MessageID: `m-${sent.length}`}), {status: 200}); });

const people = {};
let server, base, pid;
const mk = async (name, address) => {
  const handle = `${tag}-${name}`;
  const u = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at, email, email_source, email_confirmed_at) VALUES ($1,$2,$3,now(),$4,$5,$6) RETURNING id`,
    [940_000_000 + Math.floor(Math.random() * 1e8), handle, TERMS_VERSION, address, address ? 'github_verified' : null, address ? new Date(Date.now() - 86400_000) : null]);
  people[name] = {id: Number(u.id), handle, raw: await issueBrowserSession(Number(u.id)), token: await issueToken(Number(u.id), 'email-test')};
  people[name].cookie = `sah_session=${people[name].raw}`;
};
const mkReturn = (who, type = 'break') => one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,$2,$3,'claude-opus-5-5','anthropic','r','t','accepted') RETURNING id`, [pid, type, people[who].id]).then((r) => Number(r.id));
const decide = (rid, status) => q(`INSERT INTO return_decisions (return_id, status, provisional, by) VALUES ($1,$2,false,'trusted')`, [rid, status]);
const call = async (who, method, path, body, headers = {}) => {
  const r = await fetch(base + path, {method, redirect: 'manual', headers: {'content-type': 'application/json', accept: 'application/json', ...(who ? {cookie: who.cookie} : {}), ...headers}, body: body ? JSON.stringify(body) : undefined});
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return {status: r.status, json, text};
};
const today = (wd = 3) => ({weekday: wd, day: '2026-10-07'});

before(async () => {
  await migrate();
  await mk('author', `${tag}-author@example.org`);
  await mk('citer', `${tag}-citer@example.org`);
  await mk('quiet', `${tag}-quiet@example.org`);
  await mk('nomail', null);
  await mk('owner', null);
  const p = await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,'Email test','https://example.org/r','open') RETURNING id`, [tag]);
  pid = Number(p.id);
  const app = express(); app.use(express.json());
  app.use(email);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  const ids = Object.values(people).map((p) => p.id);
  await q(`DELETE FROM email_items WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM email_outbox WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM email_consent_events WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM email_preferences WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM email_letters WHERE created_by = ANY($1)`, [ids]);
  await q(`DELETE FROM credits WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM browser_sessions WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM tokens WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM reputation WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
  const left = await one(`SELECT (SELECT count(*) FROM users WHERE handle LIKE $1)::int + (SELECT count(*) FROM problems WHERE slug = $2)::int AS n`, [`${tag}%`, tag]);
  assert.equal(left.n, 0, 'test rows left behind');
  await pool.end();
});

test('a trusted acceptance becomes a first-acceptance item; the email leads with it and goes out once', async () => {
  const rid = await mkReturn('author');
  await decide(rid, 'accepted');
  await q(`INSERT INTO credits (user_id, model, problem_id, kind, points, source_type, source_id, note) VALUES ($1,'claude-opus-5-5',$2,'result',60,'return',$3,'accepted')`, [people.author.id, pid, String(rid)]);
  await U.scan(); await U.scan();   // a rescan adds nothing
  const items = await q(`SELECT kind FROM email_items WHERE user_id = $1 ORDER BY kind`, [people.author.id]);
  assert.deepEqual(items.map((i) => i.kind), ['accepted', 'first']);
  const before = sent.length;
  assert.equal(await U.deliver({id: people.author.id, email: `${tag}-author@example.org`, ...today()}), 'sent');
  const m = sent[sent.length - 1];
  assert.equal(sent.length, before + 1);
  assert.match(m.Subject, /^Your first accepted result on Email test \(\+60\)/);
  assert.equal(m.MessageStream, 'broadcast');
  assert.ok(m.Headers.some((h) => h.Name === 'List-Unsubscribe-Post' && h.Value === 'List-Unsubscribe=One-Click'));
  assert.match(m.TextBody, /Points 60/);
  assert.match(m.HtmlBody, /\?e=\d+/);
  assert.equal(m.TrackOpens, false);
  // The same day again: refused, by the composer finding nothing new and by the database's unique key.
  assert.equal(await U.deliver({id: people.author.id, email: 'x', ...today()}), 'nothing');
  await decide(await mkReturn('author'), 'rejected'); await U.scan();
  assert.equal(await U.deliver({id: people.author.id, email: 'x', ...today()}), 'already');
  await assert.rejects(q(`INSERT INTO email_outbox (user_id, local_day, edition) VALUES ($1, '2026-10-07', 'daily')`, [people.author.id]), /email_outbox_user_id_local_day_key|duplicate/);
  assert.equal(sent.length, before + 1);
  // The rejection waits for the next day's email.
  assert.equal(await U.deliver({id: people.author.id, email: `${tag}-author@example.org`, weekday: 4, day: '2026-10-08'}), 'sent');
  assert.match(sent[sent.length - 1].Subject, /^Not accepted/);
});

test('someone building on your work is news for the person built on', async () => {
  const cited = await mkReturn('quiet', 'measure'), citing = await mkReturn('citer');
  await q(`INSERT INTO credits (user_id, problem_id, kind, points, source_type, source_id, note) VALUES ($1,$2,'insight',15,'return',$3,$4)`, [people.quiet.id, pid, String(cited), `built on by return #${citing}`]);
  await U.scan();
  assert.equal(await U.deliver({id: people.quiet.id, email: `${tag}-quiet@example.org`, ...today()}), 'sent');
  assert.match(sent[sent.length - 1].Subject, new RegExp(`^@${tag}-citer built on your work \\(\\+15\\)`));
});

test('no news, no email; weekly people wait for Monday; off means nothing is queued', async () => {
  assert.equal(await U.deliver({id: people.citer.id, email: 'x', ...today()}), 'nothing');   // activity but no news on a Wednesday
  await E.setPrefs(people.citer.id, {updates: 'weekly'}, 'settings');
  const rid = await mkReturn('citer'); await decide(rid, 'accepted'); await U.scan();
  assert.equal(await U.deliver({id: people.citer.id, email: 'x', weekday: 3, day: '2026-10-09'}), 'nothing');
  const n = sent.length;
  assert.equal(await U.deliver({id: people.citer.id, email: `${tag}-citer@example.org`, weekday: 1, day: '2026-10-12'}), 'sent');
  assert.match(sent[n].Subject, /^Your week: /);
  await E.setPrefs(people.citer.id, {updates: 'off'}, 'settings');
  await decide(await mkReturn('citer'), 'accepted'); await U.scan();
  assert.equal(Number((await one(`SELECT count(*)::int AS n FROM email_items WHERE user_id = $1 AND email_id IS NULL`, [people.citer.id])).n), 0);
});

test('the holdout writes the day\'s row and sends nothing', async () => {
  process.env.EMAIL_HOLDOUT_UNTIL = '2099-01-01'; process.env.EMAIL_HOLDOUT_PERCENT = '100';
  try {
    await decide(await mkReturn('quiet'), 'accepted'); await U.scan();
    const n = sent.length;
    assert.equal(await U.deliver({id: people.quiet.id, email: 'x', weekday: 4, day: '2026-10-08'}), 'holdout');
    assert.equal(sent.length, n);
    const row = await one(`SELECT status, suppressed_reason, holdout FROM email_outbox WHERE user_id = $1 AND local_day = '2026-10-08'`, [people.quiet.id]);
    assert.deepEqual(row, {status: 'suppressed', suppressed_reason: 'holdout', holdout: true});
  } finally { delete process.env.EMAIL_HOLDOUT_UNTIL; }
});

test('the address is the person\'s alone: an agent token is refused, in a header or a cookie', async () => {
  const p = people.nomail;
  assert.equal((await call(null, 'GET', '/me/email', null, {authorization: `Bearer ${p.token}`})).status, 403);
  assert.equal((await call(null, 'GET', '/me/email', null, {cookie: `sah_session=${p.token}`})).status, 403);
  await q(`UPDATE browser_sessions SET github_email = $2 WHERE token_hash = $1`, [hashToken(p.raw), `${tag}-gh@example.org`]);
  const st = (await call(p, 'GET', '/me/email')).json;
  assert.equal(st.email, null);
  assert.equal(st.offered, `${tag}-gh@example.org`);
  assert.equal(st.prompt, true);
  // Saving GitHub's verified address confirms it at once; nothing is sent.
  const n = sent.length;
  const saved = (await call(p, 'POST', '/me/email', {from: 'welcome', email: `${tag}-gh@example.org`, updates: 'daily', newsletter: true, tz: 'Europe/Copenhagen'})).json;
  assert.equal(saved.confirmed, true);
  assert.equal(saved.source, 'github_verified');
  assert.equal(saved.prefs.newsletter, true);
  assert.equal(sent.length, n);
  // A typed address waits for its link, which is the one email outside the daily cap.
  const typed = (await call(p, 'POST', '/me/email', {email: `${tag}-typed@example.org`})).json;
  assert.equal(typed.confirmed, false);
  assert.equal(typed.confirmation.sent, true);
  assert.equal(sent[n].MessageStream, 'outbound');
  const link = sent[n].TextBody.match(/\/email\/confirm\?t=(\S+)/)[1];
  assert.equal((await call(null, 'GET', `/email/confirm?t=${link}`)).status, 200);
  assert.equal((await E.addressOf(p.id)).confirmed, true);
  const log = await q(`SELECT choice, value, source FROM email_consent_events WHERE user_id = $1 ORDER BY id`, [p.id]);
  assert.ok(log.some((l) => l.choice === 'newsletter' && l.value === 'true' && l.source === 'welcome'));
  assert.ok(log.some((l) => l.choice === 'address' && l.value === 'confirmed'));
  assert.equal((await one(`SELECT email_tz FROM users WHERE id = $1`, [p.id])).email_tz, 'Europe/Copenhagen');
});

test('one-click unsubscribe works with no sign-in; a bounce stops all mail', async () => {
  const p = people.author;
  const r = await fetch(`${base}/email/u/${E.unsubToken(p.id, 'weekly')}`, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: 'List-Unsubscribe=One-Click'});
  assert.equal(r.status, 200);
  assert.equal((await E.prefsOf(p.id)).updates, 'weekly');
  assert.equal((await fetch(`${base}/email/u/forged.${'A'.repeat(32)}`, {method: 'POST'})).status, 400);
  assert.equal((await call(null, 'POST', '/email/postmark-webhook', {RecordType: 'Bounce', Type: 'HardBounce', Email: `${tag}-author@example.org`})).status, 401);
  const ok = await call(null, 'POST', '/email/postmark-webhook', {RecordType: 'Bounce', Type: 'HardBounce', Email: `${tag}-author@example.org`}, {authorization: `Basic ${Buffer.from('hook:secret').toString('base64')}`});
  assert.equal(ok.status, 200);
  assert.equal((await E.addressOf(p.id)).status, 'bounced');
  // Postmark's own unsubscribe link (managed handling) turns the person's emails off without marking the address.
  const auth = {authorization: `Basic ${Buffer.from('hook:secret').toString('base64')}`};
  await call(null, 'POST', '/email/postmark-webhook', {RecordType: 'SubscriptionChange', Recipient: `${tag}-citer@example.org`, SuppressSending: true, SuppressionReason: 'ManualSuppression'}, auth);
  assert.deepEqual(await E.prefsOf(people.citer.id), {updates: 'off', newsletter: false, projects: false});
  assert.equal((await E.addressOf(people.citer.id)).status, null);
  await decide(await mkReturn('author'), 'accepted'); await U.scan();
  assert.equal(Number((await one(`SELECT count(*)::int AS n FROM email_items WHERE user_id = $1 AND email_id IS NULL`, [p.id])).n), 0);
});

test('the monthly letter: drafted and approved by the owner, then only to people who ticked it', async () => {
  const o = people.owner;
  assert.equal((await call(people.citer, 'POST', '/email/letters', {kind: 'letter', subject: 's', body_md: 'b'})).status, 403);
  const d = (await call(o, 'POST', '/email/letters', {kind: 'letter', subject: `${tag} October`, body_md: 'What the swarm moved.'})).json;
  await U.scan();
  assert.equal(Number((await one(`SELECT count(*)::int AS n FROM email_items WHERE dedupe_key LIKE $1`, [`letter:${d.id}:%`])).n), 0);   // a draft goes nowhere
  assert.equal((await call(o, 'POST', `/email/letters/${d.id}/approve`)).status, 200);
  await U.scan();
  const got = await q(`SELECT user_id FROM email_items WHERE dedupe_key LIKE $1`, [`letter:${d.id}:%`]);
  assert.deepEqual(got.map((g) => Number(g.user_id)).filter((id) => Object.values(people).some((p) => p.id === id)), [people.nomail.id]);
  const n = sent.length;
  assert.equal(await U.deliver({id: people.nomail.id, email: `${tag}-typed@example.org`, ...today()}), 'sent');
  assert.equal(sent[n].Subject, `${tag} October`);
  assert.match(sent[n].From, /^Chris from solveathome/);
});
