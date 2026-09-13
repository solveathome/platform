import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync} from 'node:fs';
import express from 'express';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run document-record tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const tmp = mkdtempSync(join(tmpdir(), 'sah-document-record-'));
process.env.DOCS_DIR = join(tmp, 'repos'); process.env.OVERLAY_DIR = join(tmp, 'overlay'); process.env.FILES_DIR = join(tmp, 'files');
const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {sha256} = await import('../src/lib/document-publication.ts');
const {recordPublication, documentRecords, documentDates} = await import('../src/lib/document-record.ts');
const {docs} = await import('../src/routes/docs.ts');
const {papers} = await import('../src/routes/papers.ts');
const {filesRouter} = await import('../src/routes/files.ts');
const {integrate} = await import('../src/lib/revisions.ts');
const files = await import('../src/lib/files.ts');
const slug = `dates-${Date.now().toString(36)}`, path = 'paper/note.md', root = join(process.env.DOCS_DIR, slug);
const original = '# A dated note\n\nOriginal research.\n';
const source = {created_at: '2026-01-02T03:04:05.000Z', modified_at: '2026-02-03T04:05:06.000Z', first_commit: 'a'.repeat(40), last_commit: 'b'.repeat(40), state: 'committed', public_edition: false};
let pid, uid, server, base, originalRecorded;
function cut(text, generated_at = '2026-03-04T05:06:07.000Z') {
  mkdirSync(join(root, 'paper'), {recursive: true});
  writeFileSync(join(root, path), text);
  writeFileSync(join(root, 'data.csv'), 'n,count\n0,1\n');
  const manifest = {version: 1, generated_at, files: {[path]: {sha256: sha256(text), mode: 'project', source}, 'data.csv': {sha256: sha256('n,count\n0,1\n'), mode: 'project'}}};
  writeFileSync(join(root, 'PUBLICATION.json'), JSON.stringify(manifest));
  return manifest;
}
before(async () => {
  await migrate();
  uid = Number((await one(`INSERT INTO users (github_id, handle) VALUES ($1,$2) RETURNING id`, [Date.now(), slug])).id);
  pid = Number((await one(`INSERT INTO problems (slug, name, repo_url, status_md, researcher_user_id) VALUES ($1,'Timestamp fixture','https://example.test/repo','open',$2) RETURNING id`, [slug, uid])).id);
  await q(`INSERT INTO papers (problem_id, slug, title, path) VALUES ($1,'note','A dated note',$2)`, [pid, path]);
  const app = express(); app.use('/projects/:slug', papers); app.use('/projects/:slug', docs); app.use(filesRouter);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(r => server.close(r));
  await q(`DELETE FROM file_refs WHERE file_sha IN (SELECT sha256 FROM files WHERE user_id = $1)`, [uid]);
  for (const table of ['document_publications', 'document_versions', 'papers', 'returns']) await q(`DELETE FROM ${table} WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM files WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]); await q(`DELETE FROM users WHERE id = $1`, [uid]);
  await pool.end(); rmSync(tmp, {recursive: true, force: true});
});

test('all published artifacts are recorded with server time; identical imports never reset it', async () => {
  const manifest = cut(original);
  const beforeRecord = Date.now();
  await Promise.all([recordPublication(slug, pid), recordPublication(slug, pid)]);
  const records = await documentRecords(pid);
  assert.equal(records.size, 2); assert.equal(records.get(path).publications.length, 1);
  originalRecorded = records.get(path).publications[0].recorded_at.toISOString();
  assert.ok(new Date(originalRecorded).getTime() >= beforeRecord);
  assert.notEqual(originalRecorded, manifest.generated_at);
  cut(original, '2026-04-05T06:07:08.000Z'); await recordPublication(slug, pid);
  assert.equal((await documentRecords(pid)).get(path).publications.length, 1);
  const dates = documentDates(manifest, path, records.get(path));
  assert.equal(dates.created_at, source.created_at); assert.equal(dates.modified_at, source.modified_at);
  assert.equal(dates.first_recorded_at, originalRecorded);
  const legacySeed = structuredClone(manifest); delete legacySeed.files[path].source;
  const seedDates = documentDates(legacySeed, path, records.get(path), undefined, true);
  assert.equal(seedDates.created_at, source.created_at); assert.equal(seedDates.modified_at, source.modified_at);
  assert.equal(seedDates.prepared_at, manifest.generated_at); assert.equal(seedDates.recorded_at, null);
  legacySeed.files[path].sha256 = 'f'.repeat(64);
  assert.equal(documentDates(legacySeed, path, records.get(path), undefined, true).created_at, null);
});

test('changes and reversions append history, while changed bytes outside the manifest are rejected', async () => {
  cut('# Changed\n'); await recordPublication(slug, pid);
  cut(original); await recordPublication(slug, pid);
  const records = (await documentRecords(pid)).get(path);
  assert.equal(records.publications.length, 3);
  assert.equal(records.publications[0].sha256, records.publications[2].sha256);
  assert.equal(records.publications[0].recorded_at.toISOString(), originalRecorded);
  writeFileSync(join(root, path), 'Unadmitted change'); await recordPublication(slug, pid);
  assert.equal((await documentRecords(pid)).get(path).publications.length, 3);
  cut(original);
});

test('document, paper, directory, raw and history routes expose the same exact times and hashes', async () => {
  const html = async route => { const r = await fetch(base + route, {headers: {accept: 'text/html'}}); assert.equal(r.status, 200); return r.text(); };
  const doc = `/projects/${slug}/docs/${path}`;
  for (const route of [doc, `/projects/${slug}/papers/note`, `/projects/${slug}/docs/paper`, `/projects/${slug}/history/${path}`]) {
    const body = await html(route); assert.ok(body.includes(source.created_at), route); assert.match(body, /UTC/); assert.doesNotMatch(body, /Sun Sep|Invalid Date/);
  }
  const raw = await fetch(base + doc);
  assert.equal(await raw.text(), original); assert.equal(raw.headers.get('x-content-sha256'), sha256(original));
  assert.equal(raw.headers.get('x-document-created-at'), source.created_at);
  const meta = await (await fetch(base + doc + '?meta=1')).json(); assert.equal(meta.timestamps.sha256, sha256(original));
  const history = await (await fetch(base + `/projects/${slug}/history/${path}`)).json(); assert.equal(history.publications.length, 3);
  assert.equal(history.timestamps.first_recorded_at, originalRecorded);
  const csv = await html(`/projects/${slug}/docs/data.csv`); assert.match(csv, /Created: not recorded/); assert.match(csv, /n,count/);
});

test('an accepted revision advances modification time without changing origin; original view uses mirror dates', async () => {
  const revised = '# Revised\n\nSwarm revision.\n';
  const {sha} = await files.store(uid, 'fixture', 'note.md', 'md', revised);
  const ret = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, revision_path, revision_sha, created_at) VALUES ($1,'audit',$2,'fixture','fixture','Revised.','fixture','accepted',$3,$4,'2026-05-06T07:08:09.123Z') RETURNING *`, [pid, uid, path, sha]);
  await integrate(ret, slug, []);
  const doc = base + `/projects/${slug}/docs/${path}`;
  const meta = await (await fetch(doc + '?meta=1')).json();
  assert.equal(meta.timestamps.created_at, source.created_at); assert.equal(meta.timestamps.modified_at, '2026-05-06T07:08:09.123Z'); assert.equal(meta.timestamps.sha256, sha);
  const mirror = await (await fetch(doc + '?meta=1&original=1')).json(); assert.equal(mirror.timestamps.modified_at, source.modified_at);
  const rawFile = await fetch(base + `/files/${sha}?raw=1`, {headers: {accept: 'text/html'}}); assert.equal(await rawFile.text(), revised);
  const file = await (await fetch(base + `/files/${sha}`, {headers: {accept: 'text/html'}})).text(); assert.match(file, /Uploaded: <time datetime=/); assert.ok(file.includes(sha));
});

test('backfill attaches source evidence only to identical public bytes, preserving edition dates', async () => {
  const manifest = cut(original);
  delete manifest.files[path].source;
  writeFileSync(join(root, 'PUBLICATION.json'), JSON.stringify(manifest));
  const evidence = structuredClone(manifest);
  evidence.files[path].source = source;
  evidence.files['data.csv'].source = source;
  evidence.files['data.csv'].sha256 = 'f'.repeat(64); // a different historical source edition
  const input = join(tmp, 'evidence.json'); writeFileSync(input, JSON.stringify(evidence));
  const run = () => promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/backfill-document-dates.ts', input, slug], {env: process.env});
  const result = JSON.parse((await run()).stdout);
  assert.equal(result.matched, 1); assert.equal(result.unmatched, 1);
  const saved = JSON.parse(readFileSync(join(root, 'PUBLICATION.json'), 'utf8'));
  assert.equal(saved.generated_at, manifest.generated_at);
  assert.equal(saved.files[path].source.created_at, source.created_at);
  assert.equal(saved.files['data.csv'].source, undefined);
  assert.equal(readFileSync(join(root, path), 'utf8'), original);
  const count = (await documentRecords(pid)).get(path).publications.length;
  await run();
  assert.equal((await documentRecords(pid)).get(path).publications.length, count);
});
