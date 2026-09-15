import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import express from 'express';

// The upload quota is per handle per rolling day, shared by every session (issue #32): the 429 says so and when the next slot opens.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the quota tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';
const dir = mkdtempSync(join(tmpdir(), 'sah-files-')); process.env.FILES_DIR = dir;
process.env.FILES_PER_DAY_BASE = '300'; process.env.FILES_MB_PER_DAY_BASE = '200';   // pin the base: the test is about the floor and the 429, not the number
const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {filesRouter} = await import('../src/routes/files.ts');
const reputation = await import('../src/lib/reputation.ts');

const tag = `quota-test-${Date.now().toString(36)}`;
let server, base, uid, token;
before(async () => {
  await migrate();
  uid = Number((await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [950_000_000 + Math.floor(Math.random() * 1e8), tag, TERMS_VERSION])).id);
  token = await issueToken(uid, 'quota-test');
  await reputation.ensure(uid); await q(`UPDATE reputation SET score = 0.1 WHERE user_id = $1`, [uid]);   // the floor: 30 files a day
  const app = express(); app.use(express.json({limit: '1mb'})); app.use(filesRouter);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.close();
  await q(`DELETE FROM files WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM tokens WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM reputation WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM users WHERE id = $1`, [uid]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE id = $1) + (SELECT count(*) FROM files WHERE user_id = $1) AS n`, [uid]);
  await pool.end(); rmSync(dir, {recursive: true, force: true});
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});
const up = (n) => fetch(`${base}/files`, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json'}, body: JSON.stringify({name: `f${n}.txt`, content: `file ${n} ${tag}`})});

test('the thirty-first upload of the day is a 429 that names the shared quota and the next slot', async () => {
  for (let i = 1; i <= 30; i++) { const r = await up(i); assert.equal(r.status, 200, await r.text()); }
  const r = await up(31); const j = await r.json();
  assert.equal(r.status, 429);
  assert.match(j.error, /30 files and 20 MB per rolling 24 h, shared by all of its sessions/);
  assert.match(j.next_slot_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(new Date(j.next_slot_at).getTime() - Date.now() > 23 * 3600e3, 'the slot opens when the oldest upload ages past 24 h');
  const quota = await (await fetch(`${base}/files/quota`, {headers: {authorization: `Bearer ${token}`}})).json();
  assert.deepEqual([quota.files_left, quota.files_per_day], [0, 30]);
});

// Issue #67: 62 characters of a real content address were fetched, answered "no such file", and reported as a blob dropped
// from the store. The file was present. A 404 that cannot tell "you asked wrong" from "it is gone" costs an agent an
// investigation and puts a false defect on the public record, so the malformed case now says which it is.
test('a content address of the wrong shape says so, and a well-formed unknown one still reads as missing', async () => {
  const real = (await one(`SELECT sha256 FROM files WHERE user_id = $1 ORDER BY created_at LIMIT 1`, [uid])).sha256;
  assert.match(real, /^[0-9a-f]{64}$/);
  const truncated = real.slice(0, 62);
  const short = await fetch(`${base}/files/${truncated}`);
  assert.equal(short.status, 404);
  const body = await short.text();
  assert.match(body, /64 hex characters and this is 62/);
  assert.match(body, /Nothing is missing from the store/);
  const meta = await fetch(`${base}/files/${truncated}/meta`);
  assert.match((await meta.json()).error, /64 hex characters/, 'the meta route answers in its own shape');
  assert.match(await (await fetch(`${base}/files/${'z'.repeat(64)}`)).text(), /contains "zzzzzzzzzzzz"/);
  const unknown = await fetch(`${base}/files/${'a'.repeat(64)}`);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.text()).trim(), 'no such file', 'a real address that is not in the store is still simply missing');
  const found = await fetch(`${base}/files/${real}`);
  assert.equal(found.status, 200);
});
