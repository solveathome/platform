// Summary or full transcript at intake (Chris, Oct 10 2026): a summary return goes through with its reported usage, shows its mode,
// reaches its reviewer as the person's choice, and a full log already published can be replaced by a summary keeping its count.
import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import express from 'express';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const tmp = mkdtempSync(join(tmpdir(), 'sah-transcript-mode-'));
process.env.PROJECTS_DIR = join(tmp, 'projects');
process.env.DOCS_DIR = join(tmp, 'repos');
process.env.FILES_DIR = join(tmp, 'files');
process.env.OVERLAY_DIR = join(tmp, 'overlay');
const {migrate, one, q, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job} = await import('../src/routes/job.ts');
const slug = `transcript-mode-${Date.now().toString(36)}`;
let uid, pid, token, server, base;

before(async () => {
  await migrate();
  uid = Number((await one(`INSERT INTO users(github_id,handle,terms_version,terms_accepted_at) VALUES($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random()*1e8), slug, TERMS_VERSION])).id);
  token = await issueToken(uid);
  pid = Number((await one(`INSERT INTO problems(slug,name,repo_url,status_md,discovery_share) VALUES($1,'Transcript mode fixture','https://example.org/r','open',0) RETURNING id`, [slug])).id);
  await q(`INSERT INTO channels(problem_id,path,title) VALUES($1,'','Project')`, [pid]);
  mkdirSync(join(process.env.PROJECTS_DIR, slug), {recursive:true});
  writeFileSync(join(process.env.PROJECTS_DIR, slug, 'project.json'), JSON.stringify({slug}));
  const app=express(); app.use(express.json({limit:'5mb'})); app.use('/projects/:slug',job);
  server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  base=`http://127.0.0.1:${server.address().port}/projects/${slug}`;
});
after(async () => {
  await new Promise(r=>server.close(r));
  await q(`DELETE FROM counted_entries WHERE user_id=$1`,[uid]);
  await q(`DELETE FROM messages WHERE user_id=$1`,[uid]);
  await q(`DELETE FROM channel_members WHERE user_id=$1`,[uid]);
  await q(`DELETE FROM credits WHERE user_id=$1 OR problem_id=$2`,[uid,pid]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
  await q(`DELETE FROM reviews WHERE user_id=$1`,[uid]);
  await q(`UPDATE jobs SET parent_return_id=NULL WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM returns WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM jobs WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM sessions WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM pool WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM channels WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM problems WHERE id=$1`,[pid]);
  await q(`DELETE FROM tokens WHERE user_id=$1`,[uid]);
  await q(`DELETE FROM reputation WHERE user_id=$1`,[uid]);
  await q(`DELETE FROM users WHERE id=$1`,[uid]);
  await pool.end(); rmSync(tmp,{recursive:true,force:true});
});
const H=(session)=>({authorization:`Bearer ${token}`,accept:'application/json','content-type':'application/json','x-model':'claude-fable-5-1','x-effort':'high',...(session?{'x-session':session}:{})});
const register=async(qs)=>{
  const jobId=Number((await one(`INSERT INTO jobs(problem_id,type,title,brief_md,min_tier,status) VALUES($1,'explore','Fixture','Explore the fixture.',99,'queued') RETURNING id`,[pid])).id);
  const r=await fetch(base+'/start'+qs,{headers:H()}); const j=await r.json(); assert.equal(r.status,200,JSON.stringify(j).slice(0,400)); assert.equal(Number(j.job_id),jobId); return j;
};
const summary=['## Approach','Measure the fixture directly.','## Steps','Read the brief; ran the check.','## Reasoning','The check decides it.','## Results','It holds for n < 10.','## Dead ends','A closed form did not fit.','## Sources','The brief.'].join('\n\n');
const end=(session)=>fetch(base+`/sessions/${session}/end`,{method:'POST',headers:H()});

test('by default a session sends a summary: accepted with its reported usage, recorded and shown as summary, and its reviewer is told it is the person\'s choice', async () => {
  const j=await register('?share=0');
  assert.match(j.brief_md,/\*\*Transcript \(required\): a summary\.\*\*/); assert.match(j.brief_md,/transcripts as a summary you write/);
  const r=await fetch(base+'/result',{method:'POST',headers:H(j.session),body:JSON.stringify({job_id:j.job_id,report_md:'It holds for n < 10.',transcript:summary,transcript_mode:'summary',tokens:{input:5000,output:700,cache_read:0,cache_write:0},transcript_approved:true,author_rung:'measured'})});
  const t=await r.json(); assert.equal(r.status,200,JSON.stringify(t).slice(0,500));
  assert.equal(t.tokens.source,'reported'); assert.equal(t.tokens.input,5000);
  const w=t.warnings.find(x=>/your transcript is a summary, as your person chose/.test(x)); assert.ok(w,JSON.stringify(t.warnings));
  assert.doesNotMatch(w,/It lacks/); assert.ok(!t.warnings.some(x=>/not a session log/.test(x)),'no scolding for the chosen mode');
  const row=await one(`SELECT transcript_mode, tokens FROM returns WHERE id=$1`,[t.return_id]);
  assert.equal(row.transcript_mode,'summary');
  const paid=await one(`SELECT points FROM credits WHERE source_type='return' AND source_id=$1 AND kind='tokens'`,[String(t.return_id)]); assert.ok(paid,'reported usage is credited');
  const page=await (await fetch(base+`/return/${t.return_id}`,{headers:{accept:'text/html'}})).text();
  assert.match(page,/Transcript: summary<\/a>/); assert.doesNotMatch(page,/not a session log/);
  const file=await fetch(base+`/return/${t.return_id}/transcript`); assert.match(file.headers.get('content-disposition'),/transcript\.md/); assert.equal(await file.text(),summary);
  const json=await (await fetch(base+`/return/${t.return_id}?json=1`,{headers:{accept:'application/json'}})).json(); assert.equal(json.transcript_mode,'summary');
  const {composeReviewBrief}=await import('../src/routes/job.ts');
  const brief=(await composeReviewBrief(Number(t.return_id),pid)).brief;
  assert.match(brief,/transcript is a summary the author wrote, as their person chose/); assert.doesNotMatch(brief,/is not a session log/);
  await end(j.session);
});

test('a summary missing sections and usage is accepted and the reply names what is missing', async () => {
  const j=await register('?share=0');
  const r=await fetch(base+'/result',{method:'POST',headers:H(j.session),body:JSON.stringify({job_id:j.job_id,report_md:'Done.',transcript:'## Approach\n\nTried it.',transcript_approved:true,author_rung:'measured'})});
  const t=await r.json(); assert.equal(r.status,200,JSON.stringify(t).slice(0,500));
  const w=t.warnings.find(x=>/as your person chose/.test(x)); assert.ok(w,JSON.stringify(t.warnings));
  assert.match(w,/It lacks ## Steps, ## Reasoning, ## Results, ## Dead ends, ## Sources/); assert.match(w,/No usage was supplied/);
  // Completed later: the summary and the usage, through the transcript correction path.
  const fix=await fetch(base+`/return/${t.return_id}/transcript`,{method:'POST',headers:H(j.session),body:JSON.stringify({transcript:summary,transcript_mode:'summary',tokens:{input:300,output:40}})});
  const f=await fix.json(); assert.equal(fix.status,200,JSON.stringify(f).slice(0,500)); assert.equal(f.transcript_mode,'summary'); assert.equal(f.tokens.input,300);
  assert.ok(await one(`SELECT 1 FROM credits WHERE source_type='return' AND source_id=$1 AND kind='tokens'`,[String(t.return_id)]));
  await end(j.session);
});

test('a full log sent where the person chose a summary is recorded as full, the agent is told, and a summary replaces it keeping the counted usage', async () => {
  const j=await register('?share=0');
  const log=[JSON.stringify({type:'user',message:{content:`solveathome job #${j.job_id}`}}),JSON.stringify({type:'assistant',message:{id:`${slug}-m1`,model:'claude-fable-5-1',usage:{input_tokens:1200,output_tokens:300,cache_read_input_tokens:0,cache_creation_input_tokens:0}}})].join('\n');
  const r=await fetch(base+'/result',{method:'POST',headers:H(j.session),body:JSON.stringify({job_id:j.job_id,report_md:'Done.',transcript:log,transcript_approved:true,author_rung:'measured'})});
  const t=await r.json(); assert.equal(r.status,200,JSON.stringify(t).slice(0,500));
  assert.equal((await one(`SELECT transcript_mode FROM returns WHERE id=$1`,[t.return_id])).transcript_mode,'full');
  assert.ok(t.warnings.some(x=>/your person chose summary transcripts for this session, and you sent the full session log/.test(x)),JSON.stringify(t.warnings));
  assert.match(await (await fetch(base+`/return/${t.return_id}`,{headers:{accept:'text/html'}})).text(),/Transcript: full session log<\/a>/);
  const rep=await fetch(base+`/return/${t.return_id}/transcript`,{method:'POST',headers:H(j.session),body:JSON.stringify({transcript:summary,transcript_mode:'summary'})});
  const o=await rep.json(); assert.equal(rep.status,200,JSON.stringify(o).slice(0,500));
  assert.equal(o.tokens.input,1200,'the counted usage stays');
  const row=await one(`SELECT transcript, transcript_mode, tokens FROM returns WHERE id=$1`,[t.return_id]);
  assert.equal(row.transcript,summary); assert.equal(row.transcript_mode,'summary'); assert.equal(row.tokens.input,1200);
  assert.equal(Number((await one(`SELECT count(*) AS c FROM counted_entries WHERE source_type='return' AND source_id=$1`,[t.return_id])).c),1,'its entry stays counted once');
  await end(j.session);
});

test('transcript=full keeps the log brief and the session records full', async () => {
  const j=await register('?share=0&transcript=full');
  assert.match(j.brief_md,/Cut whole JSONL lines/); assert.match(j.brief_md,/transcripts as the full session log/);
  assert.equal((await one(`SELECT ai FROM sessions WHERE id=$1`,[j.session])).ai.transcript_mode,'full');
  await end(j.session);
});
