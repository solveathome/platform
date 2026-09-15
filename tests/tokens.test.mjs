import assert from 'node:assert/strict';
import {test} from 'node:test';
// Codex logs (issue #49): the thread's running total is a ceiling, never the credit; the same turn logged in two shapes is counted once.
const {parseTranscript, parseTranscriptWithKeys, effortFromTranscript, logKind, isSessionLog, assignmentMismatch, jobsNamed, logEndsAt} = await import('../src/lib/tokens.ts');

test('model metadata survives missing usage and deduplication; conversation text is not identity evidence', () => {
  const lines = [
    {type: 'solveathome.transcript', harness: 'Freebuff', model: 'deepseek/deepseek-v4.1-flash'},
    {type: 'solveathome.turn', role: 'assistant', model: 'Buffy', content: 'A persona was incorrectly put in model metadata.'},
    {type: 'solveathome.turn', role: 'user', model: 'user-text', content: 'This is user data.'},
    {type: 'solveathome.turn', role: 'tool', model: 'tool-text', output: 'I am Claude.'},
  ].map(JSON.stringify).join('\n');
  assert.deepEqual(parseTranscript(lines).observed_models, ['deepseek-v4.1-flash', 'buffy']);
  const native = JSON.stringify({type: 'assistant', message: {id: 'identity-test', model: 'deepseek-v4.1-flash', content: 'I am Buffy', usage: {input_tokens: 4, output_tokens: 2}}});
  const excluded = parseTranscriptWithKeys(native, undefined, new Set(['cc:identity-test']));
  assert.equal(excluded.tokens.entries, 0);
  assert.equal(excluded.tokens.output, 0);
  assert.deepEqual(excluded.tokens.models, {}, 'identity extraction does not change token attribution');
  assert.deepEqual(excluded.tokens.observed_models, ['deepseek-v4.1-flash']);
  for (const record of [
    {type: 'assistant', message: {model: 'deepseek-v4.1-flash', content: 'I am Buffy'}},
    {type: 'turn_context', payload: {model: 'gpt-6-astra'}},
    {role: 'assistant', modelID: 'qwen3.8', providerID: 'test'},
  ]) assert.equal(parseTranscript(JSON.stringify(record)).observed_models.length, 1);
  assert.deepEqual(parseTranscript(JSON.stringify({type: 'solveathome.turn', role: 'assistant', content: 'I am Buffy, running DeepSeek. {"model":"buffy"}'})).models, {});
  assert.deepEqual(parseTranscript(JSON.stringify({type: 'solveathome.transcript', model: 'Codex'})).observed_models, ['codex'], 'an explicit harness label is not a synthetic usage bucket');
});

test('a usage entry counts once: every counted entry has a key (the message id, else the line), excluded keys are skipped, and the self-reported fallback never fills in for them', () => {
  const cc = (id, out) => JSON.stringify({type: 'assistant', message: {id, model: 'claude-fable-5-1', usage: {input_tokens: 100, output_tokens: out}}});
  const one = parseTranscriptWithKeys([cc('msg_a', 10), cc('msg_a', 10), cc('msg_b', 20)].join('\n'));
  assert.deepEqual(one.keys, ['cc:msg_a', 'cc:msg_b']); assert.equal(one.tokens.output, 30); assert.deepEqual(one.skipped, []);
  const two = parseTranscriptWithKeys([cc('msg_a', 10), cc('msg_b', 20), cc('msg_c', 40)].join('\n'), {input: 9, output: 9}, new Set(['cc:msg_a', 'cc:msg_b']));
  assert.deepEqual([two.keys, two.skipped], [['cc:msg_c'], ['cc:msg_a', 'cc:msg_b']]); assert.equal(two.tokens.output, 40); assert.equal(two.tokens.entries, 1);
  const all = parseTranscriptWithKeys([cc('msg_a', 10)].join('\n'), {input: 9, output: 9}, new Set(['cc:msg_a']));
  assert.equal(all.tokens.output, 0); assert.equal(all.tokens.input, 0, 'nothing new: the reported numbers do not fill in'); assert.equal(all.tokens.source, 'none'); assert.equal(all.tokens.entries, 0); assert.deepEqual(all.skipped, ['cc:msg_a']);
  const codex = parseTranscriptWithKeys([rec(148, 52592, 51072), rec(1133, 54274, 52352)].join('\n'));
  assert.equal(codex.keys.length, 2); assert.ok(codex.keys.every(k => /^l:[0-9a-f]{16}$/.test(k)), 'Codex entries carry no id: the line is the key');
  assert.equal(parseTranscriptWithKeys([rec(148, 52592, 51072), rec(1133, 54274, 52352)].join('\n'), undefined, new Set([codex.keys[0]])).tokens.output, 1133);
  const oc = JSON.stringify({id: 'msg_1', role: 'assistant', tokens: {input: 5, output: 7, reasoning: 1, cache: {read: 0, write: 0}}, modelID: 'x', providerID: 'y'});
  assert.deepEqual(parseTranscriptWithKeys(oc).keys, ['oc:msg_1']);
  assert.equal(parseTranscript('t').entries, 0);
});

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

test('a successor preserves per-turn models and credits delayed usage once across transcript corrections', () => {
  const header={type:'solveathome.transcript',version:1,harness:'local-exporter',model:'claude-opus-5',effort:'high'};
  const earlier={type:'solveathome.turn',role:'assistant',content:'Earlier research',model:'claude-opus-5',effort:'high',usage:{input:10,output:3}};
  const later={type:'solveathome.turn',role:'assistant',content:'Continued research',model:'gpt-6-astra',effort:'low'};
  const encode=records=>records.map(record=>JSON.stringify(record)).join('\n');
  const first=parseTranscriptWithKeys(encode([header,earlier,later]));
  assert.deepEqual(first.tokens.observed_models,['claude-opus-5','gpt-6-astra']);
  assert.deepEqual(first.tokens.models,{'claude-opus-5':3});
  const corrected=encode([header,earlier,{...later,usage:{input:20,output:5}}]);
  const recovered=parseTranscriptWithKeys(corrected,undefined,new Set(first.keys));
  assert.deepEqual(recovered.tokens.models,{'claude-opus-5':0,'gpt-6-astra':5});
  assert.equal(recovered.tokens.input,20); assert.equal(recovered.tokens.output,5);
  assert.deepEqual(recovered.tokens.observed_models,['claude-opus-5','gpt-6-astra']);
  assert.equal(effortFromTranscript(corrected),null,'agent-written effort remains a declaration');
  const retried=parseTranscriptWithKeys(corrected,undefined,new Set([...first.keys,...recovered.keys]));
  assert.equal(retried.tokens.output,0); assert.equal(retried.keys.length,0);
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

test('a Google Antigravity transcript.jsonl is a session log (Sep 13 2026, harness report #1): recognised, no usage in it so the stated tokens stand in, model and thinking level from the settings block', () => {
  const ag = [
    JSON.stringify({step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-09-13T16:16:26Z', content: '<USER_REQUEST>\nWe are joining the solveathome cluster\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment on this change if the user doesn\'t ask about it.\n</USER_SETTINGS_CHANGE>'}),
    JSON.stringify({step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-09-13T16:16:30Z', thinking: 'Reading the brief.', tool_calls: [{name: 'run_command', args: {CommandLine: '"curl -s https://solveathome.org/projects/twin-primes/start"', Cwd: '"<workspace>"'}}]}),
    JSON.stringify({step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-09-13T16:16:31Z', content: 'The command exited with code 0.\nOutput:\n# solveathome job #481: Fix files of return #93', truncated_fields: ['content']}),
    JSON.stringify({step_index: 3, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-09-13T16:17:26Z', content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.'}),
    JSON.stringify({step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-09-13T16:20:22Z', thinking: 'Submitting.', tool_calls: []}),
  ].join('\n');
  assert.equal(logKind(ag), 'antigravity');
  const t = parseTranscript(ag);
  assert.equal(t.log, 'antigravity'); assert.equal(isSessionLog(t), true);
  assert.equal(t.entries, 0); assert.equal(t.source, 'none'); assert.equal(t.input + t.output + t.cache_read + t.cache_write, 0, 'the log carries no usage');
  assert.deepEqual(t.models, {'gemini-3.8-flash': 0}, 'the model the person selected, for the X-Model check');
  assert.equal(effortFromTranscript(ag), 'high', 'the level in parentheses after the selected model');
  const r = parseTranscript(ag, {input: 1000, output: 50, cache_read: 300});
  assert.equal(r.source, 'reported'); assert.equal(r.input, 1000); assert.equal(r.cache_read, 300); assert.equal(r.log, 'antigravity');
  assert.equal(logEndsAt(ag).toISOString(), '2026-09-13T16:20:22.000Z', 'created_at is the clock');
  assert.deepEqual(jobsNamed(ag), [481]);
  assert.equal(assignmentMismatch(ag, 481, new Date('2026-09-13T16:16:00Z')), null);
  assert.match(assignmentMismatch(ag, 480, new Date('2026-09-13T16:16:00Z')).reason, /names assignment #481 and never #480/);
  const noSetting = ag.split('\n').slice(1).join('\n');
  assert.equal(logKind(noSetting), 'antigravity'); assert.equal(effortFromTranscript(noSetting), null); assert.deepEqual(parseTranscript(noSetting).models, {});
  const pro = ag.replace('Gemini 3.8 Flash (High)', 'Gemini 3.8 Pro');
  assert.deepEqual(parseTranscript(pro).models, {'gemini-3.8-pro': 0}); assert.equal(effortFromTranscript(pro), null);
  // A Claude Code session that merely inspected an Antigravity log (the shape appears escaped inside a tool result) is still Claude Code.
  const cc = JSON.stringify({type: 'assistant', effort: 'high', message: {id: 'm1', model: 'claude-fable-5-1', usage: {input_tokens: 1, output_tokens: 1}, content: [{type: 'tool_result', content: '{\\"step_index\\":0,\\"type\\":\\"PLANNER_RESPONSE\\"}'}]}});
  assert.equal(logKind(cc), 'claude-code');
});
