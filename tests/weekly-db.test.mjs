import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// The weekly progress post end to end (#sah-weekly-progress-build): the build on the Monday (once, from any number of passes), the
// numbers from SQL, the hold for the first two weeks and the owner's approval, the summary job's lease and the check on its lines,
// numbers only when the summary is late, one post per week (never a second), a correction that edits the message, the self-posting
// third week, and what the site and the email may show. Real Postgres (TEST_DATABASE_URL); a stubbed webhook; everything is deleted.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the weekly post tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const tag = `weekly-test-${Date.now().toString(36)}`;
const slug = tag;
const projectsDir = mkdtempSync(join(tmpdir(), 'weekly-projects-'));
process.env.PROJECTS_DIR = projectsDir;
mkdirSync(join(projectsDir, slug));
writeFileSync(join(projectsDir, slug, 'project.json'), JSON.stringify({slug, name: 'Weekly test', repo_url: 'https://example.org/r', listed: false,
  weekly: {enabled: true, since: '2026-10-26', exclude_handles: [`${tag}-own`], closing: 'Nothing here settles it.', approvals_required: 2}}));

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const W = await import('../src/lib/weekly.ts');
const env = {DISCORD_WEEKLY_WEBHOOK_URL: 'http://127.0.0.1:9/api/webhooks/1/t'};
const calls = [];
const fetchImpl = async (url, init) => { calls.push({url, method: init.method, body: JSON.parse(init.body)}); return {ok: true, status: 200, json: async () => ({id: String(9000 + calls.length)}), text: async () => ''}; };
let pid, own, alice, ret;
const at = (s) => new Date(s);

before(async () => {
  await migrate();
  pid = Number((await one(`INSERT INTO problems (slug, name, repo_url) VALUES ($1,'Weekly test','https://example.org/r') RETURNING id`, [slug])).id);
  own = Number((await one(`INSERT INTO users (github_id, handle) VALUES ($1,$2) RETURNING id`, [-Math.floor(Math.random() * 1e9), `${tag}-own`])).id);
  alice = Number((await one(`INSERT INTO users (github_id, handle) VALUES ($1,$2) RETURNING id`, [-Math.floor(Math.random() * 1e9), `${tag}-alice`])).id);
  // Week of 26 Oct to 1 Nov 2026 (Copenhagen): three sessions (two on the project's own account), one before the week.
  for (const [id, u, s, l] of [['a', own, '2026-10-20T10:00Z', '2026-10-27T10:00Z'], ['b', own, '2026-10-28T10:00Z', '2026-10-28T11:00Z'], ['c', alice, '2026-10-29T10:00Z', '2026-11-03T10:00Z'], ['d', alice, '2026-10-10T10:00Z', '2026-10-11T10:00Z']])
    await q(`INSERT INTO sessions (id, problem_id, user_id, started_at, last_seen) VALUES ($1,$2,$3,$4,$5)`, [`${tag}-${id}`, pid, u, s, l]);
  ret = Number((await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, final_rung, cpu_hours, tokens, created_at)
    VALUES ($1,'explore',$2,'m','p','r','t','accepted','measured',2.5,'{"input":1000,"output":500,"cache_read":99999}','2026-10-30T12:00Z') RETURNING id`, [pid, alice])).id);
  await q(`INSERT INTO credits (user_id, problem_id, kind, points, source_type, source_id, created_at) VALUES ($1,$2,'result',120,'return',$3,'2026-10-30T12:00Z'), ($4,$2,'result',900,'return',$3,'2026-10-30T12:00Z')`, [alice, pid, String(ret), own]);
  const route = Number((await one(`INSERT INTO research_routes (problem_id, origin_return_id, title, contribution_md, prior_art_md, uncertainty_md, state, created_at) VALUES ($1,$2,'A route','c','p','u','result','2026-10-30T12:00Z') RETURNING id`, [pid, ret])).id);
  await q(`INSERT INTO research_events (route_id, return_id, outcome, evidence_md, created_at) VALUES ($1,$2,'result','Checked 31# to 37#, 12 cells.','2026-10-30T12:00Z')`, [route, ret]);
});
after(async () => {
  await q(`DELETE FROM weekly_digests WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM research_events WHERE route_id IN (SELECT id FROM research_routes WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM research_routes WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM credits WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM sessions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [[own, alice]]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  for (const t of ['weekly_digests', 'returns', 'sessions', 'users', 'problems']) assert.equal(Number((await one(`SELECT count(*) AS n FROM ${t} WHERE ${t === 'users' ? `handle LIKE '${tag}%'` : t === 'problems' ? `slug = '${slug}'` : `problem_id = ${pid}`}`)).n), 0, `${t} residue`);
  await pool.end();
  rmSync(projectsDir, {recursive: true, force: true});
});

test('nothing is built before Monday 06:00 Copenhagen; at 06:00 the week is built once and held; numbers come from SQL', async () => {
  assert.deepEqual((await W.weeklyPass(slug, {now: at('2026-11-02T04:59Z'), env, fetchImpl})).built, []);   // 05:59 CET
  const r = await W.weeklyPass(slug, {now: at('2026-11-02T05:00Z'), env, fetchImpl});
  assert.equal(r.built.length, 1);
  assert.deepEqual((await W.weeklyPass(slug, {now: at('2026-11-02T05:01Z'), env, fetchImpl})).built, []);
  const d = await one(`SELECT *, to_char(week_start,'YYYY-MM-DD') s, to_char(week_end,'YYYY-MM-DD') e FROM weekly_digests WHERE problem_id = $1`, [pid]);
  assert.equal(d.s, '2026-10-26'); assert.equal(d.e, '2026-11-01');
  assert.equal(d.status, 'held'); assert.equal(d.needs_approval, true);
  assert.equal(new Date(d.publish_at).toISOString(), '2026-11-02T09:00:00.000Z');   // 10:00 CET
  const n = d.numbers;
  assert.equal(n.agents, 3); assert.equal(n.people, 2); assert.equal(n.sessions_before, 2); assert.equal(n.sessions_after, 4);
  assert.equal(n.returns, 1); assert.equal(n.accepted, 1); assert.deepEqual(n.by_rung, {measured: 1}); assert.equal(n.tokens, 1500); assert.equal(n.cpu_hours, 2.5);
  assert.deepEqual(n.top, [{handle: `${tag}-alice`, points: 120}]);   // the project's own account counts in the totals, not in the list
  assert.equal(n.routes.moved, 1); assert.equal(n.routes.new, 1); assert.equal(n.routes.result, 1);
  assert.match(d.text_md, /^\*\*Weekly test: week of 26 Oct to 1 Nov\*\*/);
  assert.match(d.text_md, /3 agents from 2 people worked on the problem\. The all-time count went from 2 to 4, up 100 %\./);
});

test('a held week is not shown, not emailed and not posted, even past its publish time', async () => {
  const r = await W.weeklyPass(slug, {now: at('2026-11-02T12:00Z'), env, fetchImpl});
  assert.deepEqual(r.posted, []); assert.equal(calls.length, 0);
  assert.equal(await W.emailWeek(pid, at('2026-11-02T12:00Z')), null);
});

test('the summary job: lease, lines checked (bad ones dropped with the reason), the post rendered again', async () => {
  assert.equal(await W.summaryWaiting(pid), 1);
  const l = await W.leaseSummary(pid); assert.ok(l);
  assert.equal(await W.leaseSummary(pid), null);   // one lease per week
  const route = (await one(`SELECT id FROM research_routes WHERE problem_id = $1`, [pid])).id;
  const res = await W.saveSummary(pid, Number(l.id), [`Agents checked 31# to 37#, 12 cells (route ${route}).`, 'Nothing cited here.', `It took 99 days (route ${route}).`], 'claude-test');
  assert.deepEqual(res.kept.map((x) => x.text), [`Agents checked 31# to 37#, 12 cells (route ${route}).`]);
  assert.deepEqual(res.dropped.map((x) => x.why), ['cites no route or return', 'the number 99 is not in the week\'s record']);
  const d = await one(`SELECT text_md, summary_status FROM weekly_digests WHERE id = $1`, [l.id]);
  assert.equal(d.summary_status, 'done');
  assert.match(d.text_md, /\*\*What moved\*\*\n- Agents checked 31# to 37#/);
  assert.deepEqual(await W.saveSummary(pid, Number(l.id), ['x'], 'm'), {error: 'the week\'s summary is done, not leased: lease it first'});
});

test('approved: posted once at the next pass, never again; a correction edits the message', async () => {
  const id = Number((await one(`SELECT id FROM weekly_digests WHERE problem_id = $1`, [pid])).id);
  assert.equal(await W.approveWeek(id, 'test'), true);
  assert.equal(await W.approveWeek(id, 'test'), false);
  const r = await W.weeklyPass(slug, {now: at('2026-11-02T13:00Z'), env, fetchImpl});
  assert.deepEqual(r.posted, [id]);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'POST'); assert.match(calls[0].url, /wait=true/); assert.deepEqual(calls[0].body.allowed_mentions, {parse: []});
  await W.weeklyPass(slug, {now: at('2026-11-02T13:01Z'), env, fetchImpl});
  assert.equal(calls.length, 1);
  assert.ok(await W.emailWeek(pid, at('2026-11-03T08:00Z')));
  const c = await W.correctWeek(id, 'fixed text', 'a wrong count', {env, fetchImpl});
  assert.deepEqual(c, {ok: true});
  assert.equal(calls.length, 2); assert.equal(calls[1].method, 'PATCH'); assert.match(calls[1].url, /\/messages\/9001$/);
  const d = await one(`SELECT text_md, corrections, status FROM weekly_digests WHERE id = $1`, [id]);
  assert.equal(d.text_md, 'fixed text'); assert.equal(d.corrections.length, 1); assert.equal(d.corrections[0].reason, 'a wrong count'); assert.equal(d.status, 'posted');
});

test('the second week is held too; after two approved posts the third posts by itself, numbers only if its summary is late', async () => {
  await W.weeklyPass(slug, {now: at('2026-11-09T06:00Z'), env, fetchImpl});
  const w2 = await one(`SELECT id, status FROM weekly_digests WHERE problem_id = $1 AND week_start = '2026-11-02'`, [pid]);
  assert.equal(w2.status, 'held');
  await W.approveWeek(Number(w2.id), 'test');
  await W.weeklyPass(slug, {now: at('2026-11-09T09:00Z'), env, fetchImpl});
  assert.equal(calls.length, 3);
  await W.weeklyPass(slug, {now: at('2026-11-16T06:00Z'), env, fetchImpl});
  const w3 = await one(`SELECT id, status, needs_approval FROM weekly_digests WHERE problem_id = $1 AND week_start = '2026-11-09'`, [pid]);
  assert.equal(w3.status, 'ready'); assert.equal(w3.needs_approval, false);
  assert.deepEqual((await W.weeklyPass(slug, {now: at('2026-11-16T08:59Z'), env, fetchImpl})).posted, []);   // 09:59 CET
  assert.deepEqual((await W.weeklyPass(slug, {now: at('2026-11-16T09:00Z'), env, fetchImpl})).posted, [Number(w3.id)]);
  assert.equal((await one(`SELECT summary_status FROM weekly_digests WHERE id = $1`, [w3.id])).summary_status, 'none');
  assert.doesNotMatch(calls.at(-1).body.content, /What moved/);
});

test('without the webhook a due week waits and says why', async () => {
  await W.weeklyPass(slug, {now: at('2026-11-23T06:00Z'), env: {}, fetchImpl});
  const r = await W.weeklyPass(slug, {now: at('2026-11-23T10:00Z'), env: {}, fetchImpl});
  assert.match(Object.values(r.waiting).join(' '), /webhook unset/);
});
