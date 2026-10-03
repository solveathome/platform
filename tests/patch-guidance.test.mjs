import assert from 'node:assert/strict';
import {test} from 'node:test';
import {patchKind, patchGuidance} from '../src/lib/patch-guidance.ts';

const diff = (old, next = old) => `--- ${old}\n+++ ${next}\n@@ -1 +1 @@\n-old\n+new\n`;
const qc = 'Check bound OUTPUT with embed.js --check; regenerate only when required.';

test('prose-only diffs do not demand script output regeneration, even when text mentions scripts', () => {
  const patch = diff('a/research/OUTCOMES.md', 'b/research/OUTCOMES.md').replace('+new', '+See producer.py and its original OUTPUT.');
  assert.equal(patchKind(patch), 'documents');
  assert.match(patchGuidance(patch, qc), /apply it to a copy/);
  assert.doesNotMatch(patchGuidance(patch, qc), /embed\.js|regenerate/);
});

test('mixed, quoted, added and deleted script targets retain configured checks', () => {
  for (const patch of [diff('a/x.md') + diff('a/x.py'), diff('"a/space name.py"', '"b/space name.py"'), '--- /dev/null\n+++ b/new.py\n@@ -0,0 +1 @@\n+print(1)\n', '--- a/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-print(1)\n']) {
    assert.equal(patchKind(patch), 'scripts');
    assert.match(patchGuidance(patch, qc), /embed\.js --check/);
  }
});

test('ambiguous, extensionless or malformed patches never assert that script checks are unnecessary', () => {
  const prose = 'diff --git a/note.md b/note.md\n' + diff('a/note.md', 'b/note.md');
  const mode = 'diff --git a/producer.py b/producer.py\nold mode 100644\nnew mode 100755\n';
  const rename = 'diff --git a/old.py b/new.py\nsimilarity index 100%\nrename from old.py\nrename to new.py\n';
  for (const patch of ['rename from x.md\nrename to y.md', diff('a/runner'), diff('a/x.bin'), '--- a/x.md\n+++ b/x.md\n@@ -3,2 +3,2 @@\n-old\n+new\n', mode + prose, prose + mode, rename + prose, prose + rename]) {
    assert.equal(patchKind(patch), 'unknown');
    assert.doesNotMatch(patchGuidance(patch, qc), /no bound output block/);
    assert.match(patchGuidance(patch, qc), /If a touched script/);
  }
});
