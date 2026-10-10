import assert from 'node:assert/strict';
import {test} from 'node:test';

// Progress emails, the parts with no database (#sah-progress-emails): signed links, addresses, the lead, the merge, the news threshold,
// the weekly edition and the letters, streaks and the holdout.
process.env.EMAIL_LINK_SECRET = 'test-secret-for-links';
const E = await import('../src/lib/email.ts');
const U = await import('../src/lib/email-update.ts');

const item = (kind, extra = {}) => ({kind, score: U.SCORES[kind], news: !['letter', 'project'].includes(kind), problem_id: 1, facts: {}, happened_at: new Date().toISOString(), dedupe_key: `${kind}:${Math.random()}`, ...extra});
const daily = {updates: 'daily', newsletter: false, projects: false};
const stats = (activity7 = 0) => ({activity7});

test('signed links: an unsubscribe token names its person and action, and any change to it is refused', () => {
  const t = E.unsubToken(42, 'weekly');
  assert.deepEqual(E.readUnsub(t), {userId: 42, action: 'weekly'});
  const [payload, sig] = t.split('.');
  assert.equal(E.readUnsub(`${Buffer.from('u\n43\nweekly').toString('base64url')}.${sig}`), null);
  assert.equal(E.readUnsub(`${payload}.${'A'.repeat(32)}`), null);
  assert.equal(E.readUnsub('nonsense'), null);
  assert.equal(E.readUnsub(E.sign(['u', 42, 'delete-everything'])), null);
});

test('a confirmation link works for 48 hours and only as a confirmation', () => {
  const now = Date.now();
  const t = E.confirmToken(7, 'ada@example.org', now);
  assert.deepEqual(E.readConfirm(t, now + 47 * 3600_000), {userId: 7, email: 'ada@example.org'});
  assert.equal(E.readConfirm(t, now + 49 * 3600_000), null);
  assert.equal(E.readUnsub(t), null);
  assert.equal(E.readConfirm(E.unsubToken(7, 'all-off')), null);
});

test('addresses: GitHub\'s verified primary is offered, its noreply relay never is', () => {
  assert.equal(E.cleanEmail('  Ada@Example.ORG '), 'ada@example.org');
  assert.equal(E.cleanEmail('not an address'), null);
  assert.equal(E.cleanEmail('123+ada@users.noreply.github.com'), null);
  assert.equal(E.pickGithubEmail([{email: 'old@example.org', verified: true, primary: false}, {email: 'ada@example.org', verified: true, primary: true}]), 'ada@example.org');
  assert.equal(E.pickGithubEmail([{email: 'ada@example.org', verified: false, primary: true}]), null);
  assert.equal(E.pickGithubEmail([{email: '1+ada@users.noreply.github.com', verified: true, primary: true}]), null);
  assert.equal(E.pickGithubEmail({message: 'Bad credentials'}), null);
  assert.equal(E.cleanTz('Europe/Copenhagen'), 'Europe/Copenhagen');
  assert.equal(E.cleanTz('Mars/Olympus'), null);
});

test('the lead is the most exciting news; a question never leads unless it is the only news', () => {
  const accepted = item('accepted', {score: 86, facts: {return_id: 1, points: 60}});
  const record = item('record', {facts: {what: 'revision', path: 'a.md', version: 2, return_id: 9}});
  const ask = item('ask', {facts: {ask_id: 3}});
  const verdict = item('verdict', {facts: {return_id: 2, status: 'rejected'}});
  assert.equal(U.pickLead([verdict, ask, accepted, record]), record);
  assert.equal(U.pickLead([ask, verdict]), verdict);
  assert.equal(U.pickLead([ask]), ask);
  assert.equal(U.pickLead([item('letter')]), null);
  // Ties go to more points.
  const small = item('accepted', {score: 80, facts: {return_id: 4, points: 20}}), big = item('accepted', {score: 80, facts: {return_id: 5, points: 100}});
  assert.equal(U.pickLead([small, big]), big);
});

test('one line per return: a first acceptance swallows the acceptance of the same return and keeps its points', () => {
  const merged = U.mergeByReturn([item('accepted', {id: 1, facts: {return_id: 7, points: 60, type: 'break'}}), item('first', {id: 2, facts: {return_id: 7}}), item('cited', {id: 3, facts: {return_id: 8, by_return_id: 9}})]);
  assert.equal(merged.length, 2);
  const first = merged.find((m) => m.kind === 'first');
  assert.equal(first.facts.points, 60);
  assert.equal(first.facts.type, 'break');
  assert.deepEqual(first.merged.sort(), [1, 2]);
  // A reversal is reported once, as it stands now.
  const older = item('verdict', {facts: {return_id: 5, status: 'contested'}, happened_at: '2026-10-01T00:00:00Z'});
  const newer = item('verdict', {facts: {return_id: 5, status: 'rejected'}, happened_at: '2026-10-02T00:00:00Z'});
  assert.deepEqual(U.mergeByReturn([older, newer]).map((m) => m.facts.status), ['rejected']);
});

test('one accepted return citing several of your returns is one line, its points summed', () => {
  const cited = (id, rid, by) => item('cited', {id, facts: {return_id: rid, by_return_id: by, points: 15}});
  const merged = U.mergeByReturn([cited(1, 10, 99), cited(2, 11, 99), cited(3, 12, 99), cited(4, 13, 98)]);
  assert.equal(merged.length, 2);
  const many = merged.find((m) => m.facts.by_return_id === 99);
  assert.equal(many.facts.count, 3);
  assert.equal(many.facts.points, 45);
  assert.deepEqual(many.merged.sort(), [1, 2, 3]);
  const x = {slug: () => 'p', projectName: () => 'P', handleOfReturn: new Map([[99, '@ada'], [98, '@ada']]), asks: new Map()};
  assert.match(U.describe(many, x).head, /^@ada built on 3 of your returns \(\+45\)$/);
  assert.match(U.describe(merged.find((m) => m.facts.by_return_id === 98), x).head, /^@ada built on your work/);
});

test('no news, no email: stats and activity alone never send a daily update', () => {
  assert.equal(U.decide(daily, [], [], stats(9), 3), null);
  assert.equal(U.decide(daily, [item('letter')], [], stats(9), 3).edition, 'letter');
  assert.equal(U.decide(daily, [item('accepted', {facts: {return_id: 1}})], [], stats(0), 3).edition, 'daily');
  // A rank jump worked out at send time is news.
  assert.equal(U.decide(daily, [], [item('rank', {facts: {from: 9, to: 4}})], stats(0), 3).edition, 'daily');
});

test('Monday is the weekly edition for everyone; it also goes out for a week of activity with no news', () => {
  assert.equal(U.decide(daily, [], [], stats(4), 1).edition, 'weekly');
  assert.equal(U.decide(daily, [], [], stats(0), 1), null);
  const weekly = {...daily, updates: 'weekly'};
  assert.equal(U.decide(weekly, [item('accepted', {facts: {return_id: 1}})], [], stats(1), 4), null);   // weekly people wait for Monday
  assert.equal(U.decide(weekly, [item('accepted', {facts: {return_id: 1}})], [], stats(1), 1).edition, 'weekly');
});

test('updates off: only the letters the person ticked, alone', () => {
  const off = {updates: 'off', newsletter: true, projects: false};
  assert.equal(U.decide(off, [item('accepted', {facts: {return_id: 1}})], [], null, 1), null);
  const d = U.decide(off, [item('letter')], [], null, 1);
  assert.equal(d.edition, 'letter');
  assert.equal(d.items.length, 0);
  // With an update going out, the letter rides in it instead of a second email.
  const both = U.decide(daily, [item('letter'), item('accepted', {facts: {return_id: 1}})], [], stats(1), 3);
  assert.equal(both.edition, 'daily');
  assert.equal(both.letters.length, 1);
});

test('items worked out at send time: a rank jump of 3 or more, entering the top 10, the reviewer queue', () => {
  const s = (rank, queue = null) => ({project: {id: 1}, rank30: {rank}, queue});
  assert.deepEqual(U.composeTimeItems(5, s(12), s(15), '2026-10-03').map((i) => i.kind), ['rank']);
  assert.deepEqual(U.composeTimeItems(5, s(13), s(15), '2026-10-03'), []);
  assert.deepEqual(U.composeTimeItems(5, s(9), s(11), '2026-10-03').map((i) => i.facts.what ?? i.kind), ['top10']);
  assert.deepEqual(U.composeTimeItems(5, s(1), s(5), '2026-10-03').map((i) => i.facts.what ?? i.kind), ['first_place']);   // one line says the move
  assert.deepEqual(U.composeTimeItems(5, s(4, 10), s(4, 6), '2026-10-03').map((i) => i.kind), ['queue']);
  assert.deepEqual(U.composeTimeItems(5, s(4), null, '2026-10-03'), []);   // the first email compares with nothing
});

test('streaks count whole weeks with an accepted result, up to this week or the last', () => {
  const now = new Date('2026-10-07T12:00:00Z');   // a Wednesday
  assert.equal(U.streakOf(['2026-10-05', '2026-09-28', '2026-09-21'], now), 3);
  assert.equal(U.streakOf(['2026-09-28', '2026-09-21'], now), 2);   // nothing yet this week: last week still counts
  assert.equal(U.streakOf(['2026-09-21'], now), 0);
  assert.equal(U.streakOf([], now), 0);
});

test('the holdout is fixed per person, about the stated share, and ends on its date', () => {
  process.env.EMAIL_HOLDOUT_UNTIL = '2099-01-01';
  process.env.EMAIL_HOLDOUT_PERCENT = '10';
  const held = Array.from({length: 2000}, (_, i) => U.inHoldout(i + 1)).filter(Boolean).length;
  assert.ok(held > 140 && held < 260, `held ${held} of 2000`);
  assert.equal(U.inHoldout(77), U.inHoldout(77));
  process.env.EMAIL_HOLDOUT_UNTIL = '2000-01-01';
  assert.equal(Array.from({length: 200}, (_, i) => U.inHoldout(i + 1)).some(Boolean), false);
  delete process.env.EMAIL_HOLDOUT_UNTIL;
});

test('lines say what happened without hype: no "proof", nothing called accepted that was not', () => {
  const x = {slug: () => 'p', projectName: () => 'Twin Prime', handleOfReturn: new Map([[9, '@grace']]), asks: new Map([[3, {body_md: 'Which <b>machine</b>?', handle: 'ada', expires_at: '2026-10-09T00:00:00Z', return_id: 4}]])};
  const lines = ['accepted', 'first', 'breakthrough', 'cited', 'verdict', 'record', 'milestone', 'rank', 'queue', 'ask']
    .map((k) => U.describe(item(k, {facts: {return_id: 4, by_return_id: 9, status: k === 'verdict' ? 'rejected' : undefined, reason: 'overclaimed', what: k === 'record' ? 'revision' : undefined, path: 'notes/a.md', version: 3, points: 500, from: 9, to: 4, waiting: 7, ask_id: 3, type: 'break'}}), x));
  for (const l of lines) { assert.ok(l.head, JSON.stringify(l)); assert.doesNotMatch(`${l.head} ${l.why}`, /\bproof|proved|breakthrough!|amazing|incredible/i); assert.match(l.path, /^\//); }
  assert.match(lines[4].head, /^Not accepted/);
  assert.match(lines[3].head, /@grace built on your work/);
  assert.match(lines[9].head, /@ada asks: "Which <b>machine<\/b>\?"/);   // escaped by the renderer, which escapes every line
  const subj = U.subjectOf({edition: 'daily', lead: item('accepted', {facts: {return_id: 4, points: 60, type: 'break'}}), rest: [item('cited'), item('rank')], asks: [], stats: null, letters: []}, {...x, letters: new Map()});
  assert.equal(subj, 'Accepted: your agent\'s break (+60), and 2 more');
});

// Records on a record challenge (Chris, 10 Oct 2026): the comparison follows the track's direction, a tie is never "beyond", several
// records on one track are one line, and a record goes out on its own when the person's updates would not carry it today.
const higher = {id: 'hi', name: 'Hi', better: 'higher', max: 32, display: {name: 'Higher track'}};
const lower = {id: 'lo', name: 'Lo', better: 'lower'};
test('a record is compared with the published best in the track\'s own direction', () => {
  assert.equal(U.againstPublished(higher, 13, {value: 12, credit: 'Ref'}).beyond, true);
  assert.equal(U.againstPublished(higher, 12, {value: 12, credit: 'Ref'}).beyond, false);
  assert.equal(U.againstPublished(higher, 12, {value: 12, credit: 'Ref'}).level, true);
  assert.match(U.againstPublished(higher, 9, {value: 12, credit: 'Ref'}).text, /best published result we verified is 12 of 32, Ref: the next mark/);
  assert.equal(U.againstPublished(lower, 120, {value: 128, credit: 'Ref'}).beyond, true);
  assert.equal(U.againstPublished(lower, 130, {value: 128, credit: 'Ref'}).beyond, false);
  assert.match(U.againstPublished(lower, 120, {value: 128, credit: 'Ref'}).text, /beyond the best published result we verified \(128 bytes, Ref\)/);
  assert.equal(U.againstPublished(higher, 13, null).text, '');
  assert.match(U.recordFacts(higher, {value: 5, previous: null}, null).before, /first verified result on this track/);
  assert.match(U.recordFacts(higher, {value: 5, previous: null, count: 3}, null).before, /^3 records in a row, starting with the first verified result/);
  assert.match(U.recordFacts(higher, {value: 5, previous: 4}, '@ada').before, /^Up from 4 of 32, the platform best before it \(@ada\)/);
});

test('several records by one person on one track are one line, from the first best before them to the newest', () => {
  const rec = (sid, value, previous, challenge_id = 'hi') => item('challenge_record', {id: sid, facts: {submission_id: sid, challenge_id, value, previous}});
  const out = U.mergeRecords([rec(11, 7, 6), rec(10, 6, 5), rec(12, 3, 2, 'other'), item('accepted', {facts: {return_id: 1}})]);
  assert.equal(out.length, 3);
  const hi = out.find((i) => i.facts.challenge_id === 'hi');
  assert.deepEqual([hi.facts.value, hi.facts.previous, hi.facts.count, hi.facts.submission_id], [7, 5, 2, 11]);
  assert.deepEqual(hi.merged.sort(), [10, 11]);
  assert.equal(U.pickLead(out).kind, 'challenge_record', 'a record leads the email');
});

test('a record goes out the day it is set, alone, for weekly people and for people with updates off', () => {
  const rec = item('challenge_record', {facts: {submission_id: 1, challenge_id: 'hi', value: 3, previous: 2}});
  const verdict = item('verdict', {facts: {return_id: 9, status: 'rejected'}});
  assert.equal(U.decide(daily, [rec, verdict], [], stats(), 3).edition, 'daily');
  const weekly = U.decide({...daily, updates: 'weekly'}, [rec, verdict], [], stats(), 3);
  assert.equal(weekly.edition, 'record');
  assert.deepEqual(weekly.items.map((i) => i.kind), ['challenge_record'], 'the rest waits for Monday');
  assert.equal(U.decide({...daily, updates: 'weekly'}, [rec, verdict], [], stats(), 1).edition, 'weekly');
  assert.equal(U.decide({updates: 'off', newsletter: true, projects: false}, [rec], [], null, 3).edition, 'record');
});
