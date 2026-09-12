import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import express from 'express';

// Registration from the instruction URL (Chris, Sep 12 2026): the person chooses the configuration on the site, it rides as query
// arguments, and the agent's first GET /start registers the session and returns the brief. The agent asks its person nothing.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the URL registration tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';
const tmp = mkdtempSync(join(tmpdir(), 'sah-url-')); process.env.FILES_DIR = join(tmp, 'files'); process.env.OVERLAY_DIR = join(tmp, 'overlay'); process.env.DOCS_DIR = join(tmp, 'repos');

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job} = await import('../src/routes/job.ts');

const tag = `url-test-${Date.now().toString(36)}`;
const slug = tag, handle = `${tag}-person`;
let server, base, uid, pid, token, laneId;
const mkJob = (type, title, hint, minTier = 99) => one(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status) VALUES ($1,$2,$3,$4,'do it','main',$5,1,$6,1,'queued') RETURNING id`, [pid, laneId, type, title, JSON.stringify(hint), minTier]);
let plainIds = [], heavyId, mathlibId;

before(async () => {
  await migrate();
  const u = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), handle, TERMS_VERSION]);
  uid = Number(u.id); token = await issueToken(uid, 'url-test');
  pid = Number((await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,$2,'https://example.org/r','open') RETURNING id`, [slug, 'URL registration test'])).id);
  await one(`INSERT INTO channels (problem_id, path, title) VALUES ($1,'','Project') RETURNING id`, [pid]);
  laneId = Number((await one(`INSERT INTO lanes (problem_id, slug, title, status) VALUES ($1,'lane-u','Lane U','open') RETURNING id`, [pid])).id);
  await one(`INSERT INTO channels (problem_id, lane_id, parent_id, path, title) VALUES ($1,$2,(SELECT id FROM channels WHERE problem_id = $1 AND path = ''),'lane-u','Lane U') RETURNING id`, [pid, laneId]);
  for (let i = 0; i < 6; i++) plainIds.push(Number((await mkJob('source', `Source ${i}`, {})).id));
  heavyId = Number((await mkJob('measure', 'Heavy measure', {ram_gb: 16, cpu_hours: 3})).id);
  mathlibId = Number((await mkJob('formalize', 'Formalize with Mathlib', {ram_gb: 8, cpu_hours: 1, mathlib_cache: true})).id);
  const app = express(); app.use(express.json()); app.use('/projects/:slug', job);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/projects/${slug}`;
});
after(async () => {
  server?.close();
  await q(`DELETE FROM messages WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM channel_members WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM credits WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM reviews WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM jobs WHERE parent_return_id IN (SELECT id FROM returns WHERE problem_id = $1)`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM sessions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM pool WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM lanes WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM tokens WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM reputation WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM users WHERE id = $1`, [uid]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE id = $1) + (SELECT count(*) FROM problems WHERE id = $2) + (SELECT count(*) FROM sessions WHERE problem_id = $2) + (SELECT count(*) FROM jobs WHERE problem_id = $2) AS n`, [uid, pid]);
  await pool.end(); rmSync(tmp, {recursive: true, force: true});
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const get = (qs = '', {session, model = 'claude-opus-5'} = {}) => fetch(base + '/start' + qs, {headers: {authorization: `Bearer ${token}`, accept: 'application/json', ...(model ? {'x-model': model, 'x-effort': 'high'} : {}), ...(session ? {'x-session': session} : {})}});
const end = (session) => fetch(base + `/sessions/${session}/end`, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-model': 'claude-opus-5'}, body: JSON.stringify({note: 'test'})});
const sessions = () => one(`SELECT count(*) AS c FROM sessions WHERE problem_id = $1`, [pid]).then(r => Number(r.c));
const NO_QUESTIONS = /ask (your|the) person|AskUserQuestion|Before you start: your person|Same as last time|show your person the terms|How to ask/i;

test('a bare GET /start with a model registers with the defaults and returns the brief; nothing asks the person', async () => {
  const r = await get(); const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j).slice(0, 300));
  assert.ok(j.session && j.job_id, 'session and first assignment');
  assert.match(j.brief_md, /## Registered for this session/);
  assert.match(j.brief_md, /There is nothing to ask them/);
  assert.match(j.brief_md, /until your person stops you/);
  assert.match(j.brief_md, /75% of the machine it runs on/);
  assert.doesNotMatch(j.brief_md, NO_QUESTIONS);
  const s = await one(`SELECT * FROM sessions WHERE id = $1`, [j.session]);
  assert.equal(s.registered_via, 'url'); assert.equal(s.max_jobs, null); assert.equal(s.ends_at, null);
  assert.equal(s.compute.share, 0.75); assert.equal(s.compute.disk_gb, 5); assert.equal(s.compute.usable.ram_gb, 16);
  assert.equal(s.ai.transcript_preapproved, true); assert.equal(s.ai.subagents.allowed, true);
  assert.equal(Number(j.job_id), heavyId, 'at 75% the 16 GB job fits and comes first for a tier-2 model');
  await end(j.session);
});

test('share and disk decide what fits: 25% never gets the 16 GB job, Mathlib needs disk 10', async () => {
  const small = await (await get('?share=25')).json();
  assert.notEqual(Number(small.job_id), heavyId); assert.notEqual(Number(small.job_id), mathlibId);
  assert.match(small.brief_md, /25% of the machine it runs on/);
  await end(small.session);
  const mid = await (await get('?share=50')).json();
  assert.notEqual(Number(mid.job_id), mathlibId, 'disk 5 keeps the Mathlib job out');
  await end(mid.session);
  const lean = await (await get('?share=50&disk=10')).json();
  assert.equal(Number(lean.job_id), mathlibId, JSON.stringify(lean).slice(0, 200));
  assert.match(lean.brief_md, /disk up to 10 GB/);
  await end(lean.session);
  const none = await (await get('?share=0')).json();
  assert.ok(plainIds.includes(Number(none.job_id)), 'share 0 gets work that needs no computation');
  assert.match(none.brief_md, /compute not offered/);
  await end(none.session);
});

test('a wrong value is a 400 that names the valid ones, and no session is opened', async () => {
  const before = await sessions();
  const r = await get('?share=30'); const j = await r.json();
  assert.equal(r.status, 400); assert.match(j.error, /share must be one of 0, 25, 50, 75, 100/); assert.deepEqual(j.valid.time, ['continuous', '4h', '2h', '1task']);
  const t = await get('?time=3h'); assert.equal(t.status, 400); assert.match((await t.json()).error, /time must be one of/);
  assert.equal(await sessions(), before);
});

test('without X-Model the fetch gets the page, not a session; the page points at the site', async () => {
  const before = await sessions();
  const r = await get('', {model: null}); const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.session, null);
  assert.match(j.orientation_md, /#contribute/); assert.match(j.orientation_md, /Arguments, only what differs from the default travels/);
  assert.doesNotMatch(j.orientation_md, NO_QUESTIONS);
  assert.doesNotMatch(j.orientation_md, /been here before/);
  assert.equal(await sessions(), before);
});

test('a fresh paste on the same model is a second agent: both sessions live, the first keeps its assignment', async () => {
  const first = await (await get()).json();
  const second = await (await get()).json();
  assert.ok(second.session && second.session !== first.session, 'a second session');
  assert.notEqual(Number(second.job_id), Number(first.job_id), 'a different assignment');
  assert.equal((await one(`SELECT ended_at FROM sessions WHERE id = $1`, [first.session])).ended_at, null, 'the first session is untouched');
  assert.equal((await one(`SELECT assigned_session FROM jobs WHERE id = $1`, [first.job_id])).assigned_session, first.session);
  assert.match(first.brief_md, /makes no request for 120 minutes is treated as stopped/);
  await end(first.session); await end(second.session);
});

test('a session silent beyond the abandonment window while holding a job is ended by the sweep and the job returns', async () => {
  const gone = await (await get()).json();
  await q(`UPDATE sessions SET last_seen = now() - interval '3 hours' WHERE id = $1`, [gone.session]);
  const other = await (await get()).json();   // any /start runs the sweep first
  assert.ok((await one(`SELECT ended_at FROM sessions WHERE id = $1`, [gone.session])).ended_at, 'the silent session is ended');
  const job = await one(`SELECT status, assigned_session, last_release_note FROM jobs WHERE id = $1`, [gone.job_id]);
  assert.ok(job.status === 'queued' || job.assigned_session === other.session, `job is ${job.status} held by ${job.assigned_session}`);
  assert.match(String(job.last_release_note ?? ''), /abandoned: no request from the agent for 120 minutes/);
  await end(other.session);
});

test('time=2h ends the session two hours after registration; the next /start says so', async () => {
  const j = await (await get('?time=2h')).json();
  const s = await one(`SELECT started_at, ends_at FROM sessions WHERE id = $1`, [j.session]);
  const hours = (new Date(s.ends_at) - new Date(s.started_at)) / 36e5;
  assert.ok(Math.abs(hours - 2) < 0.01, `ends_at is ${hours} h after start`);
  assert.match(j.brief_md, /2 hours from registration/);
  await fetch(base + '/release', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-model': 'claude-opus-5', 'x-session': j.session}, body: JSON.stringify({job_id: j.job_id, note: 'test'})});
  await q(`UPDATE sessions SET ends_at = now() - interval '1 minute' WHERE id = $1`, [j.session]);
  const r = await get('', {session: j.session}); const t = await r.json();
  assert.equal(r.status, 409); assert.equal(t.error, 'session length reached'); assert.match(t.orientation_md, /that time is up/);
  assert.ok((await one(`SELECT ended_at FROM sessions WHERE id = $1`, [j.session])).ended_at, 'the session is ended');
  const list = await (await fetch(base + '/sessions', {headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'x-model': 'claude-opus-5'}})).json();
  assert.ok(list.sessions.find(x => x.id === j.session).ends_at, 'GET /sessions reports ends_at');
});

test('time=1task caps at one assignment; subagents=no reaches the brief', async () => {
  const j = await (await get('?time=1task&subagents=no')).json();
  const s = await one(`SELECT max_jobs, ai FROM sessions WHERE id = $1`, [j.session]);
  assert.equal(s.max_jobs, 1); assert.equal(s.ai.subagents.allowed, false);
  assert.match(j.brief_md, /one assignment/); assert.match(j.brief_md, /sub-agents not allowed/); assert.match(j.brief_md, /Your person asked for a single agent/);
  await fetch(base + '/release', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-model': 'claude-opus-5', 'x-session': j.session}, body: JSON.stringify({job_id: j.job_id, note: 'test'})});
  const r = await get('', {session: j.session}); const t = await r.json();
  assert.equal(r.status, 409); assert.equal(t.error, 'session cap reached'); assert.match(t.orientation_md, /A new instruction from them starts a new session/); assert.doesNotMatch(t.orientation_md, /continue only if they say so/);
});

test('an ended session\'s page says a new instruction starts a new session, not "post the full body"', async () => {
  const j = await (await get('?time=2h')).json();
  await end(j.session);
  const r = await get('', {session: j.session}); const t = await r.json();
  assert.equal(r.status, 409); assert.equal(t.error, 'session ended');
  assert.match(t.orientation_md, /A new instruction from them starts a new session/); assert.doesNotMatch(t.orientation_md, /full body|agreed/);
});

test('directions=1 makes the person\'s directions the first assignment', async () => {
  const j = await (await get('?directions=1')).json();
  assert.equal(j.type, 'direction', JSON.stringify(j).slice(0, 200));
  assert.match(j.brief_md, /quote them verbatim in human_md/);
  assert.match(j.brief_md, /Their directions are your first assignment/);
  await end(j.session);
});

test('a posted registration body still works for agents mid-flight and is marked as such', async () => {
  const r = await fetch(base + '/start', {method: 'POST', headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', 'x-model': 'claude-opus-5'}, body: JSON.stringify({agreed: true, ai: {max_assignments: 1}, transcript_preapproved: true})});
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j).slice(0, 200));
  assert.equal((await one(`SELECT registered_via FROM sessions WHERE id = $1`, [j.session])).registered_via, 'body');
  await end(j.session);
});

test('the transcript\'s recorded thinking level corrects a wrong declaration and the session\'s tier', async () => {
  const reg = await fetch(base + '/start?share=0', {headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'x-model': 'claude-fable-5-1', 'x-effort': 'medium'}});
  const j = await reg.json(); assert.equal(reg.status, 200, JSON.stringify(j).slice(0, 300));
  assert.match(j.brief_md, /You declared `medium`: tier 2 this session/);
  assert.match(j.brief_md, /grep -o '"effort":"\[a-z\]\*"'/);
  const transcript = [
    JSON.stringify({type: 'user', message: {content: 'go'}}),
    JSON.stringify({type: 'assistant', effort: 'high', message: {model: 'claude-fable-5-1', usage: {input_tokens: 10, output_tokens: 5}}}),
  ].join('\n');
  const r = await fetch(base + '/result', {method: 'POST', headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', 'x-model': 'claude-fable-5-1', 'x-effort': 'medium', 'x-session': j.session}, body: JSON.stringify({job_id: j.job_id, report_md: 'Found the page.', transcript, transcript_approved: true, author_rung: 'measured'})});
  const t = await r.json(); assert.equal(r.status, 200, JSON.stringify(t).slice(0, 300));
  assert.ok(t.warnings.some(w => /records thinking level "high".*declared X-Effort "medium"/.test(w)), JSON.stringify(t.warnings));
  const s = await one(`SELECT effort, effort_evidence FROM sessions WHERE id = $1`, [j.session]);
  assert.equal(s.effort_evidence, 'high'); assert.equal(s.effort, 'high');
  assert.equal((await one(`SELECT effort FROM returns WHERE id = $1`, [t.return_id])).effort, 'high');
  const list = await (await fetch(base + '/sessions', {headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'x-model': 'claude-fable-5-1'}})).json();
  assert.equal(list.sessions.find(x => x.id === j.session).effort_evidence, 'high');
  const next = await (await fetch(base + '/start', {headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'x-model': 'claude-fable-5-1', 'x-effort': 'medium', 'x-session': j.session}})).json();
  assert.doesNotMatch(next.brief_md ?? next.orientation_md ?? '', /tier 2 for this session/);
  await end(j.session);
});


test('a summary in place of the transcript is accepted with a warning and no tokens; the real log can be resubmitted and corrects the record', async () => {
  const reg = await fetch(base + '/start?share=0', {headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'x-model': 'claude-fable-5-1', 'x-effort': 'high'}});
  const j = await reg.json(); assert.equal(reg.status, 200, JSON.stringify(j).slice(0, 300));
  assert.match(j.brief_md, /Copilot CLI keeps `events\.jsonl`/);
  assert.match(j.brief_md, /A summary is accepted and stays on the record, but it is recorded as "not a session log"/);
  const summary = [
    JSON.stringify({type: 'activity_summary', notice: 'Task-specific activity summary, not a native conversation transcript.'}),
    JSON.stringify({type: 'activity_summary', action: 'Read the page.'}),
    JSON.stringify({type: 'activity_summary', action: 'Wrote the report.'}),
  ].join('\n');
  const H = {authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', 'x-model': 'claude-fable-5-1', 'x-effort': 'high', 'x-session': j.session};
  const r = await fetch(base + '/result', {method: 'POST', headers: H, body: JSON.stringify({job_id: j.job_id, report_md: 'Found the page.', transcript: summary, transcript_approved: true, author_rung: 'measured'})});
  const t = await r.json(); assert.equal(r.status, 200, JSON.stringify(t).slice(0, 300));
  assert.equal(t.tokens.log, 'summary'); assert.equal(t.tokens.source, 'none');
  const w = t.warnings.find(x => /not a session log: it reads as a summary you wrote/.test(x)); assert.ok(w, JSON.stringify(t.warnings));
  assert.match(w, /credited nothing for the tokens/); assert.match(w, new RegExp(`POST .*/return/${t.return_id}/transcript`)); assert.match(w, /session-state\/<session-id>\/events\.jsonl/);
  const page = await (await fetch(base + `/return/${t.return_id}`, {headers: {accept: 'text/html'}})).text();
  assert.match(page, /not a session log/);
  // Someone else's handle cannot resubmit.
  const other = await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), `${tag}-other`, TERMS_VERSION]);
  const otherToken = await issueToken(Number(other.id), 'url-test');
  const forbidden = await fetch(base + `/return/${t.return_id}/transcript`, {method: 'POST', headers: {...H, authorization: `Bearer ${otherToken}`}, body: JSON.stringify({transcript: summary})});
  assert.equal(forbidden.status, 403);
  // Another summary is refused; the real log is taken and corrects tokens, effort and the record.
  const again = await fetch(base + `/return/${t.return_id}/transcript`, {method: 'POST', headers: H, body: JSON.stringify({transcript: summary})});
  assert.equal(again.status, 400); assert.match((await again.json()).error, /still not a session log \(summary\)/);
  const log = [
    JSON.stringify({type: 'user', message: {content: 'go'}}),
    JSON.stringify({type: 'assistant', effort: 'high', message: {id: 'm1', model: 'claude-fable-5-1', usage: {input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 40, cache_creation_input_tokens: 0}}}),
  ].join('\n');
  const wrongModel = await fetch(base + `/return/${t.return_id}/transcript`, {method: 'POST', headers: H, body: JSON.stringify({transcript: log.replace('claude-fable-5-1', 'claude-opus-5')})});
  assert.equal(wrongModel.status, 400); assert.match((await wrongModel.json()).error, /records claude-opus-5 but return #\d+ is on the record as claude-fable-5-1/);
  // The agent-written solveathome format is accepted too and labelled as such.
  const custom = [JSON.stringify({type: 'solveathome.transcript', version: 1, harness: 'x', model: 'claude-fable-5-1'}), JSON.stringify({type: 'solveathome.turn', role: 'assistant', content: 'read', usage: {input: 10, output: 2}})].join('\n');
  const cu = await fetch(base + `/return/${t.return_id}/transcript`, {method: 'POST', headers: H, body: JSON.stringify({transcript: custom})});
  const c = await cu.json(); assert.equal(cu.status, 200, JSON.stringify(c).slice(0, 300)); assert.equal(c.log, 'custom'); assert.equal(c.tokens.input, 10);
  assert.match(await (await fetch(base + `/return/${t.return_id}`, {headers: {accept: 'text/html'}})).text(), /agent-written in the solveathome format/);
  const ok = await fetch(base + `/return/${t.return_id}/transcript`, {method: 'POST', headers: H, body: JSON.stringify({transcript: log})});
  const o = await ok.json(); assert.equal(ok.status, 200, JSON.stringify(o).slice(0, 300));
  assert.equal(o.log, 'claude-code'); assert.equal(o.tokens.input, 1200); assert.equal(o.tokens.output, 300); assert.equal(o.tokens.cache_read, 40);
  const row = await one(`SELECT tokens, transcript, transcript_resubmitted_at, effort FROM returns WHERE id = $1`, [t.return_id]);
  assert.equal(row.tokens.log, 'claude-code'); assert.equal(row.transcript, log); assert.ok(row.transcript_resubmitted_at); assert.equal(row.effort, 'high');
  const page2 = await (await fetch(base + `/return/${t.return_id}`, {headers: {accept: 'text/html'}})).text();
  assert.doesNotMatch(page2, /not a session log/); assert.match(page2, /resubmitted \d{4}-\d{2}-\d{2}/);
  await end(j.session);
});

test('a log from an unknown harness is accepted, the agent is told its system is not supported yet with a report number, and the shape is recorded once', async () => {
  const reg = await fetch(base + '/start?share=0', {headers: {authorization: `Bearer ${token}`, accept: 'application/json', 'x-model': 'claude-fable-5-1', 'x-effort': 'high'}});
  const j = await reg.json(); assert.equal(reg.status, 200, JSON.stringify(j).slice(0, 300));
  const H = {authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', 'x-model': 'claude-fable-5-1', 'x-effort': 'high', 'x-session': j.session};
  const key = `k_${tag.replace(/-/g, '_')}`;   // a key name unique to this run, so the shape (and its report) is this test's own
  const odd = (n) => [1, 2, 3, 4].map(i => JSON.stringify({[key]: 1, event: 'turn', seq: i * n, who: i % 2 ? 'agent' : 'tool', body: `step ${i}`})).join('\n');
  const r = await fetch(base + '/result', {method: 'POST', headers: H, body: JSON.stringify({job_id: j.job_id, report_md: 'Found the page.', transcript: odd(1), transcript_approved: true, author_rung: 'measured'})});
  const t = await r.json(); assert.equal(r.status, 200, JSON.stringify(t).slice(0, 300));
  assert.equal(t.tokens.log, 'unknown');
  const w = t.warnings.find(x => /your harness is not supported yet/.test(x)); assert.ok(w, JSON.stringify(t.warnings));
  const id = Number(w.match(/harness report #(\d+)/)[1]); assert.ok(id > 0); assert.match(w, /as soon as a person has looked at it/);
  try {
  const list = await (await fetch(base + '/harness-reports', {headers: {accept: 'application/json'}})).json();
  const rep = list.reports.find(x => x.id === id); assert.ok(rep, JSON.stringify(list).slice(0, 300));
  assert.equal(rep.count, 1); assert.equal(rep.first_return_id, t.return_id); assert.equal(rep.signature, `body,event,${key},seq,who`); assert.match(rep.head, /"event":"turn"/);
  // The same shape again, from a resubmit attempt, counts on the same report and is refused as unsupported.
  const again = await fetch(base + `/return/${t.return_id}/transcript`, {method: 'POST', headers: H, body: JSON.stringify({transcript: odd(7)})});
  const a = await again.json(); assert.equal(again.status, 400); assert.match(a.error, /not supported yet \(harness report #/); assert.equal(a.harness_report, id);
  const list2 = await (await fetch(base + '/harness-reports', {headers: {accept: 'application/json'}})).json();
  assert.equal(list2.reports.find(x => x.id === id).count, 2);
  } finally { await q(`DELETE FROM harness_reports WHERE id = $1`, [id]); }
  await end(j.session);
});
