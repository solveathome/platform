import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// Record posts end to end (#sah-discord-record-posts): the trigger (live record events from records_since on, never a demo or an older
// one), the dedupe (one row and one post per record, from any number of passes), the hold and the coalescing per track, a withdrawn
// record dropped before posting or corrected after, a failed send retried, and the kill switch. Real Postgres (TEST_DATABASE_URL);
// a stubbed webhook; everything created is deleted.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the record post tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const tag = `recpost-test-${Date.now().toString(36)}`;
const slug = tag;
const projectsDir = mkdtempSync(join(tmpdir(), 'recpost-projects-'));
process.env.PROJECTS_DIR = projectsDir;
mkdirSync(join(projectsDir, slug));
const md5 = JSON.parse(readFileSync(new URL('../projects/md5/project.json', import.meta.url), 'utf8'));
const since = new Date(Date.now() - 3600_000).toISOString();
writeFileSync(join(projectsDir, slug, 'project.json'), JSON.stringify({slug, name: 'Record post test', repo_url: 'https://example.org/r', listed: false,
  announce: {records: true, records_since: since, record_hold_minutes: 10, record_max_per_day: 12}, challenge: md5.challenge}));

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {scanRecords, dispatchRecords, recordTick} = await import('../src/lib/record-announce.ts');
const COLL = 'md5-collision-totalbytes1024-v1', ZERO = 'md5-zero-bytes1024-v1';
const env = {DISCORD_PROGRESS_WEBHOOK_URL: 'http://127.0.0.1:9/api/webhooks/1/t'};
let pid, users = {}, seq = 0;
const calls = [];
let fail = false;
const fetchImpl = async (url, init) => {
  calls.push({url, method: init.method, body: JSON.parse(init.body)});
  if (fail) return {ok: false, status: 500, json: async () => ({}), text: async () => 'down'};
  return {ok: true, status: 200, json: async () => ({id: String(1000 + calls.length)}), text: async () => ''};
};

/** A verified receipt as submit() leaves it: the submission and, when it is a new best, its record event. */
async function receipt(user, track, value, {at = new Date(), ns = 'live', record = true, eventAt} = {}) {
  const lower = track === COLL;
  const s = await one(`INSERT INTO challenge_submissions (problem_id, challenge_id, namespace, user_id, idempotency_key, request_sha256, identity_sha256, inputs, digest, score, total_bytes, verifier_version, checks, received_at, verified_at, hardware, runtime_s)
    VALUES ($1,$2,$3,$4,$5,'x',$6,'{}','d',$7,$8,'v','{}',$9,$9,'Test GPU',90) RETURNING id`, [pid, track, ns, users[user].id, `${tag}-${++seq}`, `${tag}-${seq}`, lower ? null : value, lower ? value : null, at]);
  if (record) await q(`INSERT INTO challenge_events (problem_id, challenge_id, namespace, kind, value, submission_id, created_at) VALUES ($1,$2,$3,'record',$4,$5,$6)`, [pid, track, ns, value, s.id, eventAt ?? at]);
  return Number(s.id);
}
const rows = () => q(`SELECT * FROM record_announcements WHERE problem_id = $1 ORDER BY id`, [pid]);
const ago = (min) => new Date(Date.now() - min * 60_000);

before(async () => {
  await migrate();
  pid = Number((await one(`INSERT INTO problems (slug, name, repo_url) VALUES ($1,'Record post test','https://example.org/r') RETURNING id`, [slug])).id);
  for (const n of ['a', 'b']) users[n] = {handle: `${tag}-${n}`, id: Number((await one(`INSERT INTO users (github_id, handle) VALUES ($1,$2) RETURNING id`, [960_000_000 + Math.floor(Math.random() * 1e7), `${tag}-${n}`])).id)};
});
after(async () => {
  await q(`DELETE FROM record_announcements WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM challenge_corrections WHERE submission_id IN (SELECT id FROM challenge_submissions WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM challenge_events WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM challenge_submissions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [Object.values(users).map((u) => u.id)]);
  const left = await one(`SELECT (SELECT count(*) FROM record_announcements WHERE problem_id = $1) + (SELECT count(*) FROM users WHERE handle LIKE $2) AS n`, [pid, `${tag}%`]);
  assert.equal(Number(left.n), 0, 'residue');
  rmSync(projectsDir, {recursive: true, force: true});
  await pool.end();
});

test('trigger: only live record events from records_since on; no backfill, no demo, no plain receipt', async () => {
  await receipt('a', COLL, 300, {at: ago(180), eventAt: ago(180)});   // before records_since: never posted
  await receipt('a', COLL, 290, {at: ago(30), ns: 'demo'});
  await receipt('b', COLL, 310, {at: ago(30), record: false});         // not a new best
  const s1 = await receipt('a', COLL, 280, {at: ago(30)});
  assert.equal((await scanRecords(slug)).length, 1);
  assert.deepEqual((await rows()).map((r) => Number(r.submission_id)), [s1]);
});

test('dedupe: passes repeat, one row and one post per record; the post names the finder against the previous record', async () => {
  assert.equal((await scanRecords(slug)).length, 0);
  const d = await dispatchRecords(slug, {fetchImpl, env, base: 'https://example.org'});
  assert.equal(d.sent.length, 1);
  await dispatchRecords(slug, {fetchImpl, env, base: 'https://example.org'});
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/webhooks\/1\/t\?wait=true$/);
  assert.deepEqual(calls[0].body.allowed_mentions, {parse: []});
  const e = calls[0].body.embeds[0];
  assert.equal(e.title, 'New record: Smallest full collision');
  assert.match(e.description, new RegExp(`\\*\\*280 bytes across both inputs\\*\\*, found by \\*\\*\\[@${tag}-a\\]`));
  assert.match(e.description, new RegExp(`Previous solveathome record: 300 bytes across both inputs, \\[#\\d+\\]\\(https://example.org/projects/${slug}/submissions/\\d+\\) by @${tag}-a`));
  assert.match(e.description, /Hardware: Test GPU; search time 1\.5 min|Hardware: Test GPU; search time 90 s/);
  const r = (await rows())[0];
  assert.equal(r.status, 'sent'); assert.equal(r.discord_message_id, '1001');
});

test('hold and coalescing: a burst on one track becomes one post of the newest record', async () => {
  calls.length = 0;
  const s2 = await receipt('b', COLL, 270, {at: ago(12)});
  const s3 = await receipt('a', COLL, 260, {at: ago(1)});
  assert.equal((await scanRecords(slug)).length, 2);
  let d = await dispatchRecords(slug, {fetchImpl, env});
  assert.equal(calls.length, 0, 'the newest is still held, the older one is passed');
  const byS = Object.fromEntries((await rows()).map((r) => [Number(r.submission_id), r]));
  assert.equal(byS[s2].status, 'suppressed'); assert.match(byS[s2].suppressed_reason, new RegExp(`passed by #${s3}`));
  assert.match(d.waiting[byS[s3].id], /^hold until/);
  d = await dispatchRecords(slug, {fetchImpl, env, now: new Date(Date.now() + 10 * 60_000)});
  assert.deepEqual(d.sent, [Number(byS[s3].id)]);
  assert.match(calls[0].body.embeds[0].description, new RegExp(`Previous solveathome record: 270 bytes across both inputs, \\[#${s2}\\]`));
});

test('a record withdrawn before posting is dropped; one withdrawn after is edited and corrected, once', async () => {
  calls.length = 0;
  const z = await receipt('b', ZERO, 9, {at: ago(20)});
  await scanRecords(slug);
  await q(`INSERT INTO challenge_corrections (submission_id, kind, note) VALUES ($1,'void','verifier defect (test)')`, [z]);
  await dispatchRecords(slug, {fetchImpl, env});
  const rz = (await rows()).find((r) => Number(r.submission_id) === z);
  assert.equal(rz.status, 'suppressed'); assert.match(rz.suppressed_reason, /not a record in the current view \(withdrawn\)/);
  assert.equal(calls.length, 0);
  const sent = (await rows()).find((r) => r.status === 'sent' && r.challenge_id === COLL && r.value === 260);
  await q(`INSERT INTO challenge_corrections (submission_id, kind, note) VALUES ($1,'void','duplicate bytes (test)')`, [sent.submission_id]);
  const d = await dispatchRecords(slug, {fetchImpl, env});
  assert.deepEqual(d.corrected, [Number(sent.id)]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'PATCH'); assert.match(calls[0].url, new RegExp(`/messages/${sent.discord_message_id}$`));
  assert.match(calls[0].body.embeds[0].title, /^\[Withdrawn\] New record/);
  assert.match(calls[1].body.content, new RegExp(`^Correction: Revisited \\d{4}-\\d\\d-\\d\\d: submission #${sent.submission_id} was withdrawn \\(duplicate bytes \\(test\\)\\)`));
  await dispatchRecords(slug, {fetchImpl, env});
  assert.equal(calls.length, 2, 'a correction goes out once');
});

test('a failed send is retried on the next pass; no webhook or the kill switch sends nothing', async () => {
  calls.length = 0;
  const z = await receipt('a', ZERO, 10, {at: ago(20)});
  await scanRecords(slug);
  assert.match(Object.values((await dispatchRecords(slug, {fetchImpl, env: {}})).waiting).join(), /webhook unset/);
  fail = true;
  const d1 = await dispatchRecords(slug, {fetchImpl, env});
  assert.match(Object.values(d1.waiting).join(), /send failed/);
  const r1 = (await rows()).find((r) => Number(r.submission_id) === z);
  assert.equal(r1.status, 'held'); assert.equal(r1.payload, null);
  fail = false;
  const d2 = await dispatchRecords(slug, {fetchImpl, env});
  assert.deepEqual(d2.sent, [Number(r1.id)]);
  assert.equal(calls.length, 2);
  // The kill switch: the periodic pass does nothing at all.
  await receipt('b', ZERO, 11, {at: ago(20)});
  const before = (await rows()).length;
  process.env.ANNOUNCE_ENABLED = '0';
  try { await recordTick(); } finally { delete process.env.ANNOUNCE_ENABLED; }
  assert.equal((await rows()).length, before);
});
