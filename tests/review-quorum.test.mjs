import assert from 'node:assert/strict';
import {test} from 'node:test';

// The per-project review quorum (Oct 9 2026; src/lib/consensus.ts). Default 1 keeps the rule every project had: the first trusted
// verdicts decide. Above 1 (the MD5 project sets 2), that many trusted verdicts from tier-1 sessions of different model families must agree.
const {decide, quorumFor} = await import('../src/lib/consensus.ts');
const {reviewQuorum, negativeQuorum} = await import('../src/lib/projects.ts');
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

// Chris, Oct 13 2026 (#sah-trusted-self-review): the author's own family may be one of the two. The count never asks who wrote the return.
test('quorum 2 with self review: the author\'s family and one other decide; two verdicts of one family never do', () => {
  const solReturn = [v('accept', 'anthropic'), v('accept', 'openai')];   // a Sol return: an Opus verdict and a Sol verdict
  assert.equal(decide(solReturn, 2).status, 'accepted');
  assert.equal(decide([v('accept', 'openai'), v('accept', 'openai')], 2).status, 'pending', 'Sol twice (two people, or Sol and Astra) is one family');
  assert.equal(decide([v('accept', 'anthropic'), v('accept', 'anthropic')], 2).status, 'pending', 'Opus and Fable are one family');
  assert.equal(decide([v('reject', 'anthropic'), v('reject', 'openai')], 2).status, 'rejected');
});

test('the project settings: MD5 asks for 2, twin primes keeps 1', () => {
  assert.equal(reviewQuorum('md5'), 2);
  assert.equal(reviewQuorum('twin-primes'), 1);
  assert.equal(reviewQuorum('no-such-project'), 1);
});

// A negative result (Chris, Oct 13 2026, #sah-md5-review-rules-a-b): declared by the author, confirmed by every counted reviewer, it is
// decided at the project's lower quorum. Everything short of that is the full quorum.
const n = (verdict, family, negative_result, tier1 = true, trusted = true) => ({...v(verdict, family, tier1, trusted), negative_result});
const rule = (votes, o = {}) => quorumFor({quorum: 2, negativeQuorum: 1, declaredNegative: true, votes, ...o});
const outcome = (votes, o) => { const r = rule(votes, o); return decide(votes, r.quorum, r.families).status; };

test('a declared negative result closes on one trusted tier-1 verdict that confirms the class, accept or reject', () => {
  assert.deepEqual(rule([n('accept', 'anthropic', true)]), {quorum: 1, families: true, negative: true});
  assert.equal(outcome([n('accept', 'anthropic', true)]), 'accepted');
  assert.equal(outcome([n('reject', 'openai', true)]), 'rejected');
  assert.equal(outcome([n('accept', 'anthropic', true), n('reject', 'openai', true)]), 'pending', 'two confirming families that disagree decide nothing');
  assert.equal(outcome([n('accept', 'anthropic', true), n('accept', 'anthropic', true)]), 'accepted');
});

test('a positive claim, or any doubt about the class, keeps the two-family rule', () => {
  const full = {quorum: 2, families: true, negative: false};
  assert.deepEqual(rule([n('accept', 'anthropic', true)], {declaredNegative: false}), full, 'no declaration: a reviewer cannot make a return negative');
  assert.equal(outcome([n('accept', 'anthropic', true)], {declaredNegative: false}), 'pending');
  assert.deepEqual(rule([n('accept', 'anthropic', null)]), full, 'the reviewer did not state the class');
  assert.deepEqual(rule([n('accept', 'anthropic', undefined)]), full);
  assert.equal(outcome([n('accept', 'anthropic', null)]), 'pending');
  assert.deepEqual(rule([n('accept', 'anthropic', false)]), full, 'the reviewer overrides a mislabelled return');
  assert.equal(outcome([n('accept', 'anthropic', false)]), 'pending');
  assert.deepEqual(rule([n('accept', 'anthropic', true), n('reject', 'openai', false)]), full, 'a later reviewer reclassifies: back to two families');
  assert.equal(outcome([n('accept', 'anthropic', true), n('reject', 'openai', false)]), 'pending');
  assert.equal(outcome([n('accept', 'anthropic', true), n('accept', 'openai', false)]), 'accepted', 'two families agree on the work, whatever its class');
  assert.deepEqual(rule([n('accept', 'anthropic', true), n('accept', 'openai', false, false)]), full, 'a trusted override counts from any tier');
  assert.deepEqual(rule([]), full, 'no verdict yet');
  assert.deepEqual(rule([n('accept', 'anthropic', true, false)]), full, 'a tier-2 confirmation does not count');
  assert.deepEqual(rule([n('accept', null, true)]), full, 'a model of unknown family does not count');
  assert.deepEqual(rule([n('accept', 'anthropic', true, true, false)]), full, 'an untrusted confirmation does not count');
  assert.equal(outcome([n('accept', 'anthropic', true, true, false)]), 'pending');
});

test('a project without the rule is untouched: quorum 1 stays the first trusted verdict, with or without a declaration', () => {
  for (const declaredNegative of [true, false]) for (const negativeQ of [null, 1]) {
    const r = quorumFor({quorum: 1, negativeQuorum: negativeQ, declaredNegative, votes: [n('accept', 'anthropic', true)]});
    assert.deepEqual(r, {quorum: 1, families: false, negative: false});
  }
  const votes = [n('reject', 'openai', true, false)];   // tier is not asked at quorum 1, as before
  assert.deepEqual(decide(votes, 1, false), decide(votes));
  assert.equal(decide(votes).status, 'rejected');
  assert.deepEqual(quorumFor({quorum: 2, negativeQuorum: null, declaredNegative: true, votes: [n('accept', 'anthropic', true)]}), {quorum: 2, families: true, negative: false}, 'a quorum project that did not set it');
  assert.deepEqual(quorumFor({quorum: 2, negativeQuorum: 2, declaredNegative: true, votes: [n('accept', 'anthropic', true)]}), {quorum: 2, families: true, negative: false}, 'a setting that lowers nothing');
});

test('the project settings: MD5 decides a confirmed negative on 1, twin primes has no such rule', () => {
  assert.equal(negativeQuorum('md5'), 1);
  assert.equal(negativeQuorum('twin-primes'), null);
  assert.equal(negativeQuorum('no-such-project'), null);
});
