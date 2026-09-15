import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Issue #84: a return's recipe can send a reviewer to artifacts that were never uploaded. Return #569 told reviewers to fetch
// two files "attached to this return" while `files` was empty and both content addresses answered 404, and nothing said so.
//
// The rule these tests pin down is deliberately narrow, because it was calibrated against every return that carries a recipe
// (504 of them on 2026-09-15). Warning on any unresolvable hash in a recipe would have fired on 99 of those, and on returns
// where no hash at all resolves on 23 — nearly all of them legitimate: an expected output hash resolves to nothing until a
// reviewer regenerates it, and a recipe that rebuilds a file from a verbatim block in the report needs no upload. The two
// contradictions below fired on 2 returns, both genuinely broken. The false-positive cases are kept here as tests so the
// rule cannot be widened by accident.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the recipe artifact tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const tmp = mkdtempSync(join(tmpdir(), 'recipe-'));
process.env.FILES_DIR = join(tmp, 'files');

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const files = await import('../src/lib/files.ts');

const tag = `recipe-test-${Date.now().toString(36)}`;
let uid, stored;

before(async () => {
  await migrate();
  uid = Number((await one(`INSERT INTO users (github_id, handle) VALUES ($1,$2) RETURNING id`, [940_000_000 + Math.floor(Math.random() * 1e8), tag])).id);
  stored = (await files.store(uid, 'fixture', 'check.py', 'py', 'print("ok")\n')).sha;
});
after(async () => {
  await q(`DELETE FROM file_refs WHERE file_sha IN (SELECT sha256 FROM files WHERE user_id = $1)`, [uid]);
  await q(`DELETE FROM files WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM users WHERE id = $1`, [uid]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE id = $1) + (SELECT count(*) FROM files WHERE user_id = $1) AS n`, [uid]);
  await pool.end(); rmSync(tmp, {recursive: true, force: true});
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const absent = 'b'.repeat(64), other = 'c'.repeat(64);

test('a recipe that says its artifacts are attached, on a return that attaches nothing, is reported (return #569)', async () => {
  const recipe = `1. Fetch and verify the two artifacts attached to this return:\n   sha256(design.py) = ${absent}\n2. Run: python3 design.py --out design.json`;
  const gaps = await files.recipeGaps(recipe, []);
  assert.equal(gaps.claims_attachments, true);
  assert.deepEqual(gaps.unfetchable, [], 'no /files/ URL was written, so nothing is reported as unfetchable');
  assert.equal(files.recipeGapsFound(gaps), true);
  const [warning] = files.recipeGapWarnings(gaps, 'https://example.test');
  assert.match(warning, /attaches no files/); assert.match(warning, /POST https:\/\/example\.test\/files/);
  assert.match(files.recipeGapNote(gaps), /unverifiable in budget/, 'the reviewer is routed to the repair path, not left to hunt');
  assert.equal(files.recipeGapsFound(await files.recipeGaps(recipe, [stored])), false, 'the same recipe is fine once the artifacts are attached');
});

test('a recipe that hands out a /files/<sha256> URL for bytes that are not in the store is reported (return #295)', async () => {
  const gaps = await files.recipeGaps(`Fetch GET <project base>/files/${absent} and GET /files/${stored}, then run both.`, [stored]);
  assert.deepEqual(gaps.unfetchable, [absent]);
  assert.equal(gaps.claims_attachments, false, 'the return attaches a file, so its recipe claims nothing false');
  const [warning] = files.recipeGapWarnings(gaps, 'https://example.test');
  assert.match(warning, /1 artifact/); assert.match(warning, new RegExp(absent.slice(0, 12)));
  assert.doesNotMatch(warning, new RegExp(stored.slice(0, 12)), 'a file that is in the store is not named');
  assert.match(files.recipeGapNote(gaps), /not in the store/);
});

test('the legitimate recipes that a wider rule would have flagged are left alone', async () => {
  // Rebuilt from a verbatim block in the report: complete with no upload at all (returns #161, #163).
  const verbatim = `1. Rebuild src/main.c from the verbatim block in the report (sha256 ${absent}) and compile per its header.\n2. Run the sweep; out-L-ext.txt sha256 ${other}.`;
  assert.equal(files.recipeGapsFound(await files.recipeGaps(verbatim, [])), false);
  // A served script plus an expected output hash the reviewer regenerates (returns #109, #165).
  const served = `1. Fetch <project base>/docs/research/measurement.js unchanged.\n2. node research/measurement.js > out.txt; expected sha256 ${absent}.`;
  assert.equal(files.recipeGapsFound(await files.recipeGaps(served, [])), false);
  // Another return's attachments are that return's business, not this one's.
  assert.equal(files.recipeGapsFound(await files.recipeGaps(`Use the files attached to return #467, listed there.`, [])), false);
  // A recipe with no hashes at all, and an empty recipe.
  assert.equal(files.recipeGapsFound(await files.recipeGaps('Run the served script and read the table.', [])), false);
  assert.equal(files.recipeGapsFound(await files.recipeGaps(null, [])), false);
  assert.equal(files.recipeGapWarnings(await files.recipeGaps(null, []), 'https://example.test').length, 0);
  assert.equal(files.recipeGapNote(await files.recipeGaps(null, [])), '');
});
