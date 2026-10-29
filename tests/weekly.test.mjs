import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';

// The weekly progress post (#sah-weekly-progress-build): the template, word for word against the approved sample (22 to 28 Oct 2026,
// mba notes/solveathome-weekly-progress-proposal.md), and the check that keeps or drops a model's What moved line. No database.
const {renderPost, fitPost, checkSummary, weekLabel, aboutTokens, weeklyConfig} = await import('../src/lib/weekly.ts');
const tp = JSON.parse(readFileSync(new URL('../projects/twin-primes/project.json', import.meta.url), 'utf8'));
const cfg = weeklyConfig(tp);

// The sample week's numbers as production counted them on 29 Oct 2026.
const N = {agents: 1001, people: 8, sessions_before: 3968, sessions_after: 4965, returns: 1036, accepted: 292, by_rung: {proven: 100, measured: 167, verified: 24, heuristic: 1},
  rejected: 8, recorded: 734, pending: 2, reviews: 290, tokens: 189180616, cpu_hours: 755.86,
  routes: {moved: 198, new: 79, result: 11, known: 47, blocked: 6, now: {active: 137, proposed: 12, blocked: 38, paused: 8, result: 62, known: 112}},
  papers_accepted: 8, document_versions: 15, documents: 9, findings_opened: 196, findings_resolved: 8,
  top: [{handle: 'alvinhhh', points: 4509}, {handle: 'RedesignedRobot', points: 3447}, {handle: 'malaiwah', points: 3160}, {handle: 'maxime-fleury', points: 2729}, {handle: 'moreisee', points: 1894}],
  excluded_handles: ['Benjaminsen'], also: [{slug: 'md5', label: 'MD5 challenge', agents: 157, returns: 82, accepted: 9, records: 0}]};
const M = {name: 'Twin Prime Conjecture', slug: 'twin-primes', base: 'https://solveathome.org', start: '2026-10-22', end: '2026-10-28', closing: cfg.closing};
const LINES = [
  {text: 'A count over the primes up to 37# could not be checked before, because its files were never published. Agents rebuilt it with a new, published tool. That tool repeats the earlier 31# record exactly, cell for cell (route 350).', routes: [350], returns: []},
  {text: 'A short proof: allowing one more prime always blocks at least one more step of a row of candidate twins (route 362).', routes: [362], returns: []},
];

test('the sample post, word for word, with the one heuristic acceptance the sample left out', () => {
  assert.equal(renderPost(M, N, LINES), `**Twin Prime Conjecture: week of 22 to 28 Oct**

**This week**
- 1,001 agents from 8 people worked on the problem. The all-time count went from 3,968 to 4,965, up 25 %.
- 1,036 returns came in. 292 were accepted after review: 100 proven, 167 measured, 24 verified, 1 heuristic. 8 were not accepted.
- 290 reviews. About 190 million tokens and 756 CPU hours went into the work.

**Research routes**
- 198 routes moved. 79 are new.
- 11 reached a result. 47 turned out to be known already in the literature, so nobody spends more time on them. 6 are blocked and wait for a new idea.
- Now open: 137 active, 12 proposed, 46 blocked or paused. Closed: 62 results, 112 known.

**What moved**
- ${LINES[0].text}
- ${LINES[1].text}

**Top contributors this week** (points)
alvinhhh 4,509 · RedesignedRobot 3,447 · malaiwah 3,160 · maxime-fleury 2,729 · moreisee 1,894

**MD5 challenge:** 157 agents, 82 returns, 9 accepted. No new record this week.

Nothing here settles the conjecture. The work is partial results, checks and a list of closed routes.
Full week: [solveathome.org/projects/twin-primes/weekly/2026-10-28](https://solveathome.org/projects/twin-primes/weekly/2026-10-28)`);
});

test('no summary: the post goes out with numbers only; no reviewer is named and there is no "% solved"', () => {
  const t = renderPost(M, N, []);
  assert.doesNotMatch(t, /What moved/);
  assert.doesNotMatch(t, /solved/i);
  assert.doesNotMatch(t, /Benjaminsen/);
});

test('over 2,000 characters, What moved lines go first, last one first', () => {
  const long = Array.from({length: 4}, (_, i) => ({text: `${'x'.repeat(380)} (route ${350 + i})`, routes: [350 + i], returns: []}));
  const f = fitPost(M, N, long);
  assert.ok(f.text.length <= 2000);
  assert.ok(f.lines.length < 4 && f.lines.length >= 1);
  assert.deepEqual(f.lines, long.slice(0, f.lines.length));
});

test('labels and rounding', () => {
  assert.equal(weekLabel('2026-10-26', '2026-11-01'), '26 Oct to 1 Nov');
  assert.equal(weekLabel('2026-12-28', '2027-01-03'), '28 Dec 2026 to 3 Jan 2027');
  assert.equal(aboutTokens(189180616), '190 million');
  assert.equal(aboutTokens(4_340_000), '4.3 million');
  assert.equal(aboutTokens(1_234_000_000), '1.2 billion');
});

test('the config: on for Twin Prime from the week of 26 Oct, two approvals, the project account out of the top list', () => {
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.since, '2026-10-26');
  assert.equal(cfg.approvals_required, 2);
  assert.deepEqual(cfg.exclude_handles, ['Benjaminsen']);
  assert.equal(cfg.publish_hour, 10);
  assert.equal(weeklyConfig({}).enabled, false);
});

test('the summary check keeps cited lines with known numbers and drops the rest, with the reason', () => {
  const record = {routes: [{id: 350, title: 't', state: 'result', new: false, outcomes: ['result'], return_ids: [5390], evidence: ''}, {id: 362, title: 't', state: 'result', new: true, outcomes: ['proposed'], return_ids: [], evidence: ''}],
    documents: [{path: 'a.md', version: 3, return_id: 5401, summary: '', diff: '', diff_clipped: false}], papers: [{return_id: 5402, paper: 'p', path: null}], findings_resolved: []};
  const input = 'route 350 ... 37# census, 31# record, 7,952,175 residues. 8 paper revisions accepted; 5 findings resolved; 6 of them TeX.';
  const r = checkSummary([
    'Agents rebuilt the 37# census; it repeats the 31# record (route 350).',
    'Agents fixed 5 errors found by reviewers (return 5401 and 5402).',
    'It covers 7,952,175 residues (route 350).',
    'Something good happened.',
    'A new route opened (route 999).',
    'The bound improved to 4.2 (route 362).',
    'Three papers moved to TeX (return 5402).',
    'The conjecture is solved (route 350).',
    {text: 'Six of them moved to TeX (return 5402).'},
  ], input, record);
  assert.deepEqual(r.kept.map((l) => l.text), [
    'Agents rebuilt the 37# census; it repeats the 31# record (route 350).',
    'Agents fixed 5 errors found by reviewers (return 5401 and 5402).',
    'It covers 7,952,175 residues (route 350).',
    'Six of them moved to TeX (return 5402).',
  ]);
  assert.deepEqual(r.kept[1].returns, [5401, 5402]);
  assert.deepEqual(r.dropped.map((d) => d.why), ['cites no route or return', 'route 999 is not in the week\'s record', 'the number 4.2 is not in the week\'s record', 'the number "three" is not in the week\'s record', 'wording to check: "solved"']);
  // At most four lines are kept.
  const many = checkSummary(Array.from({length: 6}, () => 'Route 350 moved (route 350).'), input, record);
  assert.equal(many.kept.length, 4);
  assert.equal(many.dropped[0].why, 'more than 4 lines');
  assert.deepEqual(checkSummary('not a list', input, record).kept, []);
});

test('the Monday email carries the same lines, escaped, with the link to the whole week', async () => {
  const tpl = await import('../src/lib/email-template.ts');
  const html = tpl.researchSection({title: 'What moved on Twin Prime this week', lead: 'l', cards: [], rows: [], href: 'https://x/p', cta: 'See',
    weekly: {title: 'What moved, week of 22 to 28 Oct', lines: [LINES[0].text, 'a < b (route 1)'], href: 'https://solveathome.org/projects/twin-primes/weekly/2026-10-28'}});
  assert.ok(html.includes(LINES[0].text));
  assert.ok(html.includes('a &lt; b (route 1)'));
  assert.ok(html.includes('href="https://solveathome.org/projects/twin-primes/weekly/2026-10-28"'));
  assert.ok(!tpl.researchSection({title: 't', lead: 'l', cards: [], rows: [], href: 'h', cta: 'c'}).includes('The whole week'));
});
