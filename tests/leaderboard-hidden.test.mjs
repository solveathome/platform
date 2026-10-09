import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// GET /leaderboard (across projects) leaves a hidden project's credit out, the listed rule of /projects, the sitemap, the dump and
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
  for (const h of ['both', 'hiddenonly']) ids[h] = (await one(`INSERT INTO users (github_id, handle) VALUES ($1,$2) RETURNING id`, [960_000_000 + Math.floor(Math.random() * 1e8), `${tag}-${h}`])).id;
  const pay = (user, slug, points, model) => q(`INSERT INTO credits (user_id, model, provider, problem_id, kind, points, source_type, source_id, note) VALUES ($1,$2,'test',$3,'result',$4,'return','0',$5)`, [ids[user], model, ids[slug], points, tag]);
  await pay('both', shown, 10, `${tag}-model-shown`);
  await pay('both', hidden, 1000, `${tag}-model-hidden`);
  await pay('hiddenonly', hidden, 500, `${tag}-model-hidden`);
  const app = express();
  app.use('/projects/:slug', async (req, _res, next) => { req.project = await one(`SELECT * FROM problems WHERE slug = $1`, [req.params.slug]); next(); }, board);
  app.use(root);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.close();
  await q(`DELETE FROM credits WHERE note = $1`, [tag]);
  await q(`DELETE FROM users WHERE handle LIKE $1`, [`${tag}-%`]);
  await q(`DELETE FROM problems WHERE slug LIKE $1`, [`${tag}-%`]);
  const left = await one(`SELECT (SELECT count(*) FROM credits WHERE note = $1) + (SELECT count(*) FROM users WHERE handle LIKE $2) + (SELECT count(*) FROM problems WHERE slug LIKE $2) AS n`, [tag, `${tag}-%`]);
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
    assert.ok(!lb.by_kind.result.some(h => h.handle === `${tag}-hiddenonly`), w);
    assert.ok(!JSON.stringify(lb).includes(hidden), w);
  }
});

test('the hidden project\'s own board still counts its credit', async () => {
  const lb = await get(`/projects/${hidden}/leaderboard?window=all`);
  assert.deepEqual(lb.humans.filter(h => h.handle.startsWith(tag)).map(h => [h.handle, Number(h.points)]).sort(), [[`${tag}-both`, 1000], [`${tag}-hiddenonly`, 500]]);
});
