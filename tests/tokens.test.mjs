import assert from 'node:assert/strict';
import {test} from 'node:test';
// Codex logs (issue #49): the thread's running total is a ceiling, never the credit; the same turn logged in two shapes is counted once.
const {parseTranscript, effortFromTranscript, logKind, isSessionLog, assignmentMismatch, jobsNamed, logEndsAt} = await import('../src/lib/tokens.ts');

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

test('a Copilot CLI events log is recognised: usage from model_call_success lines, the answering model kept for the X-Model check', () => {
  const log = [
    JSON.stringify({type: 'user.message', data: {content: 'We are joining the solveathome cluster'}}),
    JSON.stringify({type: 'assistant.turn_start', data: {turnId: '0'}}),
    JSON.stringify({type: 'model.model_call_success', data: {kind: 'model_call_success', turn: 0, responseUsage: {completion_tokens: 14, prompt_tokens: 251, prompt_tokens_details: {cached_tokens: 51}, total_tokens: 265}, copilotUsage: {token_details: [{model: 'gpt-4o-mini', token_count: 251, token_type: 'input'}]}}}),
    JSON.stringify({type: 'assistant.message', data: {model: 'gpt-6-astra', content: '', toolRequests: []}}),
    JSON.stringify({type: 'tool.execution_complete', data: {toolCallId: 'x', model: 'gpt-6-astra', success: true, result: {content: 'ok'}}}),
    JSON.stringify({type: 'model.model_call_success', data: {kind: 'model_call_success', turn: 1, responseUsage: {completion_tokens: 100, prompt_tokens: 1000, prompt_tokens_details: {cached_tokens: 0}}, copilotUsage: {token_details: [{model: 'gpt-6-astra', token_count: 1000, token_type: 'input'}]}}}),
  ].join('\n');
  const t = parseTranscript(log);
  assert.equal(t.source, 'copilot-jsonl'); assert.equal(t.log, 'copilot'); assert.equal(t.entries, 2);
  assert.equal(t.input, 200 + 1000); assert.equal(t.cache_read, 51); assert.equal(t.output, 114);
  assert.deepEqual(t.models, {'gpt-4o-mini': 14, 'gpt-6-astra': 100});
  assert.equal(isSessionLog(t), true);
  assert.equal(effortFromTranscript(log), null);
});

test('a summary the agent wrote is not a session log; the harness logs are', () => {
  const summary = [
    JSON.stringify({type: 'activity_summary', notice: 'This is a task-specific activity summary, not a native conversation transcript. No internal reasoning or token-usage metadata is supplied.'}),
    JSON.stringify({type: 'activity_summary', action: 'Read assignment 82 and return 14.'}),
    JSON.stringify({type: 'activity_summary', action: 'Compared every patch hunk with the manuscript.'}),
    JSON.stringify({type: 'activity_summary', action: 'Submitted the review.'}),
  ].join('\n');
  assert.equal(logKind(summary), 'summary');
  const t = parseTranscript(summary); assert.equal(t.source, 'none'); assert.equal(t.log, 'summary'); assert.equal(isSessionLog(t), false);
  assert.equal(logKind('I read the return and it looked fine.'), 'summary');
  assert.equal(logKind([1,2,3,4].map(i => JSON.stringify({step: i, did: 'things'})).join('\n')), 'unknown');
  assert.equal(logKind(JSON.stringify({type: 'assistant', effort: 'high', message: {model: 'claude-fable-5-1', usage: {input_tokens: 1, output_tokens: 1}}})), 'claude-code');
  assert.equal(logKind(cum(1, 2, 0)), 'codex');
  assert.equal(logKind(rec(1, 2, 0)), 'codex');
  assert.equal(parseTranscript(cum(1, 2, 0)).log, 'codex');
});

test('an OpenCode session log counts each assistant message once (output includes reasoning) and its variant is the thinking level; a withheld transcript is neither a log nor a summary', () => {
  const log = [
    JSON.stringify({role: 'user', time: {created: 1}, agent: 'plan', model: {providerID: 'vllm', modelID: 'qwen3.8:27b'}, _line: 'message'}),
    JSON.stringify({id: 'msg_1', parentID: 'msg_0', role: 'assistant', mode: 'plan', agent: 'plan', variant: 'xhigh', cost: 0, tokens: {total: 9558, input: 8173, output: 97, reasoning: 1288, cache: {write: 0, read: 0}}, modelID: 'qwen3.8:27b', providerID: 'vllm', finish: 'tool-calls', _line: 'message'}),
    JSON.stringify({type: 'step-finish', tokens: {total: 9558, input: 8173, output: 97, reasoning: 1288, cache: {write: 0, read: 0}}, cost: 0}),
    JSON.stringify({id: 'msg_1', role: 'assistant', variant: 'xhigh', tokens: {input: 8173, output: 97, reasoning: 1288, cache: {read: 0, write: 0}}, modelID: 'qwen3.8:27b', providerID: 'vllm'}),
    JSON.stringify({id: 'msg_2', role: 'assistant', variant: 'high', tokens: {input: 100, output: 10, reasoning: 5, cache: {read: 50, write: 7}}, modelID: 'qwen3.8:27b', providerID: 'vllm'}),
  ].join('\n');
  const t = parseTranscript(log);
  assert.equal(t.log, 'opencode'); assert.equal(t.source, 'opencode-jsonl'); assert.equal(t.entries, 2);
  assert.equal(t.input, 8273); assert.equal(t.output, 1400); assert.equal(t.cache_read, 50); assert.equal(t.cache_write, 7);
  assert.deepEqual(t.models, {'qwen3.8': 1400});
  assert.equal(effortFromTranscript(log), 'high');
  const withheld = parseTranscript('[transcript withheld: recorded before launch, before scrubbing was enforced]');
  assert.equal(withheld.log, 'withheld'); assert.equal(isSessionLog(withheld), false);
});

test('the solveathome format (agent-written) is accepted as a transcript: counted as stated, model from the header, no thinking-level evidence', () => {
  const log = [
    JSON.stringify({type: 'solveathome.transcript', version: 1, harness: 'my-runner', model: 'gpt-6-astra', effort: 'high'}),
    JSON.stringify({type: 'solveathome.turn', role: 'user', content: 'We are joining the solveathome cluster'}),
    JSON.stringify({type: 'solveathome.turn', role: 'assistant', content: 'Fetching /start', usage: {input: 1234, output: 56, cache_read: 0, cache_write: 0}}),
    JSON.stringify({type: 'solveathome.turn', role: 'tool', name: 'bash', input: 'curl …', output: 'ok'}),
    JSON.stringify({type: 'solveathome.turn', role: 'assistant', content: 'Done', usage: {input: 2000, output: 300, cache_read: 1000}}),
  ].join('\n');
  const t = parseTranscript(log);
  assert.equal(t.log, 'custom'); assert.equal(t.source, 'custom-jsonl'); assert.equal(isSessionLog(t), true); assert.equal(t.entries, 2);
  assert.equal(t.input, 3234); assert.equal(t.output, 356); assert.equal(t.cache_read, 1000); assert.deepEqual(t.models, {'gpt-6-astra': 356});
  assert.equal(effortFromTranscript(log), null);
});

test('issue #55: a log naming other assignments and never this one, or ending before it was handed out, is a mismatch; one naming this job, escaped or plain, is not', () => {
  const line = (o) => JSON.stringify(o);
  // Return #160's shape: the brief of job #282 in a tool result (escaped), the claim post's job_id in a tool input (escaped), timestamps hours before job #358.
  const foreign = [
    line({type: 'user', timestamp: '2026-09-11T16:00:38.893Z', message: {content: [{type: 'tool_result', content: '# solveathome job #282: Explore Q-xchannel-offset\n\nTaking job #282.'}]}}),
    line({type: 'assistant', timestamp: '2026-09-11T16:01:10.230Z', message: {id: 'f1', model: 'claude-opus-5', usage: {input_tokens: 1, output_tokens: 1}, content: [{type: 'tool_use', input: {body: JSON.stringify({job_id: 282, kind: 'claim'})}}]}}),
  ].join('\n');
  assert.deepEqual(jobsNamed(foreign), [282]);
  assert.equal(logEndsAt(foreign).toISOString(), '2026-09-11T16:01:10.230Z');
  const m = assignmentMismatch(foreign, 358, new Date('2026-09-11T18:30:00Z'));
  assert.match(m.reason, /names assignment #282 and never #358/); assert.deepEqual(m.jobs_named, [282]); assert.equal(m.job, 358);
  assert.equal(assignmentMismatch(foreign, 282, new Date('2026-09-11T15:55:00Z')), null, 'its own assignment');
  const both = foreign + '\n' + line({type: 'assistant', timestamp: '2026-09-11T18:40:00Z', message: {content: [{type: 'tool_use', input: {body: '{"job_id": 358}'}}]}});
  assert.equal(assignmentMismatch(both, 358, new Date('2026-09-11T18:30:00Z')), null, 'a session that did two assignments names both');
  assert.deepEqual(jobsNamed('{"job_id":"77"} and \\"job_id\\": 78 and "job_id" : 79'), [77, 78, 79]);
  // Names nothing: only the time can tell, with an hour of slack for clocks.
  const early = [line({type: 'user', timestamp: '2026-09-11T16:00:38Z', message: {content: 'hi'}}), line({type: 'assistant', timestamp: '2026-09-11T16:01:10Z', message: {content: 'ok'}})].join('\n');
  const e = assignmentMismatch(early, 358, new Date('2026-09-11T18:30:00Z'));
  assert.match(e.reason, /last line is from 2026-09-11 16:01 UTC, before assignment #358 was handed out at 2026-09-11 18:30 UTC/); assert.equal(e.ends_at, '2026-09-11T16:01:10.000Z');
  assert.equal(assignmentMismatch(early, 358, new Date('2026-09-11T16:50:00Z')), null, 'within the slack');
  assert.equal(assignmentMismatch(early, 358, null), null, 'no assignment time, nothing to compare');
  assert.equal(assignmentMismatch('t', 358, new Date()), null, 'a bare placeholder names and dates nothing');
  const oc = line({role: 'assistant', time: {created: Date.parse('2026-09-11T16:01:10Z')}, tokens: {input: 1, output: 1}, modelID: 'x', providerID: 'y'});
  assert.equal(logEndsAt(oc).toISOString(), '2026-09-11T16:01:10.000Z', 'OpenCode millisecond times');
  assert.equal(logEndsAt(line({time: {created: 1}})), null, 'a small counter is not a time');
});
