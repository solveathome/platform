import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// An empty queue hands out one open question per session, never the same one twice inside the window, and once every
// question is in hand a lead hunt from a rotating menu (Chris, Sep 11 2026: Opus sessions that fit no queued job were
// re-served the same five questions and came back "already scored"). Real Postgres; everything created is deleted.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the explore fallback tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';
const docs = mkdtempSync(join(tmpdir(), 'sah-explore-'));
process.env.DOCS_DIR = docs;

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job} = await import('../src/routes/job.ts');

const tag = `explore-test-${Date.now().toString(36)}`;
let server, base, uid, other, pid, token;

before(async () => {
  await migrate();
  mkdirSync(join(docs, tag, 'research'), {recursive: true});
  writeFileSync(join(docs, tag, 'research', 'QUESTIONS.md'), `| item | question | status | verdict |\n|---|---|---|---|\n| 1 | \`Q-alpha\` first thing | OPEN | nothing yet |\n| 2 | \`Q-beta\` second thing | PARTIAL | half done |\n| 3 | \`Q-gamma\` settled thing | CLOSED | done |\n`);
  uid = Number((await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [910_000_000 + Math.floor(Math.random() * 1e8), `${tag}-opus`, TERMS_VERSION])).id);
  other = Number((await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [910_000_000 + Math.floor(Math.random() * 1e8), `${tag}-other`, TERMS_VERSION])).id);
  token = await issueToken(uid, 'explore-test');
  pid = Number((await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,$2,'https://example.org/r','open') RETURNING id`, [tag, 'Explore fallback test'])).id);
  await one(`INSERT INTO channels (problem_id, path, title) VALUES ($1,'','Project') RETURNING id`, [pid]);
  await q(`INSERT INTO lanes (problem_id, slug, title) VALUES ($1,'lane-a','Lane A')`, [pid]);
  // One accepted return by someone else: a target for the prior-art and break hunts.
  await q(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, final_rung) VALUES ($1,'measure',$2,'claude-fable-5-1','anthropic','A measured bound on the corner count.\nMore below.','t','accepted','measured')`, [pid, other]);
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/projects/${tag}`;
});
after(async () => {
  server?.close();
  await q(`DELETE FROM messages WHERE user_id = ANY($1)`, [[uid, other]]);
  await q(`DELETE FROM channel_members WHERE user_id = ANY($1)`, [[uid, other]]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM sessions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM pool WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM lanes WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM tokens WHERE user_id = ANY($1)`, [[uid, other]]);
  await q(`DELETE FROM reputation WHERE user_id = ANY($1)`, [[uid, other]]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [[uid, other]]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE id = ANY($1)) + (SELECT count(*) FROM problems WHERE id = $2) + (SELECT count(*) FROM jobs WHERE problem_id = $2) AS n`, [[uid, other], pid]);
  await pool.end();
  rmSync(docs, {recursive: true, force: true});
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const register = async () => {
  const r = await fetch(base + '/start', {method: 'POST', headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', 'x-model': 'claude-opus-5'}, body: JSON.stringify({agreed: true, ai: {max_hours_per_assignment: 1, max_assignments: 1}, transcript_preapproved: true})});
  const t = await r.text(); assert.equal(r.status, 200, t); const j = JSON.parse(t);
  j.title = (await one(`SELECT title FROM jobs WHERE id = $1`, [j.job_id])).title;   // the response carries the brief, the row carries the title
  return j;
};

test('an empty queue hands each session a different open question, one per job, and skips closed ones', async () => {
  const a = await register();
  assert.equal(a.type, 'explore');
  assert.equal(a.title, 'Explore: Q-alpha in lane-a');
  assert.match(a.brief_md, /`Q-alpha` \(OPEN\): first thing/);
  assert.doesNotMatch(a.brief_md, /Q-beta/, 'a second question leaked into a one-question brief');
  const b = await register();
  assert.equal(b.title, 'Explore: Q-beta in lane-a', 'the next session got the same question again');
  assert.match(b.brief_md, /Record so far: half done/);
  assert.doesNotMatch(b.brief_md, /Q-gamma/, 'a closed question was served');
});

test('once every open question is in hand, the fallback rotates through lead hunts', async () => {
  const seen = [];
  for (let i = 0; i < 6; i++) seen.push((await register()).title);
  assert.deepEqual(seen.map(t => t.split(':')[0]), Array(6).fill('Leads'), seen.join(' | '));
  assert.equal(new Set(seen).size, 6, `the menu repeated inside one rotation: ${seen.join(' | ')}`);
  const priorArt = await one(`SELECT brief_md FROM jobs WHERE problem_id = $1 AND title LIKE 'Leads: prior art%'`, [pid]);
  assert.match(priorArt.brief_md, /Prior-art hunt/); assert.match(priorArt.brief_md, /by @.*-other\)/, 'the hunt did not point at the accepted return');
  const breakIt = await one(`SELECT brief_md FROM jobs WHERE problem_id = $1 AND title LIKE 'Leads: break%'`, [pid]);
  assert.match(breakIt.brief_md, /request_review/);
  for (const t of ['registry sweep', 'cross-lane synthesis', 'new route', 'new statistic']) assert.ok(seen.includes(`Leads: ${t}`), `missing hunt: ${t}`);
});
