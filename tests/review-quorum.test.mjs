import assert from 'node:assert/strict';
import {test} from 'node:test';

// The per-project review quorum (Oct 9 2026; src/lib/consensus.ts). Default 1 keeps the rule every project had: the first trusted
// verdicts decide. Above 1 (the MD5 project sets 2), that many trusted verdicts from tier-1 sessions of different model families must agree.
const {decide} = await import('../src/lib/consensus.ts');
const {reviewQuorum} = await import('../src/lib/projects.ts');
const v = (verdict, family, tier1 = true, trusted = true) => ({verdict, weight: 1, provider: family ?? 'x', rung: 'verified', trusted, family, tier1});

test('quorum 1 is the rule as before: one trusted verdict decides, a split waits, advisory votes are provisional', () => {
  assert.equal(decide([v('accept', 'anthropic')]).status, 'accepted');
  assert.equal(decide([v('accept', 'anthropic')], 1).status, 'accepted');
  assert.equal(decide([v('reject', 'openai', false)]).status, 'rejected', 'tier is not asked at quorum 1');
  assert.equal(decide([v('accept', 'anthropic'), v('reject', 'openai')]).status, 'pending');
  assert.deepEqual(decide([v('accept', 'a', true, false), v('accept', 'b', true, false), v('accept', 'c', true, false)]), decide([v('accept', 'a', true, false), v('accept', 'b', true, false), v('accept', 'c', true, false)], 1));
});

test('quorum 2: two trusted tier-1 verdicts from different families must agree', () => {
  assert.equal(decide([v('accept', 'anthropic')], 2).status, 'pending', 'one verdict is not enough');
  assert.equal(decide([v('accept', 'anthropic'), v('accept', 'anthropic')], 2).status, 'pending', 'two of one family are one family');
  assert.equal(decide([v('accept', 'anthropic'), v('accept', 'openai', false)], 2).status, 'pending', 'a tier-2 verdict does not count');
  assert.equal(decide([v('accept', 'anthropic'), v('accept', 'openai', true, false)], 2).status, 'pending', 'an untrusted verdict does not count');
  const ok = decide([v('accept', 'anthropic'), v('accept', 'openai')], 2);
  assert.equal(ok.status, 'accepted'); assert.equal(ok.provisional, false); assert.equal(ok.by, 'trusted');
  assert.equal(decide([v('accept', 'anthropic'), v('reject', 'openai')], 2).status, 'pending', 'disagreement decides nothing');
  assert.equal(decide([v('reject', 'anthropic'), v('reject', 'openai')], 2).status, 'rejected');
  assert.equal(decide([v('accept', 'anthropic'), v('accept', 'openai'), v('reject', 'google')], 2).status, 'accepted', 'two families against one');
  assert.equal(decide([v('accept', null), v('accept', 'openai')], 2).status, 'pending', 'a model of unknown family does not count');
});

test('the project settings: MD5 asks for 2, twin primes keeps 1', () => {
  assert.equal(reviewQuorum('md5'), 2);
  assert.equal(reviewQuorum('twin-primes'), 1);
  assert.equal(reviewQuorum('no-such-project'), 1);
});
