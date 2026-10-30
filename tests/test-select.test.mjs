// The pre-push selector (Oct 30 2026): a change runs only the checks it could break.
import assert from 'node:assert/strict';
import {test} from 'node:test';
const {selectTests, listedTests} = await import('../scripts/test-select.mjs');

const tests = {unit: ['tests/credit.test.mjs', 'tests/lean-display.test.mjs', 'tests/mobile-width.test.mjs', 'tests/lane-spec.test.mjs'], db: ['tests/credit-db.test.mjs', 'tests/lane-evaluator-db.test.mjs']};
const text = {
  'tests/credit.test.mjs': "await import('../src/lib/credit.ts');",
  'tests/credit-db.test.mjs': "await import('../src/lib/credit.ts'); await import('../src/db/index.ts');",
  'tests/lean-display.test.mjs': "await import('../src/lib/lean-display.ts');",
  'tests/mobile-width.test.mjs': "readFileSync('public/assets/site.css')",
};
const read = (t) => text[t] || '';
const pick = (changed, opts = {}) => selectTests(changed, {tests, read, ...opts});

test('docs, markdown and images run nothing', () => {
  const p = pick(['docs/testing.md', 'README.md', 'public/assets/logo.svg']);
  assert.deepEqual([p.check, p.unit, p.db], [false, [], []]);
});

test('a style file runs only the test that reads it', () => {
  assert.deepEqual(pick(['public/assets/site.css']).unit, ['tests/mobile-width.test.mjs']);
});

test('a lib file runs the typecheck and the tests that import it, DB ones included', () => {
  const p = pick(['src/lib/credit.ts']);
  assert.equal(p.check, true);
  assert.deepEqual(p.unit, ['tests/credit.test.mjs']);
  assert.deepEqual(p.db, ['tests/credit-db.test.mjs']);
});

test('a path is not matched by a longer name that starts with it', () => {
  assert.deepEqual(pick(['src/lib/lean.ts']).unit, []);
});

test('the schema runs every DB test; dependencies and tsconfig run everything', () => {
  assert.equal(pick(['src/db/schema.sql']).db, 'all');
  const p = pick(['package.json'], {depsChanged: true});
  assert.deepEqual([p.check, p.unit, p.db], [true, [...tests.unit].sort(), 'all']);
  assert.equal(pick(['tsconfig.json']).db, 'all');
  assert.deepEqual(pick(['package.json']).unit, []);
});

test('a changed test runs itself; a lane spec runs the lane tests', () => {
  assert.deepEqual(pick(['tests/credit-db.test.mjs']).db, ['tests/credit-db.test.mjs']);
  const p = pick(['projects/md5/lanes/a/spec.json']);
  assert.deepEqual([p.unit, p.db], [['tests/lane-spec.test.mjs'], ['tests/lane-evaluator-db.test.mjs']]);
});

test('the lists come from package.json', () => {
  assert.deepEqual(listedTests({scripts: {test: 'node --test tests/a.test.mjs tests/b.test.mjs', 'test:db': 'node --test tests/c.test.mjs'}}), {unit: ['tests/a.test.mjs', 'tests/b.test.mjs'], db: ['tests/c.test.mjs']});
});
