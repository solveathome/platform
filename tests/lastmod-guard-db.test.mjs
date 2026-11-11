import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFileSync } from "node:fs";
import pg from "pg";

// The lastmod guard (#r2532, mba ask 7870), run in a throwaway schema of TEST_DATABASE_URL: the content_at triggers and the guard
// from src/db/schema.sql on minimal papers and research_routes tables. It replays a backfill that re-dates many pages with their
// content unchanged, a date set without content, a back-date, a real save, every page really changing at once, and a first date.
if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a disposable database.");
const SCHEMA = `lastmod_guard_test_${process.pid}`;
const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
const warnings = [];
const schema = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");
const part = schema.slice(schema.indexOf("-- The day a paper's or a research route's content last changed"), schema.indexOf("-- ==== end lastmod guard ===="));

before(async () => {
  await client.connect();
  client.on("notice", (n) => warnings.push(n.message || ""));
  await client.query(`CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA}`);
  await client.query(`CREATE TABLE papers (id serial PRIMARY KEY, slug text, current_file_sha text, title text, summary text, grade text, kind text, path text, status text, note text, updated_at timestamptz DEFAULT now());
    CREATE TABLE research_routes (id serial PRIMARY KEY, title text, contribution_md text, prior_art_md text, uncertainty_md text, state text, next_step text, obstacle text, parent_route_id int, revision int DEFAULT 0, updated_at timestamptz DEFAULT now())`);
  await client.query(`INSERT INTO papers (slug, current_file_sha, title, status, updated_at) SELECT 'p' || i, 'sha', 'T' || i, 'accepted', '2026-10-12' FROM generate_series(1, 1000) i;
    INSERT INTO research_routes (title, state, updated_at) SELECT 'R' || i, 'open', '2026-10-12' FROM generate_series(1, 50) i`);
  await client.query(part);   // backfills content_at from updated_at (a first date), then the triggers
  await client.query(`ANALYZE papers`);
});
after(async () => { await client.query(`DROP SCHEMA ${SCHEMA} CASCADE`); await client.end(); });

const count = async (sql) => Number((await client.query(`SELECT count(*) FROM papers WHERE ${sql}`)).rows[0].count);
const day = async (slug) => (await client.query(`SELECT content_at::date::text d FROM papers WHERE slug = $1`, [slug])).rows[0].d;
const today = () => new Date().toISOString().slice(0, 10);

test("a backfill re-dating 600 papers with their content unchanged moves no date and warns once", async () => {
  warnings.length = 0;
  const r = await client.query(`UPDATE papers SET content_at = '2026-11-01' WHERE substr(slug, 2)::int <= 600`);
  assert.equal(r.rowCount, 600);
  assert.equal(await count(`content_at::date <> '2026-10-12'`), 0);
  assert.equal(warnings.filter((w) => w.includes("lastmod guard")).length, 1);
  assert.match(warnings[0], /600 sitemap date/);
});

test("a date stamped today without content is kept, and the rest of the row still saves", async () => {
  await client.query(`UPDATE papers SET content_at = now(), note = 'x' WHERE slug = 'p7'`);
  assert.equal(await day("p7"), "2026-10-12");
  assert.equal((await client.query(`SELECT note FROM papers WHERE slug = 'p7'`)).rows[0].note, "x");
  await client.query(`UPDATE research_routes SET content_at = now(), revision = 2 WHERE id = 1`);
  assert.equal((await client.query(`SELECT content_at::date::text d FROM research_routes WHERE id = 1`)).rows[0].d, "2026-10-12");
});

test("a date is never moved back, even with its content", async () => {
  await client.query(`UPDATE papers SET title = 'new', content_at = '2026-10-01' WHERE slug = 'p5'`);
  // papers_content_at stamps now() for the new title, so the date moves forward, never back
  assert.equal(await day("p5"), today());
  await client.query(`UPDATE papers SET content_at = '2026-10-01' WHERE slug = 'p6'`);
  assert.equal(await day("p6"), "2026-10-12");
});

test("a real save moves its date (paper text, route text), the status trip through review does not", async () => {
  await client.query(`UPDATE papers SET current_file_sha = 'sha2' WHERE slug = 'p20'`);
  await client.query(`UPDATE research_routes SET next_step = 'try x' WHERE id = 2`);
  await client.query(`UPDATE papers SET status = 'under_review' WHERE slug = 'p21'`);
  assert.equal(await day("p20"), today());
  assert.equal(await day("p21"), "2026-10-12");
  assert.equal((await client.query(`SELECT content_at::date::text d FROM research_routes WHERE id = 2`)).rows[0].d, today());
});

test("every paper really changing at once keeps every date (#r2390) and trips the warning", async () => {
  warnings.length = 0;
  await client.query(`UPDATE papers SET summary = coalesce(summary, '') || 'x'`);
  assert.equal(await count(`content_at::date = now()::date`), 1000);
  assert.equal(warnings.filter((w) => w.includes("lastmod tripwire")).length, 1);
});

test("a first date is not guarded", async () => {
  await client.query(`INSERT INTO research_routes (title, state, content_at) VALUES ('new', 'open', NULL)`);
  await client.query(`UPDATE research_routes SET content_at = '2026-09-01' WHERE title = 'new'`);
  assert.equal((await client.query(`SELECT content_at::date::text d FROM research_routes WHERE title = 'new'`)).rows[0].d, "2026-09-01");
});
