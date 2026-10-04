import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';
import {createHash, randomBytes} from 'node:crypto';

// A chat app does real work (#sah-mcp-real-work-build): sign-in and consent through the site's own OAuth server, then a full round over
// MCP: take an assignment (chat work only), read it, send the result (server-observed transcript, no token credit, always reviewed), take
// another and hand it back; the token never works on the API directly, and Disconnect ends it. Runs against a real Postgres
// (TEST_DATABASE_URL); every row it creates is deleted at the end and a residue check fails the run if anything is left behind.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the MCP work tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.MCP_WORK_BETA = '1';
delete process.env.MCP_WORK_HANDLES;

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {TERMS_VERSION, PREVIOUS_TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job} = await import('../src/routes/job.ts');
const {oauthRoutes, mountWellKnown} = await import('../src/routes/oauth.ts');
const {mountPlugin} = await import('../src/lib/chatgpt-plugin/express.ts');
const {workPlugin} = await import('../src/lib/mcp-work.ts');
const {WORK_PATH} = await import('../src/lib/oauth.ts');

const tag = `mcpw-${Date.now().toString(36)}`;
const slug = tag, handle = `${tag}-person`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
let server, base, uid, pid, cookie, clientId, token;
const jobs = {};

before(async () => {
  await migrate();
  // On the previous terms: the consent page moves them to the current version.
  const u = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [800_000_000 + Math.floor(Math.random() * 1e8), handle, PREVIOUS_TERMS_VERSION]);
  uid = Number(u.id);
  cookie = 'sahweb_' + randomBytes(24).toString('base64url');
  await q(`INSERT INTO browser_sessions (token_hash, user_id) VALUES ($1,$2)`, [sha(cookie), uid]);
  const p = await one(`INSERT INTO problems (slug, name, repo_url, status_md, featured) VALUES ($1,$2,'https://example.org/r','open',false) RETURNING id`, [slug, 'MCP work test']);
  pid = Number(p.id);
  await q(`INSERT INTO channels (problem_id, path, title) VALUES ($1,'','Project')`, [pid]);
  for (const [k, type] of [['measure', 'measure'], ['explore1', 'explore'], ['explore2', 'explore']]) {
    jobs[k] = Number((await one(`INSERT INTO jobs (problem_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status, created_at)
      VALUES ($1,$2,$3,'Think about it.','main','{}',1,99,1,'queued', now() - ($4 || ' days')::interval) RETURNING id`, [pid, type, `Test ${k}`, k === 'measure' ? '30' : '1'])).id);
  }
  const app = express();
  server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`; process.env.BASE_URL = base;
  mountPlugin(app, workPlugin(base, base), {path: WORK_PATH, challenge: false});
  mountWellKnown(app);
  app.use(express.json({limit: '2mb'}));
  app.use(oauthRoutes);
  app.use('/projects/:slug', job);
});

after(async () => {
  server?.close();
  await q(`DELETE FROM mcp_calls WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM oauth_grants WHERE user_id = $1`, [uid]);
  if (clientId) await q(`DELETE FROM oauth_clients WHERE client_id = $1`, [clientId]);
  await q(`DELETE FROM credits WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM messages WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM channel_members WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`UPDATE jobs SET parent_return_id = NULL WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM assignment_attempts WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM sessions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM pool WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM browser_sessions WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM reputation WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM users WHERE id = $1`, [uid]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE handle = $1) + (SELECT count(*) FROM problems WHERE slug = $1) + (SELECT count(*) FROM oauth_clients WHERE client_id = $2)
    + (SELECT count(*) FROM mcp_calls WHERE user_id = $3) + (SELECT count(*) FROM terms_acceptances WHERE user_id = $3) AS n`, [handle, clientId ?? '', uid]);
  await pool.end();
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const form = (o) => new URLSearchParams(o);
let rpcId = 1;
const mcp = async (method, params, headers = {}) => {
  const r = await fetch(base + WORK_PATH, {method: 'POST', headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {}), ...headers}, body: JSON.stringify({jsonrpc: '2.0', id: rpcId++, method, params})});
  return {status: r.status, headers: r.headers, body: await r.json()};
};
const tool = async (name, args = {}) => { const r = await mcp('tools/call', {name, arguments: args}); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.result; };

test('sign-up through the chat app: registration, consent with the terms box, PKCE code, tokens', async () => {
  const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource${WORK_PATH}`)).json();
  assert.equal(meta.resource, base + WORK_PATH);
  const reg = await (await fetch(`${base}/oauth/register`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({client_name: 'Test: ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'none'})})).json();
  clientId = reg.client_id;
  const verifier = randomBytes(40).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const qs = form({response_type: 'code', client_id: clientId, redirect_uri: reg.redirect_uris[0], code_challenge: challenge, code_challenge_method: 'S256', scope: 'contribute', state: 's1', resource: base + WORK_PATH});
  const anon = await fetch(`${base}/oauth/authorize?${qs}`, {redirect: 'manual'});
  assert.equal(anon.status, 302); assert.match(anon.headers.get('location'), /^\/auth\/github\?next=%2Foauth%2Fauthorize/);
  const page = await fetch(`${base}/oauth/authorize?${qs}`, {headers: {cookie: `sah_session=${cookie}`}, redirect: 'manual'});
  const html = await page.text();
  assert.match(html, /I accept the <a href="\/terms"/);
  assert.match(page.headers.get('content-security-policy'), /form-action 'self' https:\/\/chatgpt\.com/);
  const rid = /name="request_id" value="([^"]+)"/.exec(html)[1], csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const post = (o) => fetch(`${base}/oauth/authorize`, {method: 'POST', headers: {cookie: `sah_session=${cookie}`, 'content-type': 'application/x-www-form-urlencoded'}, body: form(o), redirect: 'manual'});
  assert.equal((await post({request_id: rid, csrf: 'wrong', action: 'allow', accept_terms: 'yes'})).status, 400, 'csrf');
  assert.match(await (await post({request_id: rid, csrf, action: 'allow'})).text(), /Tick/, 'the box is required');
  const ok = await post({request_id: rid, csrf, action: 'allow', accept_terms: 'yes'});
  const loc = new URL(ok.headers.get('location'));
  assert.equal(loc.searchParams.get('state'), 's1'); assert.equal(loc.searchParams.get('iss'), base);
  assert.equal((await one(`SELECT terms_version FROM users WHERE id = $1`, [uid])).terms_version, TERMS_VERSION, 'consent records the current terms');
  assert.ok(await one(`SELECT 1 FROM terms_acceptances WHERE user_id = $1 AND version = $2 AND via = 'oauth'`, [uid, TERMS_VERSION]));
  const exchange = (o) => fetch(`${base}/oauth/token`, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: form(o)}).then((r) => r.json());
  assert.equal((await exchange({grant_type: 'authorization_code', code: loc.searchParams.get('code'), redirect_uri: reg.redirect_uris[0], code_verifier: randomBytes(40).toString('base64url'), client_id: clientId})).error, 'invalid_grant', 'wrong verifier');
  const t = await exchange({grant_type: 'authorization_code', code: loc.searchParams.get('code'), redirect_uri: reg.redirect_uris[0], code_verifier: verifier, client_id: clientId, resource: base + WORK_PATH});
  assert.equal(t.token_type, 'Bearer'); assert.equal(t.scope, 'contribute');
  const r = await exchange({grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId});
  assert.ok(r.access_token && r.refresh_token !== t.refresh_token, 'refresh rotates');
  token = r.access_token;
  assert.equal((await fetch(`${base}/projects/${slug}/start`, {headers: {authorization: `Bearer ${token}`}})).status, 401, 'the OAuth token does not work on the API directly');
});

test('a full round from the chat: chat work only, chat brief, server-observed transcript, no token credit, always reviewed', async () => {
  const s = await tool('start_contributing', {project: slug});
  assert.ok(!s.isError, s.content[0].text);
  assert.ok([jobs.explore1, jobs.explore2].includes(Number(s.structuredContent.job_id)), 'a chat never gets the measure job');
  assert.match(s.content[0].text, /How this works from a chat/);
  const session = s.structuredContent.session_id;
  const row = await one(`SELECT model, registered_via, oauth_grant_id FROM sessions WHERE id = $1`, [session]);
  assert.deepEqual([row.model, row.registered_via, !!row.oauth_grant_id], ['chatgpt-unmeasured', 'mcp', true]);
  assert.match((await tool('get_assignment')).content[0].text, /Think about it/);
  const sent = await tool('submit_return', {report_md: 'Test: caveat first. A test return; nothing here is research.', author_rung: 'conjectured', share_url: 'https://chatgpt.com/share/abcdefgh1234'});
  assert.ok(!sent.isError, sent.content[0].text);
  const ret = await one(`SELECT model, status, tokens, transcript FROM returns WHERE id = $1`, [sent.structuredContent.return_id]);
  assert.equal(ret.model, 'chatgpt-unmeasured'); assert.equal(ret.status, 'pending', 'an explore from a chat is reviewed, not just recorded');
  assert.equal(ret.tokens.log, 'mcp-observed'); assert.equal(ret.tokens.source, 'none');
  const head = JSON.parse(ret.transcript.split('\n')[0]);
  assert.equal(head.kind, 'mcp-observed'); assert.equal(head.share_url, 'https://chatgpt.com/share/abcdefgh1234');
  assert.match(ret.transcript, /"tool":"start_contributing"/);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM credits WHERE user_id = $1 AND kind = 'tokens'`, [uid])).n), 0, 'no token credit');
  assert.ok(await one(`SELECT 1 FROM jobs WHERE parent_return_id = $1 AND type IN ('triage','review')`, [sent.structuredContent.return_id]), 'it goes to triage or review');
  const next = await tool('start_contributing', {project: slug});
  assert.equal(next.structuredContent.session_id, session, 'the same chat keeps its session');
  const rel = await tool('release_assignment', {note: 'test'});
  assert.equal(rel.structuredContent.released, true);
  assert.match((await tool('my_standing')).content[0].text, new RegExp(`@${handle}`));
});

test('Disconnect ends the connection at once', async () => {
  const g = await one(`SELECT id FROM oauth_grants WHERE user_id = $1 AND revoked_at IS NULL`, [uid]);
  const r = await fetch(`${base}/settings/connections/${g.id}/disconnect`, {method: 'POST', headers: {cookie: `sah_session=${cookie}`}, redirect: 'manual'});
  assert.equal(r.status, 303);
  const after = await mcp('tools/call', {name: 'my_standing', arguments: {}});
  assert.equal(after.status, 401); assert.match(after.headers.get('www-authenticate'), /invalid_token/);
});
