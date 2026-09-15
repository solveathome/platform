import assert from 'node:assert/strict';
import {test} from 'node:test';
// A patch that changes a ledger-bearing note without touching its block is warned about (issue #48). Pure functions; the project rule drives the check.
const {ledgerRange, parsePatch} = await import('../src/lib/ledger.ts');
const {omissionShare} = await import('../src/lib/tokens.ts');
const {patchHash} = await import('../src/lib/duplicates.ts');
const rule = {start: '<!-- ledger', end: '-->'};
const note = `# Title\n\n<!-- ledger\nid: Q-x\nstatus: PARTIAL\nverdict: c<4 for every u>4\n-->\n\nBody line 9\nBody line 10\n`;

test('ledgerRange finds the block by lines, 1-based', () => {
  assert.deepEqual(ledgerRange(note, rule), {start: 3, end: 7});
  assert.equal(ledgerRange('no block here', rule), null);
});

test('parsePatch lists files and old-side hunk ranges; a hunk inside the block counts as touching it', () => {
  const p = `diff --git a/research/x.md b/research/x.md\n--- a/research/x.md\n+++ b/research/x.md\n@@ -9,2 +9,3 @@\n Body line 9\n+Proposition 6\n Body line 10\n`;
  const m = parsePatch(p);
  assert.deepEqual([...m.keys()], ['research/x.md']);
  assert.deepEqual(m.get('research/x.md'), [{start: 9, end: 10}]);
  const r = ledgerRange(note, rule);
  assert.equal(m.get('research/x.md').some(h => h.end >= r.start && h.start <= r.end), false, 'body-only hunk does not touch the block');
  const p2 = `--- a/research/x.md\n+++ b/research/x.md\n@@ -6 +6 @@\n-verdict: c<4 for every u>4\n+verdict: c<2 for every u>4\n`;
  assert.equal(parsePatch(p2).get('research/x.md').some(h => h.end >= r.start && h.start <= r.end), true);
});

// Issues #62 and #70: the count is read from the decoded tool outputs, not from the raw text. Matching the marker anywhere
// counted a scrubber's own template quoted in a displayed helper, a note written in the report, and the same native record
// echoed twice, and it mixed units, so a transcript could be told it replaced 7 of 3 outputs, or 8 of 13 that were all there.
// Measured over the 29 transcripts the old rule labelled "mostly omitted": 24 of them were not.
test('issue #62: an omission note quoted inside a retained output does not replace it', () => {
  const log = [
    JSON.stringify({type: 'response_item', payload: {type: 'custom_tool_call', input: 'print("[Prior-context replay omitted; originals retained.]")'}}),
    JSON.stringify({type: 'response_item', payload: {type: 'custom_tool_call_output', output: 'The helper contains this literal string: [Prior-context replay omitted; originals retained.]\nFull source and result retained.'}}),
  ].join('\n');
  assert.deepEqual(omissionShare(log), {outputs: 1, omitted: 0, share: 0}, 'the marker is quoted source content, and the tool-call input is not an output');
});

test('issue #70: a note in the report or a repeated envelope is not a replaced output, and omitted never exceeds outputs', () => {
  const log = [
    JSON.stringify({type: 'response_item', payload: {type: 'custom_tool_call_output', output: 'rows: 12\nok'}}),
    JSON.stringify({type: 'response_item', payload: {type: 'custom_tool_call_output', output: 'rows: 13\nok'}}),
    JSON.stringify({type: 'response_item', payload: {type: 'custom_tool_call_output', output: 'rows: 14\nok'}}),
    JSON.stringify({type: 'response_item', payload: {type: 'output_text', text: 'I omitted the deleted directory from the diff [author directory omitted]; the reads are all here.'}}),
    JSON.stringify({type: 'event_msg', payload: {type: 'item_completed', text: 'I omitted the deleted directory from the diff [author directory omitted]; the reads are all here.'}}),
  ].join('\n');
  const om = omissionShare(log);
  assert.deepEqual(om, {outputs: 3, omitted: 0, share: 0});
  assert.ok(om.omitted <= om.outputs, 'the numerator and the denominator count the same thing');
});

test('a note that stands in for a payload is still counted, once per output, however it is nested', () => {
  const long = '[Third-party search/source payload omitted. Exact upper statement inspected: Klaus Dohmen, arXiv:1004.3416v2, section 1 Proposition 1.1 equation (2), and the bound it gives for the inclusion-exclusion tail, which is what this assignment needed from it.]';
  const nested = JSON.stringify({type: 'response_item', payload: {type: 'custom_tool_call_output', output: [
    {type: 'input_text', text: 'Script completed\nWall time 5.3 seconds\nOutput:\n'},
    {type: 'input_text', text: long},
  ]}});
  const twice = JSON.stringify({type: 'response_item', payload: {type: 'custom_tool_call_output', output: `${long}\n${long}`}});
  const plain = JSON.stringify({type: 'custom_tool_call_output', output: 'real output'});
  const om = omissionShare([nested, twice, plain].join('\n'));
  assert.deepEqual(om, {outputs: 3, omitted: 2, share: 2 / 3}, 'a long note is still a note; two notes in one output are one omission');
  assert.equal(omissionShare(JSON.stringify({type: 'tool_result', content: [{type: 'text', text: long}]})).omitted, 1, 'a Claude Code tool_result counts too');
  assert.equal(omissionShare(JSON.stringify({type: 'custom_tool_call_output', output: '[{"id":1,"note":"omitted"}]'})).omitted, 0, 'a JSON array is output, not a note');
});

test('omissionShare counts tool outputs and omission notes (issue #46)', () => {
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(JSON.stringify({type: 'custom_tool_call_output', output: i < 7 ? '[Bulk project-source/tool payload omitted from public transcript.]' : 'real output'}));
  const om = omissionShare(lines.join('\n'));
  assert.deepEqual([om.outputs, om.omitted], [10, 7]); assert.ok(om.share > 0.5);
  assert.deepEqual(omissionShare('prose transcript'), {outputs: 0, omitted: 0, share: 0});
});

test('patchHash ignores index lines, headers, trailing whitespace and line endings (issue #51)', () => {
  const a = `diff --git a/x.md b/x.md\nindex 1111111..2222222 100644\n--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-old\n+new\n`;
  const b = `--- a/x.md \r\n+++ b/x.md\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n\r\n`;
  assert.equal(patchHash(a), patchHash(b));
  assert.notEqual(patchHash(a), patchHash(a.replace('+new', '+newer')));
  assert.equal(patchHash(''), null);
});
