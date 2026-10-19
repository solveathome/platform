import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import express from 'express';

// Paper retraction (Oct 19 2026, #sah-paper-proposals-meta-review): only an owner or a reviewer trusted by grant retracts, with a
// public reason; the list hides the paper, its page stays up with the reason, its queued jobs expire, nothing is deleted, and a
// restore brings it back. Every step is an event.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
process.env.BASE_URL='http://localhost:0';
const temp=mkdtempSync(join(tmpdir(),'sah-paper-retraction-'));
process.env.FILES_DIR=join(temp,'files');process.env.DOCS_DIR=join(temp,'docs');process.env.OVERLAY_DIR=join(temp,'overlay');process.env.PROJECTS_DIR=join(temp,'projects');
const {q,one,pool,migrate}=await import('../src/db/index.ts');
const {issueToken}=await import('../src/lib/auth.ts');
const {papers}=await import('../src/routes/papers.ts');
const {TERMS_VERSION}=await import('../src/lib/terms.ts');
let server,pid,slug,base,paperId,jobId,otherJobId;
const users={};
before(async()=>{
  await migrate();
  for(const name of ['trusted','plain']) {
    const id=Number((await one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`,[900000000+Math.floor(Math.random()*1e8),'retract-'+name+'-'+randomUUID().slice(0,8),TERMS_VERSION])).id);
    users[name]={id,token:await issueToken(id)};
  }
  slug='retract-'+randomUUID().slice(0,8);
  pid=Number((await one(`INSERT INTO problems (slug,name,repo_url,status_md,discovery_share) VALUES ($1,'Retraction test','https://example.org/r','open',0) RETURNING id`,[slug])).id);
  await q(`INSERT INTO project_roles (problem_id,user_id,role,note) VALUES ($1,$2,'trusted','test grant')`,[pid,users.trusted.id]);
  paperId=Number((await one(`INSERT INTO papers (problem_id,slug,title,kind,status,summary) VALUES ($1,'weak','A weak paper','proposal','proposed','Restates a known bound.') RETURNING id`,[pid])).id);
  await q(`INSERT INTO papers (problem_id,slug,title,kind,status,summary) VALUES ($1,'strong','A strong paper','proposal','proposed','A new bound.')`,[pid]);
  const job=(t,b)=>one(`INSERT INTO jobs (problem_id,type,title,brief_md,git_ref,compute_hint,budget_hours,min_tier,quorum) VALUES ($1,'paper',$2,$3,'main','{}',1,1,1) RETURNING id`,[pid,t,b]);
  jobId=Number((await job('Write weak','paper.slug: weak\n\nWrite it.')).id);
  otherJobId=Number((await job('Write weaker','paper.slug: weaker\n\nWrite it.')).id);
  const app=express();app.use(express.json());app.use('/projects/:slug',papers);
  app.use((e,req,res,next)=>res.status(e.status??500).json({error:e.message}));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  base=`http://127.0.0.1:${server.address().port}/projects/${slug}`;
});
after(async()=>{
  await new Promise(r=>server.close(r));
  await q(`DELETE FROM paper_retraction_events WHERE paper_id IN (SELECT id FROM papers WHERE problem_id=$1)`,[pid]);
  for(const table of ['jobs','papers','project_roles'])await q(`DELETE FROM ${table} WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM problems WHERE id=$1`,[pid]);
  const ids=Object.values(users).map(x=>x.id);
  await q(`DELETE FROM tokens WHERE user_id=ANY($1)`,[ids]);
  await q(`DELETE FROM users WHERE id=ANY($1)`,[ids]);
  await pool.end();rmSync(temp,{recursive:true,force:true});
});
async function call(path,{who,method='GET',body,accept='application/json'}={}) {
  const headers={accept,'content-type':'application/json'};
  if(who)headers.authorization=`Bearer ${users[who].token}`;
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,body:accept==='application/json'?await res.json():await res.text()};
}
const listed=async(qs='')=>(await call('/papers'+qs)).body.papers.map(p=>p.slug).sort();

test('only a trusted reviewer retracts, with a reason', async()=>{
  assert.equal((await call('/papers/weak/retract',{method:'POST',body:{reason:'a known result restated'}})).status,401);
  assert.equal((await call('/papers/weak/retract',{who:'plain',method:'POST',body:{reason:'a known result restated'}})).status,403);
  assert.equal((await call('/papers/weak/retract',{who:'trusted',method:'POST',body:{reason:'weak'}})).status,400);
  assert.equal((await call('/papers/nope/retract',{who:'trusted',method:'POST',body:{reason:'a known result restated'}})).status,404);
  assert.deepEqual(await listed(),['strong','weak']);
});

test('a retraction hides the paper, keeps its page and expires its queued jobs; a restore undoes it', async()=>{
  const r=await call('/papers/weak/retract',{who:'trusted',method:'POST',body:{reason:'A known result restated, no new finding.'}});
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.deepEqual(r.body.jobs_expired,[jobId]);
  assert.equal((await one(`SELECT status FROM jobs WHERE id=$1`,[jobId])).status,'expired');
  assert.equal((await one(`SELECT status FROM jobs WHERE id=$1`,[otherJobId])).status,'queued');
  assert.deepEqual(await listed(),['strong']);
  assert.equal((await call('/papers')).body.retracted,1);
  assert.deepEqual(await listed('?retracted=1'),['strong','weak']);
  const page=await call('/papers/weak');
  assert.equal(page.status,200);
  assert.equal(page.body.retraction.reason,'A known result restated, no new finding.');
  assert.equal(page.body.retraction.events.length,1);
  assert.ok(await one(`SELECT 1 FROM papers WHERE id=$1`,[paperId]),'the row is kept');
  assert.equal((await call('/papers/weak/retract',{who:'trusted',method:'POST',body:{reason:'A known result restated again.'}})).status,409);
  const back=await call('/papers/weak/restore',{who:'trusted',method:'POST',body:{reason:'Retracted by mistake, restored.'}});
  assert.equal(back.status,200,JSON.stringify(back.body));
  assert.deepEqual(await listed(),['strong','weak']);
  assert.deepEqual((await one(`SELECT array_agg(action ORDER BY id) AS a FROM paper_retraction_events WHERE paper_id=$1`,[paperId])).a,['retract','restore']);
  assert.equal((await call('/papers/weak')).body.retraction,null);
});
