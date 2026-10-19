import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';

// Record posts (#sah-discord-record-posts): the template and the config. No database; the outbox is in record-announce-db.
const {buildRecordPost, recordAnnounceConfig, duration} = await import('../src/lib/record-announce.ts');
const md5 = JSON.parse(readFileSync(new URL('../projects/md5/project.json', import.meta.url), 'utf8'));
const [MIRROR, , COLL] = md5.challenge.tracks;
const base = 'https://solveathome.org';

test('a collision record past the published best: value, finder, previous record, published best, hardware, time, links', () => {
  const p = buildRecordPost({track: COLL, slug: 'md5', base, submission_id: 6613, value: 124, handle: 'sundayweaver', received_at: '2026-10-19T09:12:00Z',
    previous: {submission_id: 6599, value: 126, handle: 'moreisee', received_at: '2026-10-18T20:00:00Z'}, hardware: 'Intel UHD Graphics 770 (OpenCL)', runtime_s: 14401.4});
  assert.equal(p.title, 'New record: Smallest full collision');
  assert.match(p.description, /^\*\*124 bytes across both inputs\*\*, found by \*\*\[@sundayweaver\]\(https:\/\/solveathome\.org\/@sundayweaver\)\*\*\./);
  assert.match(p.description, /Previous solveathome record: 126 bytes across both inputs, \[#6599\]\(https:\/\/solveathome\.org\/projects\/md5\/submissions\/6599\) by @moreisee \(2026-10-18\)\./);
  assert.match(p.description, /Best known before solveathome: 128 bytes across both inputs, Marc Stevens .*\(\[source\]\(https:\/\/marc-stevens\.nl\/research\/md5-1block-collision\/\)\)\. This record is 4 bytes below the best known before solveathome\./);
  assert.match(p.description, /Hardware: Intel UHD Graphics 770 \(OpenCL\); search time 4 h\./);
  assert.match(p.description, /Received 2026-10-19 09:12 UTC\./);
  assert.match(p.description, /\[Submission #6613\]\(https:\/\/solveathome\.org\/projects\/md5\/submissions\/6613\) · \[Track standings\]\(https:\/\/solveathome\.org\/projects\/md5\/tracks\/smallest-collision\)/);
  assert.equal(p.url, `${base}/projects/md5/submissions/6613`);
  assert.equal(p.color, 0xc9a227);
});

test('a record that matches or trails the published best says so; the first result on a track has no previous', () => {
  const eq = buildRecordPost({track: MIRROR, slug: 'md5', base, submission_id: 136, value: 12, handle: 'jway', received_at: '2026-10-11T00:00:00Z', previous: {submission_id: 23, value: 11, handle: 'Benjaminsen', received_at: '2026-10-10T00:00:00Z'}});
  assert.match(eq.description, /This matches it; it does not pass it\./);
  assert.doesNotMatch(eq.description, /Hardware|search time/i);
  assert.equal(eq.color, 0x1565c0);
  const first = buildRecordPost({track: MIRROR, slug: 'md5', base, submission_id: 3, value: 9, handle: 'a', received_at: '2026-10-09T00:00:00Z', previous: null, runtime_s: 30});
  assert.match(first.description, /The first verified result on this track\./);
  assert.match(first.description, /That is still 3 hex characters more than this record\./);
  assert.match(first.description, /^Search time 30 s\.$/m);
});

test('submitter text is defused: no mentions, links or overclaiming hardware lines; handles are stripped to their characters', () => {
  const p = buildRecordPost({track: COLL, slug: 'md5', base, submission_id: 9, value: 200, handle: 'x<@everyone>', received_at: '2026-10-19T00:00:00Z', previous: null, hardware: '@everyone see https://evil.example [x](https://evil.example)'});
  assert.match(p.description, /found by \*\*\[@xeveryone\]/);
  assert.doesNotMatch(p.description, /@everyone|https:\/\/evil/);
  const hype = buildRecordPost({track: COLL, slug: 'md5', base, submission_id: 9, value: 200, handle: 'a', received_at: '2026-10-19T00:00:00Z', previous: null, hardware: 'a groundbreaking rig'});
  assert.doesNotMatch(hype.description, /Hardware/);
});

test('config: off unless records is true; no records_since means nothing is scanned; md5 posts from 19 Oct 2026', () => {
  assert.deepEqual(recordAnnounceConfig({}), {records: false, since: null, hold_minutes: 10, max_per_day: 12});
  assert.equal(recordAnnounceConfig({announce: {records: true, records_since: 'not a date'}}).since, null);
  const c = recordAnnounceConfig(md5);
  assert.equal(c.records, true);
  assert.equal(c.since.toISOString(), '2026-10-19T00:00:00.000Z');
  assert.equal(duration(null), null);
  assert.equal(duration(600), '10 min');
});
