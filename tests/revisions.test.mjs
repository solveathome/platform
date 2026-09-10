import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// A link into a document must always resolve to the text that was linked (Chris, Sep 10 2026): version 1 is kept as a blob when the
// swarm first revises a document, and a mirror cut that changes a document with history is recorded as its next version.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the revision tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const tmp = mkdtempSync(join(tmpdir(), 'sah-rev-'));
process.env.DOCS_DIR = join(tmp, 'repos'); process.env.OVERLAY_DIR = join(tmp, 'overlay'); process.env.FILES_DIR = join(tmp, 'files');

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const files = await import('../src/lib/files.ts');
const {integrate, recordMirrorCut, history, revisedPaths} = await import('../src/lib/revisions.ts');

const tag = `rev-test-${Date.now().toString(36)}`;
const slug = tag, rel = 'research/NOTE.md';
let uid, pid, retId;
const mirror = (text) => { mkdirSync(join(tmp, 'repos', slug, 'research'), {recursive: true}); writeFileSync(join(tmp, 'repos', slug, rel), text); };

before(async () => {
  await migrate();
  const u = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), `${tag}-researcher`, TERMS_VERSION]);
  uid = Number(u.id);
  const p = await one(`INSERT INTO problems (slug, name, repo_url, status_md, researcher_user_id) VALUES ($1,$2,'https://example.org/r','open',$3) RETURNING id`, [slug, 'Revisions test', uid]);
  pid = Number(p.id);
  mirror('# Note\n\nOriginal text.\n');
  const {sha} = await files.store(uid, 'claude-opus-5', 'NOTE.md', 'md', '# Note\n\nRevised by the swarm.\n');
  const r = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, revision_path, revision_sha) VALUES ($1,'audit',$2,'claude-opus-5','anthropic','Fixed the wording.','t','accepted',$3,$4) RETURNING id`, [pid, uid, rel, sha]);
  retId = Number(r.id);
});

after(async () => {
  await q(`DELETE FROM file_refs WHERE file_sha IN (SELECT sha256 FROM files WHERE user_id = $1)`, [uid]);
  await q(`DELETE FROM document_versions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM files WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM reputation WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM users WHERE id = $1`, [uid]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE id = $1) + (SELECT count(*) FROM problems WHERE id = $2) + (SELECT count(*) FROM document_versions WHERE problem_id = $2) + (SELECT count(*) FROM files WHERE user_id = $1) AS n`, [uid, pid]);
  await pool.end();
  rmSync(tmp, {recursive: true, force: true});
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

test('the first accepted revision keeps the original as a pinned blob', async () => {
  const ret = await one(`SELECT * FROM returns WHERE id = $1`, [retId]);
  await integrate(ret, slug, [{verdict: 'accept', user_id: uid, model: 'claude-fable-5-1', verification: 'read'}]);
  const h = await history(pid, rel);
  assert.equal(h.length, 2);
  assert.ok(h[0].content_sha, 'version 1 has a blob');
  assert.equal(files.read(h[0].content_sha), '# Note\n\nOriginal text.\n');
  const pinned = await q(`SELECT ref_type FROM file_refs WHERE file_sha = ANY($1)`, [[h[0].content_sha, h[1].content_sha]]);
  assert.equal(pinned.filter(r => r.ref_type === 'document_version').length, 2, 'both versions pinned against curation');
  assert.ok(existsSync(join(tmp, 'overlay', slug, rel)), 'the overlay serves the revision');
  assert.equal((await revisedPaths(pid)).get(rel).swarm, true);
});

test('a mirror cut that catches up drops the overlay and records nothing', async () => {
  mirror('# Note\n\nRevised by the swarm.\n');
  const r = await recordMirrorCut(slug, pid);
  assert.deepEqual(r, [{path: rel, action: 'caught-up', version: 2}]);
  assert.ok(!existsSync(join(tmp, 'overlay', slug, rel)));
  assert.equal((await history(pid, rel)).length, 2);
  assert.deepEqual(await recordMirrorCut(slug, pid), [{path: rel, action: 'unchanged', version: 2}]);
});

test('a mirror cut that changes a document with history is its next version, with a blob and a diff', async () => {
  mirror('# Note\n\nRewritten by the researcher.\n');
  const r = await recordMirrorCut(slug, pid, 'private abc123');
  assert.deepEqual(r, [{path: rel, action: 'recorded', version: 3}]);
  const h = await history(pid, rel);
  assert.equal(h.length, 3);
  assert.equal(h[2].return_id, null); assert.equal(Number(h[2].author_user_id ?? uid), uid);
  assert.equal(files.read(h[2].content_sha), '# Note\n\nRewritten by the researcher.\n');
  assert.match(h[2].summary, /cut of \d{4}-\d{2}-\d{2} \(private abc123\)/);
  const d = await one(`SELECT diff FROM document_versions WHERE problem_id = $1 AND path = $2 AND version = 3`, [pid, rel]);
  assert.match(d.diff, /-Revised by the swarm\.\n\+Rewritten by the researcher\./);
  assert.equal((await revisedPaths(pid)).get(rel).swarm, false);
});
