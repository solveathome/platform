import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';

// The contributor page's ledger resolves what a review credit judged whether the credit's source is a review job id or
// 'r<return id>' (a self-assigned review has no job). One such row took every profile down with a 500 on Sep 11 2026.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the ledger tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {root} = await import('../src/routes/board.ts');

const tag = `ledger-test-${Date.now().toString(36)}`;
let server, base, uid, pid, jobId, retId;

before(async () => {
  await migrate();
  uid = Number((await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [930_000_000 + Math.floor(Math.random() * 1e8), tag, TERMS_VERSION])).id);
  pid = Number((await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,$2,'https://example.org/r','open') RETURNING id`, [tag, 'Ledger test'])).id);
  retId = Number((await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'source',$2,'m','p','x','t','accepted') RETURNING id`, [pid, uid])).id);
  jobId = Number((await one(`INSERT INTO jobs (problem_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status, parent_return_id) VALUES ($1,'review','Review','b','main','{}',1,1,1,'accepted',$2) RETURNING id`, [pid, retId])).id);
  await q(`INSERT INTO credits (user_id, problem_id, kind, points, source_type, source_id, note) VALUES ($1,$2,'review',5,'review',$3,'by job'), ($1,$2,'tokens',0.5,'review',$4,'self-assigned'), ($1,$2,'result',15,'return',$5,'accepted')`, [uid, pid, String(jobId), `r${retId}`, String(retId)]);
  const app = express(); app.use(express.json()); app.use('/', root);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.close();
  await q(`DELETE FROM messages WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM credits WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM reputation WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM users WHERE id = $1`, [uid]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE id = $1) + (SELECT count(*) FROM credits WHERE user_id = $1) + (SELECT count(*) FROM problems WHERE id = $2) AS n`, [uid, pid]);
  await pool.end();
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

test('the profile JSON renders with a self-assigned review credit in the ledger, and names what each review judged', async () => {
  const r = await fetch(`${base}/@${tag}`, {headers: {accept: 'application/json'}});
  const t = await r.text(); assert.equal(r.status, 200, t);
  const j = JSON.parse(t);
  const byNote = Object.fromEntries(j.credit.ledger.map(c => [c.note, c]));
  assert.equal(Number(byNote['by job'].review_of), retId);
  assert.equal(Number(byNote['self-assigned'].review_of), retId);
  assert.equal(byNote['accepted'].review_of, null);
  assert.equal(j.credit.total, 20.5);
});

test('profiles distinguish submissions awaiting review, missing transcript usage, and work released without a result', async () => {
  await q(`INSERT INTO returns (problem_id,type,user_id,model,provider,report_md,transcript,status,tokens) VALUES
    ($1,'audit',$2,'gemini-3.8-flash','google','audit','t','pending','{"log":"antigravity","source":"none"}'),
    ($1,'explore',$2,'gemini-3.8-flash','google','explore','t','recorded','{"log":"antigravity","source":"reported","input":100}'),
    ($1,'explore',$2,'deepseek-v4.1-flash','deepseek','explore','t','recorded','{"log":"custom","source":"none"}'),
    ($1,'explore',$2,'deepseek-v4.1-flash','deepseek','explore','t','recorded','{"log":"custom","source":"reported","input":100}'),
    ($1,'explore',$2,'deepseek-v4.1-flash','deepseek','explore','t','recorded','{"log":"custom","source":"none","already_counted":{"entries":1}}'),
    ($1,'explore',$2,'deepseek-v4.1-flash','deepseek','explore','t','recorded','{"log":"custom","source":"none","mismatch":{"reason":"another assignment"}}')`, [pid, uid]);
  const channel = await one(`INSERT INTO channels (problem_id,path,title) VALUES ($1,'','Project') RETURNING id`, [pid]);
  const repair = await one(`INSERT INTO jobs (problem_id,type,title,brief_md,follow_up_of) VALUES ($1,'measure','Fix files of return #1','Repair it',$2) RETURNING id`, [pid, retId]);
  await q(`INSERT INTO messages (channel_id,user_id,kind,body_md,job_id) VALUES ($1,$2,'done',$3,$4)`, [channel.id, uid, `Released job #${repair.id} back to the queue: Uploaded the repaired file but could not submit.`, repair.id]);
  const r = await fetch(`${base}/@${tag}`, {headers: {accept: 'application/json'}});
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
  assert.deepEqual(j.work, {submitted: 7, awaiting_review: 1, recorded: 5, usage_missing: 2});
  assert.equal(j.released.length, 1); assert.equal(Number(j.released[0].job_id), Number(repair.id));
  assert.match(j.released[0].note, /could not submit/);
  assert.equal(j.credit.total, 20.5, 'activity is not fabricated credit');
});

test('the profile carries standing, credit per day, rungs, work by kind, reviews given and titled recent results (Sep 15 2026)', async () => {
  await q(`UPDATE returns SET final_rung = 'measured', verification = 'rerun' WHERE id = $1`, [retId]);
  const r = await fetch(`${base}/@${tag}`, {headers: {accept: 'application/json'}});
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
  assert.ok(Number(j.standing.rank) >= 1 && Number(j.standing.contributors) >= Number(j.standing.rank), 'rank within the contributor count');
  assert.equal(Number(j.standing.points), 20.5);
  assert.equal(j.credit.by_day.length, 1); assert.match(j.credit.by_day[0].day, /^\d{4}-\d{2}-\d{2}$/, 'a calendar day, not a timestamp shifted by the server zone'); assert.equal(Number(j.credit.by_day[0].cumulative), 20.5);
  assert.equal(j.credit.count_by_kind.review, 1);
  assert.deepEqual(j.rungs.accepted, {measured: 1});
  assert.ok(Number(j.rungs.contributors_reached.measured) >= 1);
  const source = j.kinds.find(k => k.type === 'source');
  assert.equal(source.accepted, 1); assert.deepEqual(source.rungs, {measured: 1}); assert.deepEqual(source.verification, {rerun: 1});
  assert.equal(j.reviews_given.total, 0);
  assert.equal(j.days.reduce((s, x) => s + x.submitted, 0), 7);
  assert.equal(j.highlights_kind, 'strongest'); assert.equal(Number(j.highlights[0].id), retId); assert.equal(j.highlights[0].title, 'x');
  assert.equal(j.recent.find(x => Number(x.id) === retId).title, 'x');
  assert.deepEqual(j.integrated_paths, []); assert.equal(j.cited.count, 0);
  // Pending points (Chris, Sep 15 2026): what the work awaiting review is worth if it gets in, by the board's own definition,
  // base result points and no bonuses. A contributor whose returns are queued has earned nothing yet and is not idle.
  const before = Number(j.standing.pending_points);
  assert.ok(Number.isFinite(before), 'pending points are a number');
  await q(`INSERT INTO returns (problem_id,type,user_id,model,provider,report_md,transcript,status) VALUES ($1,'measure',$2,'m','p','x','t','pending')`, [pid, uid]);
  const queued = await (await fetch(`${base}/@${tag}`, {headers: {accept: 'application/json'}})).json();
  assert.ok(Number(queued.standing.pending_points) > before, `another pending return is worth more: ${before} -> ${queued.standing.pending_points}`);
  assert.equal(Number(queued.standing.points), Number(j.standing.points), 'and none of it is added to the awarded total');
});
