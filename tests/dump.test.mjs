import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {constants} from 'node:buffer';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// The open dataset writer, without a database: rows come from a fake source. From 2026-09-18 the daily cron died after
// jobs.jsonl because returns.jsonl (transcripts) had outgrown a single JS string; five days listed on /dumps with no
// manifest and no timestamp proof. The writer streams and never touches the day's directory until every table passed.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://unused:unused@localhost:1/unused';
const {writeDump, dumpDays, DUMP_TABLES} = await import('../src/lib/dump.ts');

const sha = (b) => createHash('sha256').update(b).digest('hex');
const source = (data) => async function* (sql) { for (const row of data[sql] ?? []) yield row; };
const scratch = () => mkdtempSync(join(tmpdir(), 'sah-dump-'));

test('every table streams to its own file and the manifest carries exact counts, bytes and digests', async () => {
  const dir = scratch();
  try {
    const tables = {a: 'A', b: 'B', empty: 'E'};
    const m = await writeDump({day: '2026-09-22', dumpDir: dir, tables, rows: source({A: [{id: 1, handle: 'x'}, {id: 2, handle: 'y'}], B: [{path: 'p', n: null}]})});
    assert.deepEqual(Object.keys(m.files), ['a', 'b', 'empty']);
    for (const [name, f] of Object.entries(m.files)) {
      const body = readFileSync(join(dir, '2026-09-22', `${name}.jsonl`));
      assert.equal(f.bytes, body.length, name); assert.equal(f.sha256, sha(body), name);
      assert.equal(f.rows, body.length ? body.toString().trim().split('\n').length : 0, name);
    }
    assert.equal(readFileSync(join(dir, '2026-09-22', 'a.jsonl'), 'utf8'), '{"id":1,"handle":"x"}\n{"id":2,"handle":"y"}\n');
    assert.equal(m.license, 'CC BY 4.0');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '2026-09-22', 'manifest.json'), 'utf8')), m);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')), {day: '2026-09-22', manifest: '2026-09-22/manifest.json'});
    assert.deepEqual(readdirSync(dir).sort(), ['2026-09-22', 'latest.json'], 'no staging directory is left behind');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a table larger than one JS string can hold is written whole (the failure of 2026-09-18 to 22)', async () => {
  const dir = scratch();
  try {
    const chunk = 'x'.repeat(200_000_000);
    const rows = [{id: 1, transcript: chunk}, {id: 2, transcript: chunk}, {id: 3, transcript: chunk}];
    const joined = rows.length * (chunk.length + 25);
    assert.ok(joined > constants.MAX_STRING_LENGTH, 'the fixture must exceed what the old join could build');
    const m = await writeDump({day: '2026-09-18', dumpDir: dir, tables: {returns: 'R'}, rows: source({R: rows})});
    assert.equal(m.files.returns.rows, 3);
    assert.equal(m.files.returns.bytes, joined - rows.length * 25 + rows.length * '{"id":1,"transcript":""}\n'.length);
    assert.ok(existsSync(join(dir, '2026-09-18', 'manifest.json')));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a source-reproduction hit withholds the day and leaves an earlier export of that day untouched', async () => {
  const dir = scratch();
  try {
    const day = join(dir, '2026-09-22');
    mkdirSync(day, {recursive: true});
    writeFileSync(join(day, 'returns.jsonl'), 'old\n'); writeFileSync(join(day, 'manifest.json'), '{"day":"2026-09-22"}\n');
    const rows = source({R: [{id: 7, transcript: 'notes\nBEGIN THIRD-PARTY SOURCE\n...'}], J: [{id: 1, brief_md: 'fine'}]});
    await assert.rejects(writeDump({day: '2026-09-22', dumpDir: dir, tables: {jobs: 'J', returns: 'R'}, rows}), /Export withheld pending source review: returns 7 transcript/);
    assert.equal(readFileSync(join(day, 'returns.jsonl'), 'utf8'), 'old\n');
    assert.equal(readFileSync(join(day, 'manifest.json'), 'utf8'), '{"day":"2026-09-22"}\n');
    assert.ok(!existsSync(join(day, 'jobs.jsonl')), 'the table that passed is not moved in either');
    assert.deepEqual(readdirSync(dir), ['2026-09-22'], 'staging is removed and latest.json is not written');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a re-run of the same day keeps the OpenTimestamps proofs and drops a table the export no longer has', async () => {
  const dir = scratch();
  try {
    await writeDump({day: '2026-09-22', dumpDir: dir, tables: {a: 'A', gone: 'G'}, rows: source({A: [{id: 1}], G: [{id: 1}]})});
    const day = join(dir, '2026-09-22');
    for (const f of ['manifest.json.ots', 'manifest.json.20260922T012705Z.superseded.ots', 'attestation.json']) writeFileSync(join(day, f), 'proof');
    const m = await writeDump({day: '2026-09-22', dumpDir: dir, tables: {a: 'A'}, rows: source({A: [{id: 1}, {id: 2}]})});
    assert.equal(m.files.a.rows, 2);
    assert.deepEqual(readdirSync(day).sort(), ['a.jsonl', 'attestation.json', 'manifest.json', 'manifest.json.20260922T012705Z.superseded.ots', 'manifest.json.ots']);
    assert.equal(readFileSync(join(day, 'manifest.json.ots'), 'utf8'), 'proof');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('only a day with a manifest is a snapshot: the listing skips a directory a dead run left behind', async () => {
  const dir = scratch();
  try {
    for (const d of ['2026-09-17', '2026-09-18', '2026-09-19', 'notes', '.2026-09-19.staging-1-x']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, '2026-09-17', 'manifest.json'), '{}'); writeFileSync(join(dir, '2026-09-19', 'manifest.json'), '{}');
    writeFileSync(join(dir, '2026-09-18', 'jobs.jsonl'), '{}\n');
    assert.deepEqual(dumpDays(dir), ['2026-09-19', '2026-09-17']);
    assert.deepEqual(dumpDays(join(dir, 'missing')), []);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the day must be a date and the export never selects a display name', () => {
  assert.rejects(writeDump({day: '../etc', dumpDir: scratch(), tables: {}, rows: source({})}), /YYYY-MM-DD/);
  for (const sql of Object.values(DUMP_TABLES)) assert.doesNotMatch(sql, /display_name/);
});
