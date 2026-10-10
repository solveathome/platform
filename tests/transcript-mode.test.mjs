// Summary or full transcript (Chris, Oct 10 2026): the instruction's transcript setting, summary by default; what a summary holds; the brief by mode.
import assert from 'node:assert/strict';
import {test} from 'node:test';
const {recordedTranscriptMode, sessionTranscriptMode, summaryGaps, SUMMARY_SECTIONS, logKind, parseTranscript} = await import('../src/lib/tokens.ts');
const {parseInstruction} = await import('../src/routes/job.ts');
const {renderBrief} = await import('../src/lib/brief.ts');
const {protocolSections} = await import('../src/lib/department-protocol.ts');

const summary = SUMMARY_SECTIONS.map((s) => `## ${s}\n\nSomething about ${s.toLowerCase()}.`).join('\n\n');
const claudeLog = JSON.stringify({type: 'assistant', message: {id: 'm1', model: 'claude-fable-5-1', usage: {input_tokens: 10, output_tokens: 2}}});

test('the instruction carries transcript=summary|full; summary when absent; a session from before the setting is full', () => {
  assert.equal(parseInstruction({}).ai.transcript_mode, 'summary');
  assert.equal(parseInstruction({transcript: 'full'}).ai.transcript_mode, 'full');
  assert.equal(parseInstruction({transcript: 'FULL'}).ai.transcript_mode, 'full');
  assert.match(parseInstruction({transcript: 'log'}).error, /transcript must be one of summary, full/);
  assert.equal(sessionTranscriptMode({transcript_mode: 'summary'}), 'summary');
  assert.equal(sessionTranscriptMode({transcript_preapproved: true}), 'full');
  assert.equal(sessionTranscriptMode(null), 'full');
});

test('the recorded mode: a session log is full whatever was declared; an unknown log is full unless declared; otherwise the declaration, then the session', () => {
  assert.equal(recordedTranscriptMode('summary', 'summary', parseTranscript(claudeLog)), 'full');
  assert.equal(recordedTranscriptMode(undefined, 'summary', {log: logKind(summary)}), 'summary');
  assert.equal(recordedTranscriptMode(undefined, 'full', {log: logKind(summary)}), 'full');
  assert.equal(recordedTranscriptMode('summary', 'full', {log: logKind(summary)}), 'summary');
  assert.equal(recordedTranscriptMode(undefined, 'summary', {log: 'unknown'}), 'full');
  assert.equal(recordedTranscriptMode('summary', 'summary', {log: 'unknown'}), 'summary');
});

test('a summary names its sections by heading; the gaps are what a reviewer would miss', () => {
  assert.deepEqual(summaryGaps(summary), []);
  assert.deepEqual(summaryGaps('## Approach\nx\n### Steps\ny\n## Results\nz'), ['Reasoning', 'Dead ends', 'Sources']);
  assert.deepEqual(summaryGaps('plain prose'), [...SUMMARY_SECTIONS]);
  assert.equal(logKind(summary), 'summary');
  const reported = parseTranscript(summary, {input: 100, output: 20});
  assert.equal(reported.source, 'reported'); assert.equal(reported.input, 100);
});

test('the brief asks for what the session chose: a summary with usage totals, or the scrubbed log', () => {
  const job = {id: 7, type: 'explore', title: 'T', brief_md: 'Do it.', git_ref: 'main', compute_hint: {}, budget_hours: 2, repo_url: ''};
  const base = {id: 's1', jobs: 1, max: 1, maxHours: 2, compute: 'not offered', transcriptPreapproved: true};
  const s = renderBrief(job, 'https://x.invalid/projects/p', {...base, transcriptMode: 'summary'});
  assert.match(s, /\*\*Transcript \(required\): a summary\.\*\*/);
  assert.match(s, /"transcript_mode": "summary"/); assert.match(s, /## Dead ends/); assert.match(s, /transcript=full/);
  assert.doesNotMatch(s, /Cut whole JSONL lines/);
  const f = renderBrief(job, 'https://x.invalid/projects/p', {...base, transcriptMode: 'full'});
  assert.match(f, /Cut whole JSONL lines/); assert.match(f, /"transcript_mode": "full"/); assert.doesNotMatch(f, /a summary\.\*\*/);
  assert.match(renderBrief(job, 'https://x.invalid/projects/p', base), /Cut whole JSONL lines/, 'a session from before the setting keeps the log');
});

test('the publication protocol describes both modes: summary first, the log for transcript=full', () => {
  const pub = protocolSections('https://x.invalid/projects/p').publication;
  assert.match(pub, /a summary\.\*\*/); assert.match(pub, /transcript=full/); assert.match(pub, /Cut whole JSONL lines/);
});
