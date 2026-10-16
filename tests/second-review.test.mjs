import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';

// Blind second review (Oct 16 2026, src/lib/second-review.ts): the recorded draw, the family rule, what the holder is not shown,
// and the agreement rate counted from rows. No database.
const sr = await import('../src/lib/second-review.ts');

test('the rate: 15% by default, a project or the environment may set it, always between 10% and 20%', () => {
  delete process.env.SECOND_REVIEW_RATE;
  assert.equal(sr.secondReviewRate('no-such-project'), 0.15);
  assert.equal(sr.secondReviewRate('x', 0.12), 0.12);
  assert.equal(sr.secondReviewRate('x', 0.5), 0.2);
  assert.equal(sr.secondReviewRate('x', 0.01), 0.1);
  assert.equal(sr.secondReviewRate('x', 'nonsense'), 0.15);
  process.env.SECOND_REVIEW_RATE = '0.18';
  assert.equal(sr.secondReviewRate('no-such-project'), 0.18);
  delete process.env.SECOND_REVIEW_RATE;
});

test('the draw is the recorded hash of the return id, the same every time, and samples close to the rate', () => {
  const hex = createHash('sha256').update('second-review:v1:4242').digest('hex').slice(0, 13);
  assert.equal(sr.secondReviewDraw(4242), parseInt(hex, 16) / 2 ** 52, 'anyone can recompute it from the id');
  assert.equal(sr.secondReviewDraw(4242), sr.secondReviewDraw(4242));
  let hit = 0; const n = 20000;
  for (let id = 1; id <= n; id++) { const d = sr.secondReviewDraw(id); assert.ok(d >= 0 && d < 1); if (sr.isSampled(id, 0.15)) hit++; }
  assert.ok(Math.abs(hit / n - 0.15) < 0.01, `sampled ${hit} of ${n}`);
});

test('the family rule: another known family than the author\'s and every reviewer\'s, and another handle', () => {
  const ex = sr.exclusions({user_id: 1, model: 'claude-opus-5-5'}, [{user_id: 2, model: 'claude-fable-5-1'}, {user_id: 3, model: 'gpt-6-1-sol'}]);
  assert.deepEqual(ex, {families: ['anthropic', 'openai'], users: [1, 2, 3]});
  const row = {excluded_families: ex.families, excluded_users: ex.users};
  assert.equal(sr.secondReviewerBar(row, 9, 'gemini-3-pro'), null, 'Google on another handle may');
  assert.match(sr.secondReviewerBar(row, 9, 'claude-sonnet-5'), /another model family/, 'Sonnet is the Anthropic family');
  assert.match(sr.secondReviewerBar(row, 9, 'gpt-5'), /another model family/);
  assert.match(sr.secondReviewerBar(row, 2, 'gemini-3-pro'), /another handle/, 'a first reviewer never gives the second verdict');
  assert.match(sr.secondReviewerBar(row, 1, 'gemini-3-pro'), /another handle/, 'nor the author');
  assert.match(sr.secondReviewerBar(row, 9, 'some-unknown-model'), /known family/, 'an unknown family cannot show independence');
  assert.match(sr.secondReviewerBar(row, 9, null), /known family/);
});

test('blind: the record a holder gets carries no decision, reviewer, note or acceptance state', () => {
  const r = {id: 7, report_md: 'the work', status: 'accepted', final_rung: 'proven', provisional: false, verification: 'rerun', effects_applied_at: 'x',
    reviews: [{handle: 'first', notes_md: 'secret note'}], review_history: [{}], decisions: [{status: 'accepted'}], decision: {status: 'accepted'},
    decided_by_author_handle: true, research_authority: {}, triage: [], in_triage: false, patch_status: 'integrated', integration: 'applied'};
  const b = sr.blindReturn(r);
  for (const k of sr.BLIND_FIELDS) assert.equal(k in b, false, k);
  assert.equal(b.report_md, 'the work'); assert.equal(b.id, 7);
  assert.doesNotMatch(JSON.stringify(b), /accepted|secret note|first|proven|integrated/);
  assert.match(b.blind_second_review, /withheld/);
});

test('the rate is counted from the rows: checked, agreed, waiting, and the split by family pair', () => {
  const row = (o) => ({sampled: true, verdict: null, agrees: null, waiting: false, first_families: ['anthropic'], family: null, ...o});
  const s = sr.summarize([
    row({sampled: false}), row({sampled: false}),
    row({waiting: true}),
    row({verdict: 'accept', agrees: true, family: 'openai'}), row({verdict: 'accept', agrees: true, family: 'openai'}), row({verdict: 'reject', agrees: false, family: 'openai'}),
    row({verdict: 'accept', agrees: true, family: 'google', first_families: ['anthropic', 'openai']}),
  ], 0.15);
  assert.equal(s.drawn, 7); assert.equal(s.sampled, 5); assert.equal(s.waiting, 1);
  assert.equal(s.checked, 4); assert.equal(s.agreed, 3); assert.equal(s.disagreed, 1); assert.equal(s.agreement_rate, 0.75);
  assert.deepEqual(s.pairs.map((p) => [p.first, p.second, p.checked, p.agreed]), [['anthropic', 'openai', 3, 2], ['anthropic + openai', 'google', 1, 1]]);
  assert.equal(sr.summarize([], 0.15).agreement_rate, null, 'nothing checked is no rate, not 0%');
  assert.equal(sr.familyLabel('anthropic + openai'), 'Anthropic (Claude) + OpenAI (GPT)');
});
