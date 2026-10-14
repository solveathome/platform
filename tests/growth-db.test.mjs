import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// The growth cap against Postgres (mba #mba-bot-sites-growth-cap; src/lib/growth.ts): the boot backfill, the gate between scans,
// the first scan's kept set (units first public by the end of the scan's day), a rate change on the same scan, a later scan's
// release order, the author's index:false, and the sitemap leaving held units out. Real Postgres (TEST_DATABASE_URL); the cap's
// state is global, so it is saved first and put back, and every row created is deleted.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the growth cap tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const tag = `growth-${Date.now().toString(36)}`;
const projectsDir = mkdtempSync(join(tmpdir(), 'growth-projects-'));
process.env.PROJECTS_DIR = projectsDir;
mkdirSync(join(projectsDir, tag));
writeFileSync(join(projectsDir, tag, 'project.json'), JSON.stringify({slug: tag, name: tag, repo_url: 'https://example.org'}));

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {forgetUnlisted} = await import('../src/lib/projects.ts');
const G = await import('../src/lib/growth.ts');
const {sitemapEntries, sitemapUrls} = await import('../src/routes/seo.ts');

const day = (offset) => new Date(Date.now() + offset * 86400e3).toISOString().slice(0, 10);
const ids = {};
let saved, others;
const ret = async (name, firstIndexed) => {
  const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'explore',$2,'m','test',$3,'t','recorded') RETURNING id`, [ids.problem, ids.user, `${tag} ${name}`]);
  await q(`UPDATE returns SET first_indexed_at = $2 WHERE id = $1`, [r.id, firstIndexed]);
  return ids[name] = Number(r.id);
};
const row = (id) => one(`SELECT first_indexed_at, index_held_at, index_ok FROM returns WHERE id = $1`, [id]);
const listed = async () => new Set((await sitemapEntries()).filter((u) => u.unit === 'return').map((u) => Number(u.loc.split('/').pop())));

before(async () => {
  await migrate();
  forgetUnlisted();
  saved = await one(`SELECT * FROM growth_cap WHERE id = 1`);
  await q(`DELETE FROM growth_cap`);
  // units already on record from other tests or a snapshot are put before yesterday, so they are all in the first scan's kept set
  others = await q(`SELECT id, first_indexed_at, index_held_at FROM returns UNION ALL SELECT -id, first_indexed_at, index_held_at FROM research_routes`);
  await q(`UPDATE returns SET first_indexed_at = LEAST(COALESCE(first_indexed_at, created_at), now() - interval '3 days'), index_held_at = NULL`);
  await q(`UPDATE research_routes SET first_indexed_at = LEAST(COALESCE(first_indexed_at, created_at), now() - interval '3 days'), index_held_at = NULL`);
  ids.problem = Number((await one(`INSERT INTO problems (slug, name, repo_url) VALUES ($1,$1,'https://example.org') RETURNING id`, [tag])).id);
  ids.user = Number((await one(`INSERT INTO users (github_id, handle) VALUES ($1,$2) RETURNING id`, [970_000_000 + Math.floor(Math.random() * 1e7), tag])).id);
});

after(async () => {
  await q(`DELETE FROM return_dependencies WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1) OR depends_on_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [ids.problem]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [ids.problem]);
  await q(`DELETE FROM users WHERE id = $1`, [ids.user]);
  await q(`DELETE FROM problems WHERE id = $1`, [ids.problem]);
  for (const o of others ?? []) await q(`UPDATE ${Number(o.id) < 0 ? 'research_routes' : 'returns'} SET first_indexed_at = $2, index_held_at = $3 WHERE id = $1`, [Math.abs(Number(o.id)), o.first_indexed_at, o.index_held_at]);
  await q(`DELETE FROM growth_cap`);
  if (saved) await q(`INSERT INTO growth_cap (id, scan_date, baseline, cap, rate, google_indexed, google_not_indexed, updated_at, updated_by) VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8)`,
    [saved.scan_date, saved.baseline, saved.cap, saved.rate, saved.google_indexed, saved.google_not_indexed, saved.updated_at, saved.updated_by]);
  await pool.end();
  rmSync(projectsDir, {recursive: true, force: true});
});

test('the migration ran its backfill once: a unit recorded later is not let in by a second boot', async () => {
  const id = await ret('late', null);
  await migrate();
  assert.equal((await row(id)).first_indexed_at, null);
  await q(`DELETE FROM returns WHERE id = $1`, [id]);
});

test('no scan yet: no cap, a new unit goes straight in', async () => {
  const id = await ret('first', null);
  const g = await G.gate();
  assert.ok(g.admitted.some((u) => u.id === id));
  assert.ok((await row(id)).first_indexed_at);
  assert.ok((await listed()).has(id));
});

test('the first scan keeps what was public by the end of its day and holds the rest beyond the cap', async () => {
  await ret('a', new Date(Date.now() - 2 * 86400e3));
  for (const [name, second] of [['c', 1], ['d', 2], ['e', 3]]) await ret(name, `${day(0)}T00:00:0${second}Z`);
  await q(`INSERT INTO return_dependencies (return_id, depends_on_id) VALUES ($1,$2)`, [ids.a, ids.d]);   // d is cited: the most used
  const before = (await sitemapEntries()).length;
  const s = await G.takeScan({scan_date: day(-1), growth_rate: 0, google_indexed: 10, google_not_indexed: 5}, 'test');
  assert.equal(s.http, 200);
  assert.equal(s.baseline, before - 4 + 0, 'the baseline leaves out the first unit and c, d, e, all first public after the scan day');
  assert.equal(s.cap, s.baseline);
  for (const n of ['first', 'c', 'd', 'e']) assert.ok((await row(ids[n])).index_held_at, `${n} held`);
  assert.equal((await row(ids.a)).index_held_at, null);
  const now = await listed();
  assert.ok(now.has(ids.a) && !now.has(ids.c) && !now.has(ids.d));
  assert.equal((await sitemapEntries()).length, s.cap);
  assert.deepEqual(await G.returnIndexState(ids.c).then((x) => [x.indexed, x.held]), [false, true]);
});

test('between scans the gate holds a new unit at the cap; the same scan with another rate only moves the cap', async () => {
  const f = await ret('f', null);
  await G.gate();
  assert.ok((await row(f)).index_held_at, 'at the cap: held');
  const st = await G.growthState();
  const same = await G.takeScan({scan_date: day(-1), growth_rate: 2.5 / st.baseline}, 'test');
  assert.equal(same.cap, st.baseline + 2);
  assert.equal(same.released, 0);
  assert.ok((await row(ids.c)).index_held_at, 'nothing released by a rate change');
  const again = await G.takeScan({scan_date: day(-1)}, 'test');
  assert.equal(again.cap, st.baseline + 2, 'the same scan without a rate changes nothing');
  const g = await ret('g', null);
  await G.gate();
  assert.ok((await row(g)).first_indexed_at && !(await row(g)).index_held_at, 'room under the moved cap: in');
  const older = await G.takeScan({scan_date: day(-2), growth_rate: 0.5}, 'test');
  assert.equal(older.cap, st.baseline + 2, 'an older scan changes nothing');
});

test('the author may keep its page out: not held, not counted, and a later index:true goes through the gate', async () => {
  const h = await ret('h', null);
  await q(`UPDATE returns SET index_ok = false, index_reason = 'thin' WHERE id = $1`, [h]);
  await G.gate();
  const r = await row(h);
  assert.equal(r.first_indexed_at, null); assert.equal(r.index_held_at, null);
  assert.match((await G.returnIndexState(h)).reason, /you sent index:false \(thin\)/);
  assert.equal((await G.growthState()).writer_noindex >= 1, true);
  await q(`UPDATE returns SET index_ok = NULL, index_reason = NULL WHERE id = $1`, [h]);
  await G.gate();
  assert.ok((await row(h)).first_indexed_at && !(await row(h)).index_held_at, 'the last room under the cap: in');
  const k = await ret('k', null);
  await G.gate();
  assert.ok((await row(k)).index_held_at, 'at the cap again: held like any new page');
});

test('a later scan keeps what is indexable now and releases the most cited, then the newest, up to the cap', async () => {
  const st = await G.growthState();
  const s = await G.takeScan({scan_date: day(0), growth_rate: 2.5 / st.indexable}, 'test');
  assert.equal(s.baseline, st.indexable);
  assert.equal(s.cap, st.indexable + 2);
  assert.equal(s.released, 2);
  // held: first (let in before the first scan, then held), c, d (cited), e (first public just after the scan day), f and k (recorded later, never let in)
  assert.ok(!(await row(ids.d)).index_held_at, 'd: cited, first');
  assert.ok(!(await row(ids.k)).index_held_at && (await row(ids.k)).first_indexed_at, 'k: the newest');
  for (const n of ['first', 'c', 'e', 'f']) assert.ok((await row(ids[n])).index_held_at, `${n} still held`);
  assert.equal((await sitemapEntries()).length, s.cap);
  assert.equal((await sitemapUrls()).length, s.cap, 'the sitemap with its sweep agrees');
  assert.match(await G.growthLine(), new RegExp(`^Growth cap \\(Google scan ${day(0)}\\): `));
  assert.match(await G.growthBriefLine(), / of .* indexable pages used until Google's next scan, \d+ waiting$/);
});

test('a held return answers as before, with noindex in its meta and header; a kept one has neither', async () => {
  const express = (await import('express')).default;
  const {job} = await import('../src/routes/job.ts');
  const app = express();
  app.use('/projects/:slug', job);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const page = async (id) => { const res = await fetch(`http://127.0.0.1:${server.address().port}/projects/${tag}/return/${id}`, {headers: {accept: 'text/html'}}); return {status: res.status, robots: res.headers.get('x-robots-tag'), html: await res.text()}; };
    const held = await page(ids.c), kept = await page(ids.a);
    assert.equal(held.status, 200); assert.equal(held.robots, 'noindex'); assert.match(held.html, /<meta name="robots" content="noindex, follow">/);
    assert.equal(kept.status, 200); assert.equal(kept.robots, null); assert.doesNotMatch(kept.html, /<meta name="robots"/);
  } finally { server.close(); }
});

test('a scan date in the future or a rate out of range is refused', async () => {
  assert.equal((await G.takeScan({scan_date: day(2)}, 'test')).http, 422);
  assert.equal((await G.takeScan({scan_date: day(0), growth_rate: 2}, 'test')).http, 422);
  assert.equal((await G.takeScan({scan_date: 'yesterday'}, 'test')).http, 422);
});
