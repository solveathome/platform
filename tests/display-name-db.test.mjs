import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';

// Display names against a real Postgres (TEST_DATABASE_URL). Everything created is deleted; a residue check fails the run otherwise.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the display name tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';
const tag = `dn-test-${Date.now().toString(36)}`;
process.env.OWNER_HANDLES = `${tag}-owner`;

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken, issueBrowserSession} = await import('../src/lib/auth.ts');
const {settings} = await import('../src/routes/settings.ts');
const {linkPeople} = await import('../src/lib/people.ts');
const {crediter, forgetNames} = await import('../src/lib/display-name.ts');

const people = {}; let server, base;
const mk = async (name) => {
  const handle = `${tag}-${name}`;
  const u = await one(`INSERT INTO users (github_id, handle) VALUES ($1,$2) RETURNING id`, [930_000_000 + Math.floor(Math.random() * 1e8), handle]);
  people[name] = {id: Number(u.id), handle, cookie: `sah_session=${await issueBrowserSession(Number(u.id))}`, token: await issueToken(Number(u.id), 'dn-test')};
};
const call = async (who, method, path, body, headers = {}) => {
  const r = await fetch(base + path, {method, headers: {'content-type': 'application/json', accept: 'application/json', ...(who ? {cookie: who.cookie} : {}), ...headers}, body: body ? JSON.stringify(body) : undefined});
  return {status: r.status, body: await r.json()};
};

before(async () => {
  await migrate();
  for (const n of ['person', 'other', 'owner']) await mk(n);
  const app = express(); app.use(express.json()); app.use(settings);
  await new Promise((ok) => { server = app.listen(0, ok); }); base = `http://localhost:${server.address().port}`;
});
after(async () => {
  server?.close();
  const ids = Object.values(people).map((p) => p.id);
  await q(`DELETE FROM display_name_events WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM browser_sessions WHERE user_id = ANY($1)`, [ids]);
  await q(`SELECT set_config('solveathome.invalidate_token','user-explicit',false)`).catch(() => {});
  await q(`DELETE FROM tokens WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
  const left = await one(`SELECT count(*)::int AS n FROM users WHERE handle LIKE $1`, [`${tag}-%`]);
  assert.equal(left.n, 0, 'test users left behind');
  await pool.end();
});

test('only a person signed in on the site sets a name: no agent token, in a header or in a cookie', async () => {
  assert.equal((await call(null, 'POST', '/me/display-name', {name: 'Ada Lovelace'})).status, 401);
  const bearer = await call(null, 'POST', '/me/display-name', {name: 'Ada Lovelace'}, {authorization: `Bearer ${people.person.token}`});
  assert.equal(bearer.status, 403);
  const tokenInCookie = await call(null, 'POST', '/me/display-name', {name: 'Ada Lovelace'}, {cookie: `sah_session=${people.person.token}`});
  assert.equal(tokenInCookie.status, 403); assert.equal(tokenInCookie.body.code, 'sign_in_again');
  const crossSite = await call(people.person, 'POST', '/me/display-name', {name: 'Ada Lovelace'}, {'sec-fetch-site': 'cross-site'});
  assert.equal(crossSite.status, 403);
  assert.equal((await one(`SELECT display_name FROM users WHERE id=$1`, [people.person.id])).display_name, null);
});

test('set, shown by the credit helper with the handle, cleared, and gone', async () => {
  const set = await call(people.person, 'POST', '/me/display-name', {name: '  Ada   Lovelace '});
  assert.equal(set.status, 200); assert.equal(set.body.display_name, 'Ada Lovelace'); assert.equal(set.body.changes_used, 1);
  forgetNames();
  const html = (await crediter())(people.person.handle);
  assert.match(html, /Ada Lovelace/); assert.match(html, new RegExp(`@${people.person.handle}`));
  const cleared = await call(people.person, 'DELETE', '/me/display-name');
  assert.equal(cleared.body.display_name, null); assert.equal(cleared.body.changes_used, 1, 'clearing is not counted');
  forgetNames();
  assert.doesNotMatch((await crediter())(people.person.handle), /Ada/);
  // The log never holds the name: clearing leaves nothing of it behind.
  const rows = await q(`SELECT action, note FROM display_name_events WHERE user_id=$1 ORDER BY id`, [people.person.id]);
  assert.deepEqual(rows.map((r) => r.action), ['set', 'clear']); assert.ok(rows.every((r) => r.note === null));
});

test("another contributor's handle is not a name", async () => {
  const r = await call(people.person, 'POST', '/me/display-name', {name: people.other.handle});
  assert.equal(r.status, 400); assert.equal(r.body.code, 'is_a_handle');
});

test('three changes in 30 days, the fourth is refused, clearing still works', async () => {
  assert.equal((await call(people.person, 'POST', '/me/display-name', {name: 'Ada Byron'})).status, 200);
  assert.equal((await call(people.person, 'POST', '/me/display-name', {name: 'Ada Byron'})).body.changes_used, 2, 'the same name again is not a change');
  assert.equal((await call(people.person, 'POST', '/me/display-name', {name: 'Ada King'})).status, 200);
  const fourth = await call(people.person, 'POST', '/me/display-name', {name: 'Ada Four'});
  assert.equal(fourth.status, 429); assert.equal(fourth.body.code, 'rate_limited');
  assert.equal((await call(people.person, 'DELETE', '/me/display-name')).body.display_name, null);
});

test('the owner removes a name with a note and can lock the account; nobody else can', async () => {
  assert.equal((await call(people.other, 'POST', '/me/display-name', {name: 'Terence Tao'})).status, 200);
  assert.equal((await call(people.person, 'POST', `/@${people.other.handle}/display-name/remove`, {note: 'not you'})).status, 403);
  assert.equal((await call(people.owner, 'POST', `/@${people.other.handle}/display-name/remove`, {note: ''})).status, 400);
  const removed = await call(people.owner, 'POST', `/@${people.other.handle}/display-name/remove`, {note: 'This is a living mathematician, not you.', lock: true});
  assert.equal(removed.status, 200); assert.equal(removed.body.display_name, null); assert.equal(removed.body.locked, true);
  const st = await call(people.other, 'GET', '/me/display-name');
  assert.equal(st.body.locked, true); assert.match(st.body.lock_note, /living mathematician/);
  assert.equal((await call(people.other, 'POST', '/me/display-name', {name: 'Someone Else'})).status, 403);
  assert.equal((await call(people.person, 'GET', `/@${people.other.handle}/display-name`)).status, 403, 'the lock is not public');
  assert.equal((await call(people.owner, 'POST', `/@${people.other.handle}/display-name/unlock`, {note: 'Sorted out by email.'})).status, 200);
  assert.equal((await call(people.other, 'POST', '/me/display-name', {name: 'Someone Else'})).status, 200);
  await call(people.other, 'DELETE', '/me/display-name');
});

test('a self-chosen name does not turn mentions in research prose into links to that account', async () => {
  await q(`UPDATE users SET display_name = 'Yitang Zhang' WHERE id = $1`, [people.other.id]);
  await new Promise((r) => setTimeout(r, 5));
  const html = await linkPeople('<p>As Yitang Zhang proved in 2013.</p>');
  assert.doesNotMatch(html, new RegExp(people.other.handle));
  await q(`UPDATE users SET display_name = NULL WHERE id = $1`, [people.other.id]);
});
