import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// Record emails against a real Postgres (Chris, 10 Oct 2026: "make sure we correctly highlight in emails if we broke a record. And make
// sure a person who broke a record is told if they have allowed any form of email"). Records come from real submissions to a test
// challenge project: a record is a strictly better value in the track's direction, never a tie, a duplicate, a published answer, a demo
// or a withdrawn submission. The breaker is told once, if any choice is on; other readers see it in the research section. Sending goes
// to a stub. Everything created is deleted.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the record email tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';
process.env.EMAIL_LINK_SECRET = 'email-records-test';
process.env.POSTMARK_SERVER_TOKEN = 'stub';
delete process.env.EMAIL_HOLDOUT_UNTIL;
delete process.env.EMAIL_ALLOWLIST;
const tag = `recmail-test-${Date.now().toString(36)}`;
const slug = tag;

// Self-match candidates by score, found here: the score is the common prefix of the 32 ASCII characters and their own MD5.
const score = (c) => { const d = createHash('md5').update(c, 'ascii').digest('hex'); let i = 0; while (i < 32 && c[i] === d[i]) i++; return i; };
const found = {};
for (let i = 0; Object.keys(found).length < 6 && i < 2e6; i++) {
  const c = createHash('md5').update(`${tag}:${i}`).digest('hex');
  const s = score(c), k = s === 2 ? (found.s2a ? (found.s2b ? (found.s2c ? null : 's2c') : 's2b') : 's2a') : s === 3 ? (found.s3a ? (found.s3b ? null : 's3b') : 's3a') : s === 1 ? (found.s1 ? null : 's1') : null;
  if (k) found[k] = c;
}
assert.equal(Object.keys(found).length, 6, 'test candidates found');

const projectsDir = mkdtempSync(join(tmpdir(), 'record-email-projects-'));
process.env.PROJECTS_DIR = projectsDir;
mkdirSync(join(projectsDir, slug));
const md5 = JSON.parse(readFileSync(new URL('../projects/md5/project.json', import.meta.url), 'utf8'));
const config = structuredClone(md5);
// The published best on the self-match track is set to 2 for the test, with a score-2 candidate as its answer: submitting it is refused,
// another score 2 matches it, and a 3 goes beyond it.
config.challenge.tracks[0].targets = [{value: 2, credit: 'Test Reference', source_url: 'https://example.org/ref', source_label: 'test', checked: '2026-10-10', since: '2026-10-10', inputs: {candidate: found.s2c}}];
config.challenge.tracks[2].targets = config.challenge.tracks[2].targets.map(({inputs, ...t}) => t);
writeFileSync(join(projectsDir, slug, 'project.json'), JSON.stringify({...config, slug, name: 'Record email test'}));

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const PM = await import('../src/lib/postmark.ts');
const E = await import('../src/lib/email.ts');
const U = await import('../src/lib/email-update.ts');
const C = await import('../src/lib/challenges.ts');
const {listProjectConfigs} = await import('../src/lib/projects.ts');

const sent = [];
PM.setTransport(async (body) => { sent.push(body); return new Response(JSON.stringify({ErrorCode: 0, MessageID: `m-${sent.length}`}), {status: 200}); });

const people = {};
let pid, withdrawnId;
const SELF = 'md5-mirror-ascii32-v1', ZERO = 'md5-zero-bytes1024-v1';
const mk = async (name, {address = true, confirmed = true, prefs = null} = {}) => {
  const handle = `${tag}-${name}`, email = address ? `${handle}@example.org` : null;
  const u = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at, email, email_source, email_confirmed_at) VALUES ($1,$2,$3,now(),$4,$5,$6) RETURNING id`,
    [930_000_000 + Math.floor(Math.random() * 1e8), handle, TERMS_VERSION, email, email ? 'github_verified' : null, email && confirmed ? new Date(Date.now() - 86400_000) : null]);
  people[name] = {id: Number(u.id), handle, email};
  if (prefs) await E.setPrefs(people[name].id, prefs, 'settings');
};
let n = 0;
const submit = (who, body) => C.submit({problemId: pid, slug, userId: people[who].id, sessionId: null, jobId: null, model: 'claude-opus-5-5'}, {idempotency_key: `${tag}-${n++}`, ...body});
const self = (who, candidate, extra = {}) => submit(who, {challenge_id: SELF, candidate, ...extra});
const itemsOf = (who) => q(`SELECT kind, facts FROM email_items WHERE user_id = $1 ORDER BY id`, [people[who].id]);
const wed = {weekday: 3, day: '2026-10-14'};

before(async () => {
  await migrate();
  await mk('daily');                                                                // the default: daily updates
  await mk('letteronly', {prefs: {updates: 'off', newsletter: true}});             // updates off, the letter on: any email allowed
  await mk('alloff', {prefs: {updates: 'off', newsletter: false, projects: false}});  // every choice off
  await mk('unconfirmed', {confirmed: false});
  await mk('noaddress', {address: false});
  await mk('reader');                                                               // works on the project, broke nothing
  await C.ensureChallengeProjects(listProjectConfigs().filter((c) => c.slug === slug), async () => {});
  pid = Number((await one(`SELECT id FROM problems WHERE slug = $1`, [slug])).id);
});

after(async () => {
  const ids = Object.values(people).map((p) => p.id);
  await q(`DELETE FROM email_items WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM email_outbox WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM email_consent_events WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM email_preferences WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM challenge_events WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM challenge_corrections WHERE submission_id IN (SELECT id FROM challenge_submissions WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM challenge_submissions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM credits WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM lanes WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM reputation WHERE user_id = ANY($1)`, [ids]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
  const left = await one(`SELECT (SELECT count(*) FROM users WHERE handle LIKE $1)::int + (SELECT count(*) FROM problems WHERE slug = $2)::int AS n`, [`${tag}%`, tag]);
  assert.equal(left.n, 0, 'test rows left behind');
  rmSync(projectsDir, {recursive: true, force: true});
  await pool.end();
});

test('only a strictly better live result is a record, and the breaker is queued only if they allow any email', async () => {
  const r1 = await self('daily', found.s1);                       // first on the track: a record with no best before it
  assert.equal(r1.body.site_record, true);
  const r2 = await self('letteronly', found.s2a);                 // 1 -> 2: level with the published 2
  assert.equal(r2.body.site_record, true);
  const tie = await self('daily', found.s2b);                     // a different 2: a tie, no record
  assert.equal(tie.body.site_record, false);
  await assert.rejects(self('daily', found.s2c), /published answer/);   // the published answer itself is refused
  const r3 = await self('alloff', found.s3a);                     // 2 -> 3: beyond the published 2, but every choice is off
  assert.equal(r3.body.site_record, true);
  assert.equal((await self('reader', found.s3b)).body.site_record, false);   // a tie at the top
  assert.equal((await self('daily', found.s3a)).body.duplicate, true);      // the same candidate again: priority stays with the first
  await self('daily', '0'.repeat(32), {demo: true});              // demo data is never a record anyone is told about
  // Unconfirmed and address-less people set records on the zero track; a withdrawn record is not news.
  await submit('unconfirmed', {challenge_id: ZERO, input_hex: '00'});
  await submit('noaddress', {challenge_id: ZERO, input_hex: '01'});
  const zeros = await q(`SELECT s.id, s.score FROM challenge_submissions s WHERE s.problem_id = $1 AND s.challenge_id = $2 ORDER BY id`, [pid, ZERO]);
  let withdrawn = null;
  for (let i = 0; i < 4096 && !withdrawn; i++) {
    const hex = Buffer.from(`${tag}-z${i}`).toString('hex'), d = createHash('md5').update(Buffer.from(hex, 'hex')).digest('hex');
    if (/^0+/.test(d) && d.match(/^0*/)[0].length > Math.max(...zeros.map((z) => z.score))) withdrawn = await submit('letteronly', {challenge_id: ZERO, input_hex: hex});
  }
  assert.equal(withdrawn.body.site_record, true);
  withdrawnId = withdrawn.body.submission_id;
  await q(`INSERT INTO challenge_corrections (submission_id, kind, note) VALUES ($1, 'void', 'record email test')`, [withdrawnId]);

  await U.scan(); await U.scan();   // a rescan adds nothing
  const mine = await itemsOf('daily');
  assert.deepEqual(mine.map((i) => [i.kind, i.facts.value, i.facts.previous]), [['challenge_record', 1, null]]);
  const lo = await itemsOf('letteronly');
  assert.deepEqual(lo.map((i) => [i.kind, i.facts.value, i.facts.previous, i.facts.target.value]), [['challenge_record', 2, 1, 2]]);
  assert.equal(Number(lo[0].facts.previous_submission_id), r1.body.submission_id);
  for (const who of ['alloff', 'unconfirmed', 'noaddress', 'reader']) assert.deepEqual(await itemsOf(who), [], `${who} is told nothing`);
});

test('the breaker with updates off gets a record email, once, naming the old and new value and the published best', async () => {
  const p = people.letteronly, before = sent.length;
  assert.equal(await U.deliver({id: p.id, email: p.email, ...wed}), 'sent');
  const m = sent[sent.length - 1];
  assert.equal(sent.length, before + 1);
  assert.equal(m.Subject, 'Your agent set a new record on Self-hash match: 2 of 32');
  assert.equal(m.Tag, 'record');
  assert.match(m.TextBody, new RegExp(`Up from 1 of 32, the platform best before it \\(@${people.daily.handle}\\)\\. It matches the best published result we verified \\(2 of 32, Test Reference\\)`));
  assert.match(m.TextBody, /submission #\d+, by your agent on claude-opus-5-5/);
  assert.match(m.TextBody, new RegExp(`/projects/${slug}/submissions/\\d+\\?e=\\d+`));
  assert.doesNotMatch(m.TextBody, /YOUR STATS|THE RESEARCH/, 'a record email is only the record');
  assert.match(m.HtmlBody, /New record/);
  assert.match(m.HtmlBody, /See the record/);
  assert.ok(m.Headers.some((h) => h.Name === 'List-Unsubscribe' && /\/email\/u\//.test(h.Value)));
  assert.equal(E.readUnsub(m.Headers.find((h) => h.Name === 'List-Unsubscribe').Value.match(/\/email\/u\/([^>]+)/)[1]).action, 'all-off');
  // Once: the same day is taken, and the next day there is nothing left to say.
  await U.scan();
  assert.equal(await U.deliver({id: p.id, email: p.email, ...wed}), 'nothing');
  assert.equal(await U.deliver({id: p.id, email: p.email, weekday: 4, day: '2026-10-15'}), 'nothing');
  assert.equal(sent.length, before + 1);
});

test('the daily breaker\'s update leads with the record; another reader sees the records highlighted in the research section', async () => {
  const before = sent.length;
  assert.equal(await U.deliver({id: people.daily.id, email: people.daily.email, ...wed}), 'sent');
  const own = sent[sent.length - 1];
  assert.match(own.Subject, /^Your agent set a new record on Self-hash match: 1 of 32/);
  assert.match(own.TextBody, /first verified result on this track, so it sets the platform best/);
  // The reader has news of their own (an accepted return) and works on the project.
  const rid = Number((await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'measure',$2,'claude-opus-5-5','anthropic','r','t','accepted') RETURNING id`, [pid, people.reader.id])).id);
  await q(`INSERT INTO return_decisions (return_id, status, provisional, by) VALUES ($1,'accepted',false,'trusted')`, [rid]);
  await q(`INSERT INTO credits (user_id, model, problem_id, kind, points, source_type, source_id, note) VALUES ($1,'claude-opus-5-5',$2,'result',10,'return',$3,'accepted')`, [people.reader.id, pid, String(rid)]);
  await U.scan();
  assert.equal(await U.deliver({id: people.reader.id, email: people.reader.email, ...wed}), 'sent');
  const m = sent[sent.length - 1];
  assert.equal(sent.length, before + 2);
  const research = m.TextBody.indexOf('THE RESEARCH');
  const recs = m.TextBody.slice(m.TextBody.indexOf('RECORDS BROKEN TODAY'), m.TextBody.indexOf('Accepted 1 ·'));
  assert.ok(m.TextBody.indexOf('RECORDS BROKEN TODAY') > research, 'records lead the research section, below the reader\'s own news');
  assert.match(recs, new RegExp(`Self-hash match: 3 of 32, up from 2 of 32\\. Set by @${people.alloff.handle} \\(claude-opus-5-5\\)\\. It goes beyond the best published result we verified \\(2 of 32, Test Reference\\)`));
  assert.match(recs, /Self-hash match: 2 of 32, up from 1 of 32\..*matches the best published result/);
  assert.doesNotMatch(recs, new RegExp(`/submissions/${withdrawnId}\\?`), 'the withdrawn record is not shown');
  assert.match(m.HtmlBody, /4 records broken today/);
  assert.match(m.HtmlBody, /Beyond published/);
});
