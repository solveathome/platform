import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLab} from './simulation/harness.mjs';
const root=mkdtempSync(join(tmpdir(),'repair-config-'));process.env.PROJECTS_DIR=root;
const sha=s=>createHash('sha256').update(s).digest('hex');
let lab;
before(async()=>{lab=await createLab();});
after(async()=>{await lab?.close();rmSync(root,{recursive:true,force:true});});
async function world(name,template='md5') {
  const w=await lab.project(name,39),slug=w.base.split('/').at(-1),config=JSON.parse(readFileSync(new URL(`../projects/${template}/project.json`,import.meta.url)));
  Object.assign(config,{slug,listed:true});delete config.challenge;mkdirSync(join(root,slug));writeFileSync(join(root,slug,'project.json'),JSON.stringify(config));
  return Object.assign(w,{slug});
}
async function source(w,actor,report,{status='accepted',cites=[],path=null,revision=null,provisional=false}={}) {
  return Number((await w.one(`INSERT INTO returns(problem_id,user_id,type,model,provider,report_md,transcript,status,cites,revision_path,revision_sha,provisional) VALUES($1,$2,'audit',$3,'test',$4,'Fixture evidence',$5,$6,$7,$8,$9) RETURNING id`,[w.pid,actor.id,actor.model,report,status,JSON.stringify({returns:cites}),path,revision,provisional])).id);
}
async function fixture(template) {
  const w=await world(`repair-${template}`,template),a=await w.actor('author','claude-opus-5'),worker=await w.actor('repairer','gpt-6-astra',{trusted:true}),judge=await w.actor('judge','claude-fable-5-1',{trusted:true});
  const path='research/result.md',body='Established finite result; the endpoint annotation needs correction.\n';
  mkdirSync(join(process.env.DOCS_DIR,w.slug,'research'),{recursive:true});writeFileSync(join(process.env.DOCS_DIR,w.slug,path),body);
  const established=await source(w,a,'The finite result holds only for the stated domain. Preserve the excluded endpoint.'),served=await source(w,a,'Accepted document with an incorrect endpoint annotation.',{cites:[established],path,revision:sha(body)});
  await w.q(`INSERT INTO document_versions(problem_id,path,version,content_sha,return_id,summary) VALUES($1,$2,1,$3,$4,'Fixture')`,[w.pid,path,sha(body),served]);
  const failed=await source(w,a,'Earlier repair changed the inequality but lost the excluded endpoint.',{status:'rejected',cites:[served],path});
  const review=Number((await w.one(`INSERT INTO reviews(return_id,user_id,model,provider,verdict,rung,notes_md,needs_md,weight,transcript,tokens,trusted) VALUES($1,$2,$3,'test','reject','measured','Restore the excluded endpoint from the established finite result.','Success: the revised inequality excludes the same endpoint and cites the finite result.',1,'Fixture','{}',true) RETURNING id`,[failed,judge.id,judge.model])).id);
  const {recordFinding}=await import('../src/lib/findings.ts'),{spawnFixJob}=await import('../src/routes/job.ts');
  const finding=await recordFinding({problemId:w.pid,path,note:'Correct the endpoint annotation without changing the finite result domain.',scope:'before_circulation',contentSha:sha(body),returnId:failed,reviewId:review});
  const job=await spawnFixJob(w.pid,null,w.slug,path,'Correct the endpoint annotation without changing the finite result domain.',{returnId:failed,reviewId:review,findingId:finding});
  return {w,a,worker,judge,path,body,established,served,failed,review,finding,job};
}

for(const template of ['md5','twin-primes']) test(`${template}: repair brief carries exact prior attempt, criticism and accepted dependency; review reuses the frozen issue snapshot`,async()=>{
  const f=await fixture(template),{w,worker,judge}=f;
  const issued=await w.take(worker,a=>a.type==='audit'&&Number(a.job_id)===f.job),context=issued.repair_context;
  assert.equal(context.schema,'repair-context-v1');assert.equal(context.documents[0].content_sha256,sha(f.body));
  assert.deepEqual(context.obligations.map(x=>x.finding_id),[f.finding]);
  const accepted=context.source_returns.find(r=>r.return_id===f.established),failed=context.source_returns.find(r=>r.return_id===f.failed);
  assert.equal(accepted.preservation_candidate,true);assert.equal(failed.preservation_candidate,false);
  assert.equal(accepted.report.sha256,sha('The finite result holds only for the stated domain. Preserve the excluded endpoint.'));
  assert.ok(accepted.relations.includes(`cited_by_return_${f.served}`));
  assert.match(issued.brief_md,/Restore the excluded endpoint/);assert.match(issued.brief_md,/Success: the revised inequality excludes/);
  assert.match(issued.brief_md,/concrete falsifiable test/);assert.match(issued.brief_md,/pass, fail, not_run or unknown/);
  const frozen=(await w.one(`SELECT assignment_payload->'repair_context' AS c FROM assignment_attempts WHERE id=$1`,[issued.attempt_id])).c;
  assert.deepEqual(frozen,context);
  // A later report revision and finding must not rewrite the held attempt or its default closure set.
  await w.q(`UPDATE returns SET report_md='Later source revision with changed evidence.' WHERE id=$1`,[f.established]);
  const {recordFinding,linkToJob}=await import('../src/lib/findings.ts');
  const late=await recordFinding({problemId:w.pid,path:f.path,note:'A later distinct correction.',scope:'before_circulation',contentSha:sha(f.body),returnId:f.served});await linkToJob(late,f.job);
  const held=await worker.request('/start',{assignment:null});assert.deepEqual(held.repair_context,context);
  const content='Established finite result; corrected endpoint annotation.\n',file=await worker.upload('result.md',content);
  const candidate=await worker.submit({report_md:`Repair delta: finding #${f.finding}; changed the annotation only. Baseline ${sha(f.body)}, candidate ${file}. Preservation check not_run: canonical observation missing; obligation remains.`,revision:{path:f.path,file,base:sha(f.body)},files:[file],cites:{returns:[f.established,f.failed]}});
  const ret=await w.read(`/return/${candidate.return_id}`);assert.deepEqual(ret.resolves,[f.finding]);assert.equal(ret.status,'pending');
  const reviewJob=await w.take(judge,a=>a.type==='review'&&Number(a.parent_return_id)===Number(candidate.return_id));
  assert.ok(reviewJob.brief_md.includes(context.context_sha256));assert.ok(reviewJob.brief_md.includes(accepted.report.sha256));
  assert.match(reviewJob.brief_md,/not only the latest complaint/);assert.match(reviewJob.brief_md,/not_run and unknown are not passes/);
  assert.ok(reviewJob.brief_md.includes(`candidate artifact ${file}`));
  await judge.submit({verdict:'reject',reject_reason:'unverifiable',unverifiable:true,needs_md:'Supply the missing focused preservation observation bound to the candidate hash.',notes_md:'Only that unresolved obligation; no full rerun is required.',rung:'measured'});
  assert.equal((await w.one(`SELECT status FROM returns WHERE id=$1`,[f.served])).status,'accepted');
  assert.equal((await w.one(`SELECT status FROM findings WHERE id=$1`,[f.finding])).status,'open');
  assert.equal((await w.one(`SELECT status FROM findings WHERE id=$1`,[late])).status,'open');
});

test('checkability follow-up includes exact source claim and archived criticism without promoting pending evidence',async()=>{
  const w=await world('follow-up'),a=await w.actor('author','claude-opus-5'),r=await w.actor('repairer','gpt-6-astra',{trusted:true});
  const prior=await source(w,a,'Pending finite claim with missing observed output.',{status:'pending',provisional:true});
  await w.q(`INSERT INTO review_history(return_id,review) VALUES($1,$2)`,[prior,JSON.stringify({id:90210,return_id:prior,notes_md:'The exact output hash is missing.',needs_md:'Supply captured output for these exact inputs.',verdict:'reject',trusted:true,created_at:new Date().toISOString()})]);
  const job=Number((await w.one(`INSERT INTO jobs(problem_id,type,title,brief_md,follow_up_of,min_tier,quorum,requires_trust) VALUES($1,'explore','Make claim checkable','Address the missing evidence.',$2,1,1,true) RETURNING id`,[w.pid,prior])).id);
  const issued=await w.take(r,x=>Number(x.job_id)===job);
  assert.equal(issued.repair_context.source_returns[0].preservation_candidate,false);
  assert.match(issued.brief_md,/Pending finite claim/);assert.match(issued.brief_md,/archived; read in the return review_history/);assert.match(issued.brief_md,/Supply captured output/);
  await w.q(`UPDATE returns SET status='accepted',provisional=false WHERE id=$1`,[prior]);
  const held=await r.request('/start',{assignment:null});assert.equal(held.repair_context.source_returns[0].status_at_issue,'pending');
  await r.release();
});

test('historical candidate without an issued snapshot retains unknown preservation evidence',async()=>{
  const w=await world('legacy-repair'),a=await w.actor('author','claude-opus-5');
  const candidate=await source(w,a,'Historical revision.',{status:'pending',path:'research/result.md',revision:'a'.repeat(64)});
  const {composeReviewBrief}=await import('../src/routes/job.ts');
  const review=await composeReviewBrief(candidate,w.pid);
  assert.match(review.brief,/No issued repair snapshot is recorded/);assert.match(review.brief,/missing baseline evidence remains unknown/);
  assert.doesNotMatch(review.brief,/Status when issued: accepted/);
});

test('rebase carries both the accepted unapplied proposal and the actual newer served baseline',async()=>{
  const w=await world('repair-rebase'),a=await w.actor('author','claude-opus-5'),r=await w.actor('repairer','gpt-6-astra',{trusted:true}),path='research/rebase.md';
  const old='Old baseline.\n',current='New baseline with an independently established restriction.\n';
  mkdirSync(join(process.env.DOCS_DIR,w.slug,'research'),{recursive:true});writeFileSync(join(process.env.DOCS_DIR,w.slug,path),current);
  const proposal=await source(w,a,'Accepted correction against the old baseline, not integrated.',{path,revision:sha('Old baseline corrected.\n')});
  await w.q(`UPDATE returns SET revision_base_sha=$2,integration='conflict',resolves='[]' WHERE id=$1`,[proposal,sha(old)]);
  const latest=await source(w,a,'Accepted newer restriction that must survive reconciliation.',{path,revision:sha(current)});
  await w.q(`INSERT INTO document_versions(problem_id,path,version,content_sha,return_id) VALUES($1,$2,2,$3,$4)`,[w.pid,path,sha(current),latest]);
  const {spawnRebaseJob}=await import('../src/routes/job.ts');
  const job=await spawnRebaseJob(await w.one(`SELECT * FROM returns WHERE id=$1`,[proposal]),w.slug),issued=await w.take(r,x=>Number(x.job_id)===Number(job));
  assert.equal(issued.repair_context.documents[0].content_sha256,sha(current));
  assert.equal(issued.repair_context.documents[0].version,2);
  assert.ok(issued.repair_context.source_returns.find(s=>s.return_id===proposal).relations.includes('prior_attempt'));
  assert.ok(issued.repair_context.source_returns.find(s=>s.return_id===latest).relations.includes('served_document'));
  assert.match(issued.brief_md,/Accepted newer restriction that must survive/);
  assert.equal((await w.one(`SELECT status,integration FROM returns WHERE id=$1`,[proposal])).integration,'conflict');
  await r.release();
});

test('a mirrored baseline with no version, absent dependencies and truncated report are explicit unknowns',async()=>{
  const w=await world('missing-evidence'),a=await w.actor('author','claude-opus-5'),r=await w.actor('repairer','gpt-6-astra',{trusted:true});
  const prior=await source(w,a,'Long source claim. '.repeat(220),{status:'rejected',path:'research/absent.md',cites:[999999999]});
  const job=Number((await w.one(`INSERT INTO jobs(problem_id,type,title,brief_md,follow_up_of,min_tier,requires_trust) VALUES($1,'audit','Repair missing material','Inspect the exact source.',$2,1,true) RETURNING id`,[w.pid,prior])).id);
  const issued=await w.take(r,x=>Number(x.job_id)===job),context=issued.repair_context;
  assert.equal(context.documents[0].content_sha256,null);assert.equal(context.documents[0].version,null);
  assert.equal(context.source_returns[0].report.truncated,true);assert.deepEqual(context.omitted_source_ids,[999999999]);
  assert.match(issued.brief_md,/sha256 unknown; document version unknown/);assert.match(issued.brief_md,/Omission is not evidence/);
  await r.release();
});
