import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import {sha256} from '../src/lib/document-publication.ts';
import {parseSequenceProposal, sequenceProposals} from '../src/lib/sequences.ts';

const draft = `# OEIS submission draft: Example count

<!-- ledger
status: PARTIAL
verdict: DRAFT
-->

Status: DRAFT for review before submission.

**NAME**

Number of example objects
at level n.

**DATA**

0, 2, -1, 9007199254740993

**OFFSET**

1

**COMMENTS**

The companion sequence already exists. More terms appear in later notes.

## Term provenance

An additional term 17 has been computed but is not in DATA.
`;

test('proposal terms and offset come only from their fields, without rounding large integers', () => {
  const proposal = parseSequenceProposal(draft);
  assert.equal(proposal.title, 'Example count');
  assert.equal(proposal.definition, 'Number of example objects at level n.');
  assert.equal(proposal.status, 'draft');
  assert.deepEqual(proposal.terms, ['0', '2', '-1', '9007199254740993']);
  assert.equal(proposal.offset, '1');
  assert.equal(parseSequenceProposal('# A note\n\nJust mentions OEIS.'), null);
  assert.deepEqual(parseSequenceProposal(draft.replace('0, 2, -1, 9007199254740993', '1, 2, unknown')).terms, []);
  assert.equal(parseSequenceProposal(draft.replace('\n1\n', '\n0, 2\n')).offset, '0, 2');
  assert.equal(parseSequenceProposal(draft.replace(/\n/g, '\r\n')).definition, proposal.definition);
});

test('retirement overrides historical draft text, while companion references do not retire an active proposal', () => {
  const retired = draft.replace('Status: DRAFT for review before submission.', 'Status: **RETIRED as a submission**, kept as a source for A123456.\nWas: DRAFT for review.');
  assert.equal(parseSequenceProposal(retired).status, 'retired');
  assert.match(parseSequenceProposal(retired).status_note, /A123456/);
  assert.equal(parseSequenceProposal(draft.replace('Status: DRAFT', '> # DO NOT SUBMIT. DUPLICATE.\n\nStatus: DRAFT')).status, 'retired');
  assert.equal(parseSequenceProposal(draft).status, 'draft');
});

test('only registered, published documents appear; accepted overlays replace their terms and status', () => {
  const temp = mkdtempSync(join(tmpdir(), 'sah-sequences-'));
  const repos = join(temp, 'repos'), overlay = join(temp, 'overlay'), root = join(repos, 'example');
  mkdirSync(join(root, 'research'), {recursive: true});
  mkdirSync(join(overlay, 'example', 'research'), {recursive: true});
  const path = 'research/oeis-example-submission.md';
  try {
    writeFileSync(join(root, path), draft);
    writeFileSync(join(root, 'unlisted.md'), draft);
    writeFileSync(join(temp, 'outside.md'), draft);
    symlinkSync(join(temp, 'outside.md'), join(root, 'escape.md'));
    writeFileSync(join(root, 'PUBLICATION.json'), JSON.stringify({version: 1, files: {[path]: {sha256: sha256(draft), mode: 'project'}, 'escape.md': {sha256: sha256(draft), mode: 'project'}}}));
    const paths = [path, path, 'unlisted.md', 'escape.md', '../../outside.md'];
    const list = sequenceProposals('example', paths, repos, overlay);
    assert.equal(list.length, 1);
    assert.equal(list[0].url, '/projects/example/docs/' + path);
    assert.equal(list[0].status, 'draft');
    writeFileSync(join(overlay, 'example', path), draft.replace('Status: DRAFT', 'Status: RETIRED').replace('0, 2, -1, 9007199254740993', '4, 5'));
    const revised = sequenceProposals('example', paths, repos, overlay)[0];
    assert.equal(revised.status, 'retired');
    assert.deepEqual(revised.terms, ['4', '5']);
    writeFileSync(join(root, path), draft + '\nChanged outside publication.');
    assert.deepEqual(sequenceProposals('example', paths, repos, overlay), []);
    assert.deepEqual(sequenceProposals('../example', paths, repos, overlay), []);
    assert.deepEqual(sequenceProposals('other-project', paths, repos, overlay), []);
    rmSync(join(root, 'PUBLICATION.json'));
    assert.deepEqual(sequenceProposals('example', paths, repos, overlay), []);
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('sequence UI separates retired proposals, escapes source text, and recovers from fetch failures', async () => {
  const context = vm.createContext({Intl, Date, AbortSignal, location: {hash: ''}, document: {querySelector: () => null, querySelectorAll: () => []}, addEventListener() {}});
  context.window = context;
  vm.runInContext(readFileSync(new URL('../public/assets/ui.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../public/assets/sequences.js', import.meta.url), 'utf8'), context);
  const front = {}, active = {}, retired = {}, retiredPanel = {}, retry = {};
  const ui = context.SA.createSequences({base: '/projects/example', front, active, retired, retiredPanel, retry});
  const candidate = {...parseSequenceProposal(draft), title: '<img src=x onerror=alert(1)>', url: '/docs/example', history_url: '/history/example'};
  ui.render([candidate, {...candidate, title: 'Retired duplicate', status: 'retired', status_label: 'Retired'}]);
  assert.ok(front.innerHTML.includes('&lt;img'));
  assert.ok(!active.innerHTML.includes('<img'));
  assert.ok(!active.innerHTML.includes('Retired duplicate'));
  assert.ok(retired.innerHTML.includes('Retired duplicate'));
  assert.equal(retiredPanel.hidden, false);
  assert.ok(active.innerHTML.includes('9007199254740993'));
  context.SA.json = async () => { throw new Error('offline'); };
  await ui.refresh();
  for (const list of [front, active]) assert.ok(list.innerHTML.includes('temporarily unavailable'));
  assert.equal(retry.hidden, false);
  assert.equal(retry.disabled, false);
  context.SA.json = async url => { assert.equal(url, '/projects/example/sequences'); return {sequences: []}; };
  await retry.onclick();
  assert.ok(active.innerHTML.includes('No active sequence proposals'));
  assert.equal(retry.hidden, true);
  assert.equal(retiredPanel.hidden, true);
});
