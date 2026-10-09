import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// GET /leaderboard (across projects) and a person's public profile (/@handle) leave a hidden project's credit and slug out, the listed rule of /projects, the sitemap, the dump and
// the front page (Oct 9 2026: MD5 points must not show before MD5 is public). Its own project board still counts it.
// Real Postgres (TEST_DATABASE_URL); everything created is deleted.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the leaderboard tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const tag = `lbh-${Date.now().toString(36)}`;
const shown = `${tag}-shown`, hidden = `${tag}-hidden`;
const projectsDir = mkdtempSync(join(tmpdir(), 'leaderboard-projects-'));
process.env.PROJECTS_DIR = projectsDir;
for (const [slug, listed] of [[shown, true], [hidden, false]]) {
  mkdirSync(join(projectsDir, slug));
  writeFileSync(join(projectsDir, slug, 'project.json'), JSON.stringify({slug, name: slug, repo_url: 'https://example.org', listed}));
}

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {root, board} = await import('../src/routes/board.ts');
const {forgetUnlisted} = await import('../src/lib/projects.ts');

const ids = {};
let server, base;
before(async () => {
  await migrate();
  forgetUnlisted();
  for (const slug of [shown, hidden]) ids[slug] = (await one(`INSERT INTO problems (slug, name, repo_url) VALUES ($1,$1,'https://example.org') RETURNING id`, [slug])).id;
  for (const h of ['both', 'onlyhid']) ids[h] = (await one(`INSERT INTO users (github_id, handle) VALUES ($1,$2) RETURNING id`, [960_000_000 + Math.floor(Math.random() * 1e8), `${tag}-${h}`])).id;
  const pay = (user, slug, points, model) => q(`INSERT INTO credits (user_id, model, provider, problem_id, kind, points, source_type, source_id, note) VALUES ($1,$2,'test',$3,'result',$4,'return','0',$5)`, [ids[user], model, ids[slug], points, tag]);
  await pay('both', shown, 10, `${tag}-model-shown`);
  await pay('both', hidden, 1000, `${tag}-model-hidden`);
  await pay('onlyhid', hidden, 500, `${tag}-model-hidden`);
  for (const [slug, model] of [[shown, `${tag}-model-shown`], [hidden, `${tag}-model-hidden`]]) await q(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'explore',$2,$3,'test',$4,'t','pending')`, [ids[slug], ids.both, model, tag]);
  // The all-project reputation row counts one accepted return on each project, a rejected one on the hidden project, and both projects' CPU hours.
  await q(`INSERT INTO reputation (user_id, accepted, rejected, cpu_hours) VALUES ($1, 2, 1, 7)`, [ids.both]);
  for (const [slug, status, cpu] of [[shown, 'accepted', 2], [hidden, 'accepted', 3], [hidden, 'rejected', 2]]) {
    const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, cpu_hours) VALUES ($1,'proof',$2,'m','test',$3,'t',$4,$5) RETURNING id`, [ids[slug], ids.both, tag, status, cpu]);
    await q(`INSERT INTO return_decisions (return_id, status, by, note) VALUES ($1,$2,'trusted',$3)`, [r.id, status, tag]);
  }
  const app = express();
  app.use('/projects/:slug', async (req, _res, next) => { req.project = await one(`SELECT * FROM problems WHERE slug = $1`, [req.params.slug]); next(); }, board);
  app.use(root);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.close();
  await q(`DELETE FROM credits WHERE note = $1`, [tag]);
  await q(`DELETE FROM return_decisions WHERE note = $1`, [tag]);
  await q(`DELETE FROM reputation WHERE user_id = ANY($1::bigint[])`, [[ids.both, ids.onlyhid].filter(Boolean)]);
  await q(`DELETE FROM returns WHERE report_md = $1`, [tag]);
  await q(`DELETE FROM users WHERE handle LIKE $1`, [`${tag}-%`]);
  await q(`DELETE FROM problems WHERE slug LIKE $1`, [`${tag}-%`]);
  const left = await one(`SELECT (SELECT count(*) FROM credits WHERE note = $1) + (SELECT count(*) FROM returns WHERE report_md = $1) + (SELECT count(*) FROM users WHERE handle LIKE $2) + (SELECT count(*) FROM problems WHERE slug LIKE $2) AS n`, [tag, `${tag}-%`]);
  assert.equal(Number(left.n), 0, 'test rows left behind');
  await pool.end();
  rmSync(projectsDir, {recursive: true, force: true});
});

const get = async path => (await fetch(base + path, {headers: {accept: 'application/json'}})).json();

test('the cross-project leaderboard leaves out a hidden project\'s credit', async () => {
  for (const w of ['all', '30d', '7d']) {
    const lb = await get(`/leaderboard?window=${w}`);
    const mine = lb.humans.filter(h => h.handle.startsWith(tag));
    assert.deepEqual(mine.map(h => [h.handle, Number(h.points)]), [[`${tag}-both`, 10]], w);
    assert.ok(!lb.models.some(m => m.model === `${tag}-model-hidden`), w);
    assert.ok(!lb.by_kind.result.some(h => h.handle === `${tag}-onlyhid`), w);
    assert.ok(!JSON.stringify(lb).includes(hidden), w);
  }
});

test('the hidden project\'s own board still counts its credit', async () => {
  const lb = await get(`/projects/${hidden}/leaderboard?window=all`);
  assert.deepEqual(lb.humans.filter(h => h.handle.startsWith(tag)).map(h => [h.handle, Number(h.points)]).sort(), [[`${tag}-both`, 1000], [`${tag}-onlyhid`, 500]]);
});

test('a public profile shows no hidden-project credit, slug, return or model', async () => {
  const both = await get(`/@${tag}-both`);
  const body = JSON.stringify(both);
  assert.ok(!body.includes(hidden), 'hidden slug on the profile');
  assert.ok(!body.includes(`${tag}-model-hidden`), 'hidden-project model on the profile');
  assert.equal(both.credit.total, 10);
  assert.deepEqual(both.credit.ledger.map(c => [c.project, Number(c.points)]), [[shown, 10]]);
  assert.equal(both.standing.points, 10);
  assert.deepEqual([...new Set(both.recent.map(r => r.project))], [shown]);
  assert.equal(both.work.submitted, 2);
  const only = await get(`/@${tag}-onlyhid`);
  assert.equal(only.credit.total, 0);
  assert.deepEqual(only.credit.ledger, []);
  assert.ok(!JSON.stringify(only).includes(hidden));
});

test('a public profile\'s reputation figures leave out hidden-project work', async () => {
  const both = await get(`/@${tag}-both`);
  assert.deepEqual([both.agent_time.accepted, both.agent_time.rejected], [1, 0]);
  assert.equal(Number(both.compute.cpu_hours), 2);
  assert.equal(both.contributor.accepted, undefined, 'raw all-project counters on the profile');
});
