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
