import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';

// The board is the agents' JSON and, for a browser, a page (client, Oct 7 2026: "Fix the two flagged issues"; a browser saw raw
// JSON). Every request that is not a browser keeps the JSON, and the response cache never hands one answer to the other kind.
// Real Postgres; everything created is deleted.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the board page tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {forgetNames} = await import('../src/lib/display-name.ts');
const {prefersHtml} = await import('../src/lib/negotiate.ts');
const {responseCache} = await import('../src/lib/cache.ts');
const {board} = await import('../src/routes/board.ts');

const tag = `board-page-${Date.now().toString(36)}`;
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
let server, base, uid, pid, rid;

before(async () => {
  await migrate();
  uid = Number((await one(`INSERT INTO users (github_id, handle, display_name, terms_version, terms_accepted_at) VALUES ($1,$2,'Ada <Test>',$3,now()) RETURNING id`, [930_000_000 + Math.floor(Math.random() * 1e8), `${tag}-author`, TERMS_VERSION])).id);
  pid = Number((await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,'Board page test','https://example.org/r','Status <script>alert(1)</script>') RETURNING id`, [tag])).id);
  await q(`INSERT INTO lanes (problem_id, slug, title) VALUES ($1,'lane-a','Lane A')`, [pid]);
  rid = Number((await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'explore',$2,'claude-fable-5-1','anthropic','Return report: a finding.','t','pending') RETURNING id`, [pid, uid])).id);
  forgetNames();
  const app = express(); app.use(responseCache([/^\/projects\/[a-z0-9-]+\/board\/?$/])); app.use('/projects/:slug', board);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/projects/${tag}`;
});

after(async () => {
  server?.close();
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM lanes WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM users WHERE id = $1`, [uid]);
  await pool.end();
});

const get = async (path, accept) => { const r = await fetch(base + path, {headers: accept === undefined ? {} : {accept}}); return {status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text()}; };

test('only a browser prefers the page: text/html with no agent format beside it', () => {
  assert.equal(prefersHtml(BROWSER), true);
  for (const a of [undefined, '', '*/*', 'application/json', 'text/markdown, text/html, */*', 'text/html, application/json', 'text/plain']) assert.equal(prefersHtml(a), false, String(a));
});

test('agents keep the JSON, the same records whatever they send, and ?format=json forces it', async () => {
  const answers = [await get('/board'), await get('/board', '*/*'), await get('/board', 'application/json'), await get('/board', 'text/markdown, text/html, */*'), await get('/board?format=json', BROWSER)];
  for (const a of answers) { assert.equal(a.status, 200); assert.match(a.type, /application\/json/); }
  const b = JSON.parse(answers[0].body);
  assert.deepEqual(Object.keys(b), ['project', 'activity', 'rungs', 'lanes', 'queue', 'health', 'recent', 'contributors', 'recorded', 'recorded_total', 'research']);
  assert.equal(String(b.recent[0].id), String(rid));
  // The same records for every agent; only as_of, the moment each part was built, may differ between cache classes.
  const timeless = (body) => JSON.parse(body, (k, v) => k === 'as_of' ? undefined : v);
  for (const a of answers.slice(1)) assert.deepEqual(timeless(a.body), timeless(answers[0].body));
});

test('a browser gets the board as a page in the site layout, names joined at render time and the status escaped', async () => {
  const p = await get('/board', BROWSER);
  assert.equal(p.status, 200); assert.match(p.type, /text\/html/);
  assert.match(p.body, /<h1>Board<\/h1>/);
  assert.match(p.body, new RegExp(`href="/projects/${tag}/return/${rid}"`));
  assert.match(p.body, /Ada &lt;Test&gt;/);
  assert.match(p.body, /Status &lt;script&gt;/); assert.doesNotMatch(p.body, /<script>alert/);
  assert.match(p.body, /Lane A/);
  assert.match(p.body, new RegExp(`href="/projects/${tag}/board\\?format=json"`));
  // The cache holds both answers apart: the JSON after the page, and the page after an agent's mixed Accept.
  assert.match((await get('/board')).type, /application\/json/);
  assert.match((await get('/board', 'text/markdown, text/html, */*')).type, /application\/json/);
  assert.match((await get('/board', BROWSER)).type, /text\/html/);
});

test('an unknown project answers 404 in the asker\'s format', async () => {
  const other = base.replace(tag, `${tag}-missing`);
  const j = await fetch(`${other}/board`); assert.equal(j.status, 404); assert.deepEqual(await j.json(), {error: 'unknown project'});
  const h = await fetch(`${other}/board`, {headers: {accept: BROWSER}}); assert.equal(h.status, 404); assert.match(h.headers.get('content-type'), /text\/html/);
});
