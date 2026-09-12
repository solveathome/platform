import assert from 'node:assert/strict';
import {test} from 'node:test';
// Codex logs (issue #49): the thread's running total is a ceiling, never the credit; the same turn logged in two shapes is counted once.
const {parseTranscript, effortFromTranscript} = await import('../src/lib/tokens.ts');

const cum = (out, inp, cached) => JSON.stringify({type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {input_tokens: inp, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: out, total_tokens: inp + out}, last_token_usage: {input_tokens: 52592, cached_input_tokens: 51072, cache_write_input_tokens: 0, output_tokens: 148, total_tokens: 52740}}}});
const rec = (out, inp, cached) => JSON.stringify({type: 'token_usage_record', payload: {usage: {input_tokens: inp, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: out, total_tokens: inp + out}, thread_token_usage: {input_tokens: 7374324, cached_input_tokens: 7101184, output_tokens: 51309}}});

test('a second return in the same Codex thread is credited its own turns, not the thread total', () => {
  const t = parseTranscript([cum(51161, 7321732, 7050112), rec(148, 52592, 51072), cum(51309, 7374324, 7101184), rec(1133, 54274, 52352)].join('\n'));
  assert.equal(t.source, 'codex-jsonl');
  assert.equal(t.output, 1281, `output should be 148 + 1133, got ${t.output}`);
  assert.equal(t.input, (52592 - 51072) + (54274 - 52352));
  assert.equal(t.cache_read, 51072 + 52352);
  assert.equal(t.entries, 2, 'the token_count copies of the same turns were not counted twice');
});

test('a log with only token_count events still counts per turn, capped by the running total', () => {
  const only = (out, total) => JSON.stringify({type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {input_tokens: 1000, cached_input_tokens: 0, output_tokens: total, total_tokens: 1000 + total}, last_token_usage: {input_tokens: 500, cached_input_tokens: 0, output_tokens: out, total_tokens: 500 + out}}}});
  const t = parseTranscript([only(40, 4040), only(60, 4100)].join('\n'));
  assert.equal(t.output, 100);
  assert.equal(t.input, 1000, 'per-turn input sum capped at the thread total');
});

test("the thinking level comes from the session file's assistant lines, last one wins; Codex shapes give null", () => {
  const cc = [
    JSON.stringify({ type: "user", effort: "max", message: { content: "hi" } }),
    JSON.stringify({ type: "assistant", effort: "medium", message: { model: "claude-fable-5-1", usage: { input_tokens: 1, output_tokens: 1 } } }),
    JSON.stringify({ type: "assistant", effort: "high", perTurnEffort: null, message: { model: "claude-fable-5-1", usage: { input_tokens: 1, output_tokens: 1 } } }),
  ].join("\n");
  assert.equal(effortFromTranscript(cc), "high");
  assert.equal(effortFromTranscript(JSON.stringify({ type: "assistant", effort: "bogus" })), null);
  assert.equal(effortFromTranscript(JSON.stringify({ type: "token_usage_record", payload: { usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } } })), null);
  assert.equal(effortFromTranscript(""), null);
});
