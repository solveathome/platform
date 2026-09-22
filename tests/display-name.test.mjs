import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';

// Pure rules: no database. The name is self-chosen and unchecked, so the rules stop it from reading as anything else.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://unused:unused@localhost:1/unused';
const {nameProblem, normalizeName, creditHtml, creditText} = await import('../src/lib/display-name.ts');

test('ordinary names from several alphabets pass', () => {
  for (const n of ['Chris Benjaminsen', "Niamh O'Brien", 'Jean-Luc Picard', 'J. R. R. Tolkien', 'José Ángel', 'Юрий Матиясевич', '張益唐', 'やまだ 太郎', '김민준', 'Zoë 2nd']) assert.equal(nameProblem(n), null, n);
});
test('whitespace is collapsed and the text is NFC', () => {
  assert.equal(normalizeName('  Chris   B.\tBenjaminsen '), 'Chris B. Benjaminsen');
  assert.equal(normalizeName('José'), 'José');
});
test('names that read as a check, a role, a handle or a link are refused', () => {
  for (const n of ['Terence Tao (verified)', 'Verified Chris', 'Official Tao', 'solveathome Staff', 'Trusted Reviewer', '@torvalds', 'me/you', 'https://x.io', 'Chris ✓', 'Chris 🙂', '<b>Chris</b>', '1Chris', '-Chris', 'Chris--B', 'x', 'a'.repeat(41)]) assert.ok(nameProblem(n), n);
});
test('mixed alphabets are refused: a Cyrillic letter inside a Latin name', () => {
  assert.ok(nameProblem('Terence Tаo'));
  assert.equal(nameProblem('Terence Tao'), null);
});
test('a credited person always carries the handle, and everything is escaped', () => {
  const named = creditHtml({handle: 'benj', display_name: 'Chris <i>B</i>'});
  assert.match(named, /href="\/@benj"/); assert.match(named, /@benj<\/span>/); assert.match(named, /Chris &lt;i&gt;B&lt;\/i&gt;/); assert.doesNotMatch(named, /<i>/);
  assert.equal(creditHtml({handle: 'benj', display_name: null}), '<a class="credit" href="/@benj">@benj</a>');
  assert.equal(creditText({handle: 'benj', display_name: 'Chris B'}), 'Chris B (@benj)');
  assert.equal(creditText({handle: 'benj'}), '@benj');
});
test('the open dataset never selects the display name: an export is permanent, a name must stay withdrawable', () => {
  for (const f of ['../scripts/dump.ts', '../src/lib/dump.ts']) assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /display_name/, f);
});
test('nothing an agent is served mentions the display name', () => {
  for (const f of ['brief.ts', 'orientation.ts', 'workspace-guidance.ts', 'research-guidance.ts', 'department-protocol.ts', 'verification.ts']) assert.doesNotMatch(readFileSync(new URL(`../src/lib/${f}`, import.meta.url), 'utf8'), /display_name/, f);
});
