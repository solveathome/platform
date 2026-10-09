import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash, randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// The MD5 challenge verifiers (Oct 9 2026): every fixture of the proposal, the boundary and malformed-input cases of its acceptance
// tests 1 and 2, the independent RFC 1321 implementation against OpenSSL, and parity with the published Python reference.
const {verifyMirror, verifyZero, verifyCollision, verify, identity, prefix, ChallengeError, knownMatch, knownResults} = await import('../src/lib/challenges.ts');
const {md5Rfc1321} = await import('../src/lib/md5.ts');
const ROOT = new URL('..', import.meta.url).pathname;
const config = JSON.parse(readFileSync(join(ROOT, 'projects/md5/project.json'), 'utf8'));
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof ChallengeError && e.status === 400 && (!re || re.test(e.message)));

test('self-match fixtures: literal ASCII bytes, prefix score', () => {
  for (const [c, d, s] of [
    ['00000000000000000000000000000000', 'cd9e459ea708a948d5c2f5a6ca8838cf', 0],
    ['0000000000000000000000000000000e', '0f5ecbfde00848fb349b3ad99d1a302d', 1],
    ['000000000000000000000000000000e6', '003d6287c0965a231a872922657ee7dd', 2],
    ['00000000000000000000000000001efd', '0005b7062c52fc4ee9762f633adb35fa', 3],
    ['54db1011d76dc70a0a9df3ff3e0b390f', '54db1011d76d137956603122ad86d762', 12],
  ]) { const r = verifyMirror(c); assert.equal(r.digest, d, c); assert.equal(r.score, s, c); assert.equal(r.checks['rfc1321-ts-1'][0], d); }
  // Hashed as written, never decoded as hex.
  assert.notEqual(verifyMirror('00000000000000000000000000000000').digest, createHash('md5').update(Buffer.alloc(16)).digest('hex'));
});

test('self-match refuses anything but 32 lowercase hex characters', () => {
  for (const bad of ['0000000000000000000000000000000E', '0000000000000000000000000000000', '000000000000000000000000000000000', ' 0000000000000000000000000000000', '0000000000000000000000000000000\n',
    '0x000000000000000000000000000000', '000000000000000000000000000000é0', '', 12, null, ['00000000000000000000000000000000'], {}]) refused(() => verifyMirror(bad));
});

test('all-zero fixtures: decoded bytes, leading-zero score', () => {
  for (const [h, d, s] of [
    ['', 'd41d8cd98f00b204e9800998ecf8427e', 0],
    ['616263', '900150983cd24fb0d6963f7d28e17f72', 0],
    ['06', '06eca1b437c7904cc3ce6546c8110110', 1],
    ['6231303064343734656231303064363064303432653836336331653061646565', '00000000000008d71ef80eb3849237d2', 13],
  ]) { const r = verifyZero(h); assert.equal(r.digest, d, h); assert.equal(r.score, s, h); assert.equal(r.byte_length, h.length / 2); }
  assert.equal(verifyZero('616263').byte_length, 3, '616263 is three bytes, not six characters');
});

test('all-zero boundaries: 1,024 bytes accepted, 1,025 refused; malformed transport refused, never repaired', () => {
  assert.equal(verifyZero('00'.repeat(1024)).byte_length, 1024);
  refused(() => verifyZero('00'.repeat(1025)), /1025 bytes/);
  for (const bad of ['0', 'ABCD', 'aBcd', '0x00', ' 00', '00 ', '00\n', 'zz', '０٠', 'ü0', 6, null, undefined, ['00'], {hex: '00'}]) refused(() => verifyZero(bad));
});

test('collision fixture: Stevens pair, swapped order equal, identical and non-colliding refused', () => {
  const A = '4dc968ff0ee35c209572d4777b721587d36fa7b21bdc56b74a3dc0783e7b9518afbfa200a8284bf36e8e4b55b35f427593d849676da0d1555d8360fb5f07fea2';
  const B = '4dc968ff0ee35c209572d4777b721587d36fa7b21bdc56b74a3dc0783e7b9518afbfa202a8284bf36e8e4b55b35f427593d849676da0d1d55d8360fb5f07fea2';
  const r = verifyCollision(A, B);
  assert.equal(r.digest, '008ee33a9d58b51cfeb425b0959121c9');
  assert.deepEqual([r.a_bytes, r.b_bytes, r.total_bytes], [64, 64, 128]);
  assert.deepEqual(verifyCollision(B, A).inputs, r.inputs, 'the pair is unordered');
  assert.equal(identity(r.challenge_id, verifyCollision(B, A).bytes), identity(r.challenge_id, r.bytes));
  refused(() => verifyCollision(A, A), /identical/);
  refused(() => verifyCollision('', '00'), /not a collision/);   // unequal lengths and an empty member are allowed, and still must collide
  refused(() => verifyCollision(A, '00'.repeat(1025)), /1025 bytes/);
  refused(() => verifyCollision(A.toUpperCase(), B));
});

test('every published target in project.json verifies at its stated value', () => {
  for (const t of config.challenge.tracks) for (const target of t.targets) {
    const v = verify(t.id, target.inputs);
    assert.equal(t.better === 'lower' ? v.total_bytes : v.score, target.value, `${t.id} ${target.credit}`);
  }
});

test('scores 0 through 32 synthetically, without fabricated exact solutions', () => {
  for (let k = 0; k <= 32; k++) {
    const d = 'a'.repeat(k) + 'b'.repeat(32 - k);
    assert.equal(prefix('a'.repeat(32), d), k);
    assert.equal(prefix('0'.repeat(32), '0'.repeat(k) + (k < 32 ? '1' : '') + '0'.repeat(Math.max(0, 31 - k))), k, 'later zeros never count');
  }
});

test('the RFC 1321 implementation equals OpenSSL on every length 0..300 and at the cap, binary round trip exact', () => {
  for (let n = 0; n <= 300; n++) { const b = randomBytes(n); assert.equal(md5Rfc1321(b), createHash('md5').update(b).digest('hex'), `length ${n}`); }
  for (const n of [1023, 1024, 1025, 4096]) { const b = randomBytes(n); assert.equal(md5Rfc1321(b), createHash('md5').update(b).digest('hex')); }
  const b = randomBytes(257); assert.ok(verifyZero(b.toString('hex')).bytes[0].equals(b));
});

test('identity is domain-separated SHA-256 of the exact inputs, never the digest', () => {
  assert.notEqual(identity('md5-zero-bytes1024-v1', [Buffer.from('ab')]), identity('md5-zero-bytes1024-v1', [Buffer.from('a'), Buffer.from('b')]));
  assert.notEqual(identity('md5-zero-bytes1024-v1', [Buffer.from('ab')]), identity('md5-mirror-ascii32-v1', [Buffer.from('ab')]));
});

test('parity with the Python reference verifier on fixtures, random and malformed inputs', (t) => {
  let python = 'python3';
  try { execFileSync(python, ['-c', 'import hashlib']); } catch { t.skip('python3 is not installed'); return; }
  const ref = join(ROOT, 'projects/md5/docs/verifier/reference.py');
  const run = (...args) => JSON.parse(execFileSync(python, ['-I', ref, ...args], {encoding: 'utf8'}));
  const ours = (fn) => { try { return fn(); } catch (e) { if (e instanceof ChallengeError) return {error: true}; throw e; } };
  const cases = [
    ['md5-mirror-ascii32-v1', ['54db1011d76dc70a0a9df3ff3e0b390f'], (c) => verifyMirror(c)],
    ['md5-mirror-ascii32-v1', [randomBytes(16).toString('hex')], (c) => verifyMirror(c)],
    ['md5-mirror-ascii32-v1', ['0000000000000000000000000000000E'], (c) => verifyMirror(c)],
    ['md5-zero-bytes1024-v1', [''], (h) => verifyZero(h)],
    ['md5-zero-bytes1024-v1', [randomBytes(200).toString('hex')], (h) => verifyZero(h)],
    ['md5-zero-bytes1024-v1', ['00'.repeat(1025)], (h) => verifyZero(h)],
    ['md5-zero-bytes1024-v1', ['abc'], (h) => verifyZero(h)],
    ['md5-collision-totalbytes1024-v1', [config.challenge.tracks[2].targets[0].inputs.b_hex, config.challenge.tracks[2].targets[0].inputs.a_hex], (a, b) => verifyCollision(a, b)],
    ['md5-collision-totalbytes1024-v1', ['00', '01'], (a, b) => verifyCollision(a, b)],
  ];
  for (const [id, args, fn] of cases) {
    const py = run(id, ...args), js = ours(() => fn(...args));
    if (py.error || js.error) { assert.ok(py.error && js.error, `${id} ${args.join(' ').slice(0, 40)}: both refuse`); continue; }
    assert.equal(js.digest, py.digest); assert.equal(js.score ?? null, py.score ?? null);
    if (py.total_bytes !== undefined) { assert.equal(js.total_bytes, py.total_bytes); assert.deepEqual([js.inputs.a_hex, js.inputs.b_hex], [py.a_hex, py.b_hex]); }
  }
});

test('published answers are recognised: every target, every entry of known-results.json, a swapped pair and a known pair with bytes appended', () => {
  const tracks = Object.fromEntries(config.challenge.tracks.map((t) => [t.id, t]));
  const mirror = tracks['md5-mirror-ascii32-v1'], zero = tracks['md5-zero-bytes1024-v1'], coll = tracks['md5-collision-totalbytes1024-v1'];
  assert.ok(knownMatch('md5', mirror, verifyMirror('54db1011d76dc70a0a9df3ff3e0b390f')), 'Egense');
  assert.ok(knownMatch('md5', zero, verifyZero('6231303064343734656231303064363064303432653836336331653061646565')), 'Polly, superseded but still published');
  assert.ok(knownMatch('md5', zero, verifyZero('7b626b674e52354553377d2d307836394245303237433937')), 'Beneri #209');
  const {a_hex: A, b_hex: B} = coll.targets[0].inputs;
  assert.ok(knownMatch('md5', coll, verifyCollision(A, B)));
  assert.ok(knownMatch('md5', coll, verifyCollision(B, A)), 'swapped');
  assert.ok(knownMatch('md5', coll, verifyCollision(A + 'ab'.repeat(64), B + 'ab'.repeat(64))), 'a common suffix keeps a known collision known');
  assert.equal(knownMatch('md5', mirror, verifyMirror('72690dc972013c32bce5e984a6681b99')), null, 'a new candidate is not known');
  assert.equal(knownMatch('md5', zero, verifyZero('06')), null);
  // Every listed entry is a real answer at its stated value: the list never refuses something it misdescribes.
  const file = JSON.parse(readFileSync(join(ROOT, 'projects/md5/known-results.json'), 'utf8'));
  for (const [id, entries] of Object.entries(file)) {
    assert.ok(tracks[id], id);
    for (const e of entries) {
      const {credit, source_url, score, total_bytes, ...inputs} = e;
      const v = verify(id, inputs);
      assert.ok(credit && /^https:\/\//.test(source_url), `${id} entry has credit and source`);
      if (score !== undefined) assert.equal(v.score, score, `${id} ${credit}`);
      if (total_bytes !== undefined) assert.equal(v.total_bytes, total_bytes, `${id} ${credit}`);
    }
    assert.equal(knownResults('md5', tracks[id]).length >= entries.length, true);
  }
});

test('the collision bar fills on a log scale from the 2,048-byte cap to 32 bytes, where a collision is known to exist', async () => {
  const {trackFill} = await import('../src/routes/challenges.ts');
  const [mirror, , coll] = config.challenge.tracks;
  assert.equal(trackFill(coll, null), null, 'nothing verified: no fill');
  assert.equal(trackFill(coll, 2048), 0);
  assert.equal(trackFill(coll, 256), 0.5, 'three halvings of six');
  assert.ok(Math.abs(trackFill(coll, 128) - 4 / 6) < 1e-9);
  assert.equal(trackFill(coll, 32), 1);
  assert.equal(trackFill(coll, 2), 1, 'never past full');
  assert.equal(trackFill(mirror, 9), 9 / 32);
});

const recordView = (track, values = []) => {
  const steps = values.map((value, i) => ({value, submission_id: i + 1, handle: 'researcher', model: 'test-model', attribution: null, known_result: false, received_at: `2026-10-09T${i ? '18' : '15'}:30:00Z`}));
  return {challenge_id: track.id, namespace: 'live', best: steps.at(-1) ?? null, steps, personal: [], milestones: [], submissions: steps.length, target: track.targets.at(-1)};
};

test('overview charts render empty and single-receipt histories without inventing earlier progress', async () => {
  const {recordChartSvg, recordCard} = await import('../src/routes/challenges.ts');
  const track = config.challenge.tracks[0], now = new Date('2026-10-09T20:30:00Z');
  const empty = recordChartSvg(track, recordView(track), '/projects/test', now);
  assert.match(empty, /No verified submission yet/);
  assert.doesNotMatch(empty, /<path|<circle/);
  assert.match(empty, /class="cc-target"/);
  const single = recordChartSvg(track, recordView(track, [9]), '/projects/test', now);
  assert.equal((single.match(/<circle/g) ?? []).length, 1);
  assert.match(single, /d="M[\d.]+,[\d.]+H350" class="cc-line"/);
  assert.doesNotMatch(single, /NaN|Infinity/);
  const zero = recordCard(track, recordView(track, [0]), '/projects/test', h => `@${h}`, now);
  assert.match(zero, /aria-label="0 of 32, receipt #1">0<\/a>/, 'a measured zero is distinct from no result');
  assert.doesNotMatch(zero, /cc-score-empty/);
});

test('overview charts step up for prefix improvements and down for fewer collision bytes', async () => {
  const {recordChartSvg} = await import('../src/routes/challenges.ts');
  for (const [track, values, upward] of [[config.challenge.tracks[1], [8, 11], true], [config.challenge.tracks[2], [256, 128], false]]) {
    const svg = recordChartSvg(track, recordView(track, values), '/projects/test', new Date('2026-10-09T20:30:00Z'));
    const coords = /d="M([\d.]+),([\d.]+)H([\d.]+)V([\d.]+)H350"/.exec(svg);
    assert.ok(coords, 'one actual step between the two receipts');
    assert.equal(Number(coords[4]) < Number(coords[2]), upward);
    assert.equal((svg.match(/<circle/g) ?? []).length, 2);
    assert.match(svg, /Receipt times in UTC/);
    assert.doesNotMatch(svg, /%|NaN|Infinity/);
  }
});

test('record summaries separate the current score, credited reference and ultimate goal and escape attribution', async () => {
  const {recordCard} = await import('../src/routes/challenges.ts');
  const track = config.challenge.tracks[2], view = recordView(track, [256]);
  view.best.attribution = 'A method <script> with a very long source name';
  const card = recordCard(track, view, '/projects/test', h => `<a href="/@${h}">Long Contributor Name @${h}</a>`, new Date('2026-10-09T20:30:00Z'));
  assert.match(card, /Our verified record/);
  assert.match(card, /Best known verified/);
  assert.match(card, /Ultimate goal/);
  assert.match(card, /Minimum unknown/);
  assert.match(card, /Long Contributor Name @researcher/);
  assert.match(card, /A method &lt;script&gt;/);
  assert.match(card, /High scores &amp; full history/);
  assert.match(card, /https:\/\/marc-stevens.nl\/research\/md5-1block-collision\//);
  assert.doesNotMatch(card, /<script>|progressbar|complete|%/);
});

test('a full prefix record reports a reached goal rather than retaining the no-known-result note', async () => {
  const {recordCard} = await import('../src/routes/challenges.ts');
  const track = config.challenge.tracks[0];
  const card = recordCard(track, recordView(track, [32]), '/projects/test', h => `@${h}`);
  assert.match(card, /Exact goal reached by this verified record/);
  assert.doesNotMatch(card, /None known/);
});
