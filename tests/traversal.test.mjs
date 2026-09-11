import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import express from 'express';

// The document browser and the file store must never serve anything outside the published portfolio: not .env, not the
// manifest, not a parent directory, however the path is spelled. A secret is planted at every level and must never appear.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the traversal tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const SECRET = 'SECRET-MARKER-' + Date.now().toString(36);

let root, server, base;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'sah-traversal-'));
  const source = join(root, 'private'), repos = join(root, 'repos'), out = join(repos, 'twin-primes');
  mkdirSync(source); mkdirSync(repos);
  writeFileSync(join(source, 'README.md'), '# Published\n\nA finite measurement, revised since the seed.\n');
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/prepare-document-portfolio.ts', source, out]);
  // Secrets at every level the route could reach by mistake.
  for (const p of [join(root, '.env'), join(repos, '.env'), join(out, '.env'), join(out, 'research', '.env'), join(out, 'secret.md')]) { mkdirSync(join(p, '..'), {recursive: true}); writeFileSync(p, `TOKEN=${SECRET}\n`); }
  process.env.DOCS_DIR = repos; process.env.FILES_DIR = join(root, 'files'); mkdirSync(join(root, 'files'));
  // The seed edition: the portfolio as first cut (its own manifest), the live one revised since; a secret beside it must stay unreachable.
  const seed = join(root, 'seed'), seedSrc = join(root, 'seed-private'); mkdirSync(seed); mkdirSync(seedSrc); process.env.SEED_DIR = seed;
  writeFileSync(join(seedSrc, 'README.md'), '# Published\n\nA finite measurement.\n');
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/prepare-document-portfolio.ts', seedSrc, join(seed, 'twin-primes')]);
  writeFileSync(join(seed, 'twin-primes.json'), '{"date":"2026-09-10","note":"seed: test"}');
  writeFileSync(join(seed, '.env'), `TOKEN=${SECRET}\n`);
  process.env.OVERLAY_DIR = join(root, 'overlay'); mkdirSync(process.env.OVERLAY_DIR);
  writeFileSync(join(root, 'files', '.env'), `TOKEN=${SECRET}\n`);
  await (await import('../src/db/index.ts')).migrate();
  const {docs} = await import('../src/routes/docs.ts');
  const {filesRouter} = await import('../src/routes/files.ts');
  const {papers} = await import('../src/routes/papers.ts');
  const {pathGuard} = await import('../src/lib/guards.ts');
  const {bigBody} = await import('../src/lib/body-limits.ts');
  const app = express(); app.use(pathGuard); app.use('/files', bigBody('8mb')); app.use(express.json({limit: '1mb'})); app.use('/projects/:slug', docs); app.use('/projects/:slug', papers); app.use(filesRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); rmSync(root, {recursive: true, force: true}); await (await import('../src/db/index.ts')).pool.end(); });

const get = async (path) => { const r = await fetch(base + path, {headers: {accept: 'text/plain'}}); return {status: r.status, body: await r.text()}; };

test('the published document is served; nothing else under the project is', async () => {
  const ok = await get('/projects/twin-primes/docs/README.md');
  assert.equal(ok.status, 200); assert.match(ok.body, /finite measurement/);
  for (const p of ['/projects/twin-primes/docs/secret.md', '/projects/twin-primes/docs/PUBLICATION.json', '/projects/twin-primes/docs/.env', '/projects/twin-primes/docs/research/.env']) {
    const r = await get(p); assert.equal(r.status, 404, p); assert.doesNotMatch(r.body, new RegExp(SECRET), p);
  }
});

test('every spelling of a parent directory, encoded or not, is refused without a byte of content', async () => {
  const probes = [
    '/projects/twin-primes/docs/../.env', '/projects/twin-primes/docs/../../.env', '/projects/twin-primes/docs/..%2F.env', '/projects/twin-primes/docs/..%2F..%2F.env',
    '/projects/twin-primes/docs/%2e%2e/.env', '/projects/twin-primes/docs/%2e%2e%2f%2e%2e%2f.env', '/projects/twin-primes/docs/research/..%2F..%2F.env', '/projects/twin-primes/docs/research/%2e%2e/.env',
    '/projects/twin-primes/docs/..%5C.env', '/projects/twin-primes/docs/README.md%00.env', '/projects/twin-primes/docs/.%2Fresearch%2F..%2F.env',
    '/projects/..%2Ftwin-primes/docs/.env', '/projects/..%2F..%2F/docs/.env', '/projects/twin-primes%2F..%2F..%2F/docs/.env', '/projects/.%2E/docs/.env',
    '/files/..%2F.env', '/files/..%2F..%2F.env', '/files/.env', '/files/../.env/meta', '/files/%2e%2e%2f.env',
    '/projects/twin-primes/history/..%2F..%2F.env', '/projects/twin-primes/papers/..%2F..%2F.env',
  ];
  for (const p of probes) {
    const r = await get(p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.doesNotMatch(r.body, new RegExp(SECRET), p);
    assert.doesNotMatch(r.body, /TOKEN=/, p);
  }
});

test('a slug that is not a slug never reaches the filesystem', async () => {
  for (const s of ['..', '.', 'Twin-Primes', 'twin_primes', 'a'.repeat(65), 'twin-primes%20', '%2e%2e']) {
    const r = await get(`/projects/${s}/docs/README.md`);
    assert.ok([400, 404].includes(r.status), `${s} -> ${r.status}`);
  }
});

test('the seed edition serves the text as first cut, links within itself, and reaches nothing beside it', async () => {
  const seed = await get('/projects/twin-primes/seed/README.md');
  assert.equal(seed.status, 200); assert.match(seed.body, /finite measurement\.\n/); assert.doesNotMatch(seed.body, /revised since/);
  const live = await get('/projects/twin-primes/docs/README.md');
  assert.match(live.body, /revised since the seed/);
  const html = await fetch(base + '/projects/twin-primes/seed/README.md', {headers: {accept: 'text/html'}}).then(r => r.text());
  assert.match(html, /seed edition, as brought by the researcher on 2026-09-10/); assert.match(html, /href="\/projects\/twin-primes\/docs\/README\.md"/);
  assert.match(html, /Out of date: the body of work has moved on/, 'the live README was revised, so the seed page must say so');
  mkdirSync(join(process.env.OVERLAY_DIR, 'twin-primes'), {recursive: true}); writeFileSync(join(process.env.OVERLAY_DIR, 'twin-primes', 'README.md'), readFileSync(join(process.env.SEED_DIR, 'twin-primes', 'README.md'), 'utf8'));   // the portfolio step may transform the text: catch up to the seed byte for byte
  const same = await fetch(base + '/projects/twin-primes/seed/README.md', {headers: {accept: 'text/html'}}).then(r => r.text());
  assert.doesNotMatch(same, /Out of date/); assert.match(same, /unchanged since/);
  for (const p of ['/projects/twin-primes/seed/.env', '/projects/twin-primes/seed/../.env', '/projects/twin-primes/seed/..%2F.env', '/projects/twin-primes/seed/PUBLICATION.json', '/projects/other/seed/README.md']) {
    const r = await get(p); assert.notEqual(r.status, 200, p); assert.doesNotMatch(r.body, new RegExp(SECRET), p);
  }
});

test('issue #11: reading a file needs no token; uploading without one is refused before the body is read', async () => {
  const files = await import('../src/lib/files.ts');
  const {q, one} = await import('../src/db/index.ts');
  const {TERMS_VERSION} = await import('../src/lib/terms.ts');
  const u = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), `trav-${Date.now().toString(36)}`, TERMS_VERSION]);
  const {sha} = await files.store(Number(u.id), 'claude-opus-5', 'public.md', 'md', '# Public\n\nAnyone fetches this.\n');
  try {
    const r = await fetch(`${base}/files/${sha}`, {headers: {accept: 'text/plain'}});
    assert.equal(r.status, 200); assert.match(await r.text(), /Anyone fetches this/);
    const up = await fetch(`${base}/files`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({name: 'x.md', content: 'x'})});
    assert.equal(up.status, 401);
  } finally {
    await q(`DELETE FROM file_refs WHERE file_sha = $1`, [sha]); await q(`DELETE FROM files WHERE sha256 = $1`, [sha]); await q(`DELETE FROM reputation WHERE user_id = $1`, [u.id]); await q(`DELETE FROM users WHERE id = $1`, [u.id]);
  }
});
