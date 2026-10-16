import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

// Lane specs and the locked evaluator (#sah-sakana-lane-specs-locked-evaluator, Oct 16 2026). Pure: reads the repository's project
// configs and runs each lane's two small scripts the way a checker would, on this machine. No database.
const {laneSpec, laneSpecFile, laneSpecView, lockedEvaluatorFor, judgeEvaluator} = await import('../src/lib/lane-spec.ts');
const config = JSON.parse(readFileSync('projects/twin-primes/project.json', 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const node = (args, cwd) => spawnSync(process.execPath, args, {cwd, encoding: 'utf8', timeout: 60_000});

test('every twin-primes lane has a spec whose files are served and match their pinned sha256', () => {
  assert.ok(config.lanes.length >= 6);
  for (const lane of config.lanes) {
    const spec = laneSpec('twin-primes', lane.slug);
    assert.ok(spec, `lane ${lane.slug} has no valid spec`);
    assert.ok(spec.goal_md.length > 20 && spec.metric.name && spec.metric.baseline_md, `lane ${lane.slug} needs a goal and a metric with its baseline`);
    for (const f of [spec.start, spec.evaluator]) assert.equal(sha(readFileSync(join('projects/twin-primes', f.path))), f.sha256, `${f.path} no longer matches its pinned sha256: re-pin it in project.json`);
    for (const p of [spec.doc, spec.start.path, spec.evaluator.path]) assert.equal(laneSpecFile('twin-primes', lane.slug, p.split('/').pop()).sha256, sha(readFileSync(join('projects/twin-primes', p))));
    assert.equal(laneSpecView('twin-primes', lane.slug).evaluator.url, `/projects/twin-primes/lane/${lane.slug}/spec/evaluate.mjs`);
    assert.equal(laneSpecFile('twin-primes', lane.slug, 'project.json'), null, 'only the spec\'s own files are served');
  }
});

test('each lane\'s starting script prints claims its pinned evaluator accepts, and a corrupted claim fails', () => {
  for (const lane of config.lanes) {
    const dir = mkdtempSync(join(tmpdir(), `lane-${lane.slug}-`));
    try {
      cpSync(join('projects/twin-primes/lanes', lane.slug), dir, {recursive: true});
      const start = node(['start.mjs'], dir);
      assert.equal(start.status, 0, start.stderr);
      writeFileSync(join(dir, 'claims.json'), start.stdout);
      const ok = node(['evaluate.mjs', 'claims.json'], dir);
      assert.equal(ok.status, 0, `${lane.slug}: ${ok.stdout}${ok.stderr}`);
      const claims = JSON.parse(start.stdout), c = claims.claims.find((x) => typeof x.value === 'number');
      c.value = Number.isInteger(c.value) ? c.value + 2 : c.value * 1.01;   // a negative control: one integer off, or a real value 1% off
      writeFileSync(join(dir, 'bad.json'), JSON.stringify(claims));
      const bad = node(['evaluate.mjs', 'bad.json'], dir);
      assert.equal(bad.status, 1, `${lane.slug} missed a corrupted claim: ${bad.stdout}`);
      assert.match(bad.stdout, /MISMATCH/);
      writeFileSync(join(dir, 'unknown.json'), JSON.stringify({lane: lane.slug, claims: [{quantity: 'no_such_quantity', args: {}, value: 1}]}));
      assert.equal(node(['evaluate.mjs', 'unknown.json'], dir).status, 2, 'an unknown quantity is unsupported, never a pass');
    } finally { rmSync(dir, {recursive: true, force: true}); }
  }
});

test('the lock applies to measured, verified and unstated rungs of non-Lean packages in a lane with a spec', () => {
  const plan = {manifest: []};
  assert.equal(lockedEvaluatorFor('twin-primes', 'measure', {verification_plan: plan, author_rung: 'measured'}).sha256, laneSpec('twin-primes', 'measure').evaluator.sha256);
  assert.ok(lockedEvaluatorFor('twin-primes', 'measure', {verification_plan: plan, author_rung: 'verified'}));
  assert.ok(lockedEvaluatorFor('twin-primes', 'measure', {verification_plan: plan, author_rung: null}));
  assert.equal(lockedEvaluatorFor('twin-primes', 'measure', {verification_plan: plan, author_rung: 'heuristic'}), null);
  assert.equal(lockedEvaluatorFor('twin-primes', 'formalize', {verification_plan: {...plan, lean: {}}, author_rung: 'verified'}), null, 'Lean keeps its own profile');
  assert.equal(lockedEvaluatorFor('twin-primes', null, {verification_plan: plan, author_rung: 'measured'}), null);
  assert.equal(lockedEvaluatorFor('twin-primes', 'measure', {author_rung: 'measured'}), null, 'no package, no check');
  assert.equal(lockedEvaluatorFor('md5', 'self-match', {verification_plan: plan, author_rung: 'measured'}), null, 'MD5 keeps its server recompute');
});

test('a receipt passes only with the pinned hash or an uploaded independent reimplementation', () => {
  const pinned = 'a'.repeat(64), author = 'b'.repeat(64), own = 'c'.repeat(64);
  const ctx = (o = {}) => ({outcome: 'pass', method: 'rerun', authorFiles: [author], uploaded: true, ...o});
  assert.deepEqual(judgeEvaluator(pinned, pinned, ctx()), {evaluator_sha256: pinned, evaluator_kind: 'lane_pinned'});
  assert.deepEqual(judgeEvaluator(pinned, own, ctx({method: 'independent_implementation'})), {evaluator_sha256: own, evaluator_kind: 'independent_reimplementation'});
  assert.throws(() => judgeEvaluator(pinned, undefined, ctx()), /evaluator_sha256 is required/);
  assert.throws(() => judgeEvaluator(pinned, 'not-a-hash', ctx()), /evaluator_sha256 is required/);
  assert.throws(() => judgeEvaluator(pinned, own, ctx()), /not the lane's pinned evaluator/);
  assert.throws(() => judgeEvaluator(pinned, author, ctx({method: 'independent_implementation'})), /author's own package/);
  assert.throws(() => judgeEvaluator(pinned, own, ctx({method: 'independent_implementation', uploaded: false})), /names no uploaded file/);
  assert.equal(judgeEvaluator(pinned, undefined, ctx({outcome: 'unable'})), null, 'an unable receipt ran nothing');
});
