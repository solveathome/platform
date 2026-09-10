import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
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
  writeFileSync(join(source, 'README.md'), '# Published\n\nA finite measurement.\n');
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/prepare-document-portfolio.ts', source, out]);
  // Secrets at every level the route could reach by mistake.
  for (const p of [join(root, '.env'), join(repos, '.env'), join(out, '.env'), join(out, 'research', '.env'), join(out, 'secret.md')]) { mkdirSync(join(p, '..'), {recursive: true}); writeFileSync(p, `TOKEN=${SECRET}\n`); }
  process.env.DOCS_DIR = repos; process.env.FILES_DIR = join(root, 'files'); mkdirSync(join(root, 'files'));
  writeFileSync(join(root, 'files', '.env'), `TOKEN=${SECRET}\n`);
  await (await import('../src/db/index.ts')).migrate();
  const {docs} = await import('../src/routes/docs.ts');
  const {filesRouter} = await import('../src/routes/files.ts');
  const {papers} = await import('../src/routes/papers.ts');
  const {pathGuard} = await import('../src/lib/guards.ts');
  const app = express(); app.use(pathGuard); app.use('/projects/:slug', docs); app.use('/projects/:slug', papers); app.use(filesRouter);
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
