import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import express from 'express';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const tmp = mkdtempSync(join(tmpdir(), 'sah-patch-receipt-'));
process.env.PROJECTS_DIR = join(tmp, 'projects');
process.env.DOCS_DIR = join(tmp, 'repos');
process.env.FILES_DIR = join(tmp, 'files');
process.env.OVERLAY_DIR = join(tmp, 'overlay');
const {migrate, one, q, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job} = await import('../src/routes/job.ts');
const slug = `patch-receipt-${Date.now().toString(36)}`;
const configured = 'Run embed.js --check on bound OUTPUT; regenerate only when required.';
let uid, pid, token, server, base;

before(async () => {
  await migrate();
  uid = Number((await one(`INSERT INTO users(github_id,handle,terms_version,terms_accepted_at) VALUES($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random()*1e8), slug, TERMS_VERSION])).id);
  token = await issueToken(uid);
  pid = Number((await one(`INSERT INTO problems(slug,name,repo_url,status_md,discovery_share) VALUES($1,'Patch receipt fixture','https://example.org/r','open',0) RETURNING id`, [slug])).id);
  await q(`INSERT INTO channels(problem_id,path,title) VALUES($1,'','Project')`, [pid]);
  mkdirSync(join(process.env.PROJECTS_DIR, slug), {recursive:true});
  writeFileSync(join(process.env.PROJECTS_DIR, slug, 'project.json'), JSON.stringify({slug,review_notes:{patch:configured}}));
  const app=express(); app.use(express.json()); app.use('/projects/:slug',job);
  server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  base=`http://127.0.0.1:${server.address().port}/projects/${slug}`;
});
after(async () => {
  await new Promise(r=>server.close(r));
  await q(`DELETE FROM messages WHERE user_id=$1`,[uid]);
  await q(`DELETE FROM channel_members WHERE user_id=$1`,[uid]);
  await q(`DELETE FROM credits WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM reviews WHERE user_id=$1`,[uid]);
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
const call=(method,path,session,body,requestId)=>fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,accept:'application/json','content-type':'application/json','x-model':'claude-fable-5-1','x-effort':'max',...(session?{'x-session':session}:{}),...(requestId?{'x-request-id':requestId}:{})},body:body?JSON.stringify(body):undefined});
const diff=(path)=>`--- a/research/${path}\n+++ b/research/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

test('actual completion receipts and reviewer briefs share target-aware guidance; old receipts replay unchanged',async()=>{
  for(const [name,patch,scripts] of [['prose',diff('OUTCOMES.md'),false],['script',diff('producer.py'),true],['mixed',diff('note.md')+diff('producer.py'),true],['quoted',diff('"odd.py"'),true]]) {
    // Quoted Git headers have quotes around the entire path.
    const actualPatch=name==='quoted'?diff('odd.py').replace(/a\/research\/odd.py/g,'"a/research/odd.py"').replace(/b\/research\/odd.py/g,'"b/research/odd.py"'):patch;
    const id=Number((await one(`INSERT INTO jobs(problem_id,type,title,brief_md,min_tier,status) VALUES($1,'measure',$2,'Fixture',99,'queued') RETURNING id`,[pid,name])).id);
    const reg=await call('POST','/start',null,{agreed:true,ai:{max_assignments:1},transcript_preapproved:true}); const s=await reg.json(); assert.equal(reg.status,200,JSON.stringify(s)); assert.equal(Number(s.job_id),id);
    const body={job_id:id,report_md:'A scoped fixture patch, not a research result.',recipe_md:'Apply the supplied patch to a scratch copy and inspect the changed text.',transcript:'fixture',transcript_approved:true,patch:actualPatch};
    const requestId=`patch_receipt_${name}`;
    const response=await call('POST','/result',s.session,body,requestId); const result=await response.json(); assert.equal(response.status,200,JSON.stringify(result));
    const guidance=result.warnings.find(w=>w.startsWith('This return carries a patch')); assert.ok(guidance,JSON.stringify(result));
    if(scripts) assert.match(guidance,/embed\.js --check/); else {assert.match(guidance,/apply it to a copy/);assert.doesNotMatch(guidance,/embed\.js|regenerate/);}
    const brief=(await one(`SELECT brief_md FROM jobs WHERE parent_return_id=$1 AND type='review' LIMIT 1`,[result.return_id])).brief_md;
    if(scripts) assert.match(brief,/embed\.js --check/); else assert.doesNotMatch(brief,/embed\.js --check/);
    if(name==='prose') {
      // Simulate a successful receipt stored before this release; retries must retain history.
      const historical={...result,warnings:[`your return carries a patch: ${configured}`]};
      await q(`UPDATE mutation_receipts SET receipt=$2 WHERE user_id=$1 AND request_id=$3`,[uid,JSON.stringify(historical),requestId]);
      const replay=await call('POST','/result',s.session,body,requestId);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),historical);
    }
    await q(`UPDATE jobs SET status='returned' WHERE problem_id=$1 AND type='review'`,[pid]);
  }
});
