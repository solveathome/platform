import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLab} from './simulation/harness.mjs';
import {scopeHash} from '../src/lib/shared-research-format.ts';
const root=mkdtempSync(join(tmpdir(),'applicability-config-'));process.env.PROJECTS_DIR=root;
let lab;
before(async()=>{lab=await createLab();});
after(async()=>{await lab?.close();rmSync(root,{recursive:true,force:true});});
async function world(name,template='md5'){
 const w=await lab.project(name,29),slug=w.base.split('/').at(-1),c=JSON.parse(readFileSync(new URL(`../projects/${template}/project.json`,import.meta.url)));
 Object.assign(c,{slug,listed:true});delete c.challenge;mkdirSync(join(root,slug));writeFileSync(join(root,slug,'project.json'),JSON.stringify(c));
 for(const l of c.lanes)await w.q('INSERT INTO lanes(problem_id,slug,title,variant) VALUES($1,$2,$3,$4)',[w.pid,l.slug,l.title,l.variant??'']);
 return Object.assign(w,{slug,c});
}
const scope={key:'method',statement_md:'A reusable exact constraint on the specified inputs.',domain_md:'Only the named finite input domain.',assumptions_md:'Exact stated input representation.',kind:'method',artifact_sha256:[],transfer_conditions_md:'Use the identical invariant and legal domain; new domains require a bridge.'};
async function source(w){
 const a=await w.actor('author','gpt-6-astra'),r1=await w.actor('judge','claude-fable-5-1',{trusted:true}),r2=await w.actor('judge2','gpt-6-astra',{trusted:true});
 const submitted=await a.submit({type:'direction',research_evidence:{topic_ids:['self-match.methods'],scopes:[scope]}});
 const assessment={supported_scopes:[{scope_key:scope.key,scope_sha256:scopeHash(scope)}]};
 await r1.submit({type:'review',return_id:submitted.return_id,verdict:'accept',rung:'measured',research_assessment:assessment,notes_md:'Only the exact scoped method.'});
 if((w.c.review_quorum??1)>1)await r2.submit({type:'review',return_id:submitted.return_id,verdict:'accept',rung:'measured',research_assessment:assessment,notes_md:'Independent scoped method judgment.'});
 return {a,r1,r2,id:submitted.return_id,assessment};
}
const checks=w=>w.q('SELECT * FROM jobs WHERE problem_id=$1 AND applicability_check IS NOT NULL ORDER BY id',[w.pid]);
function matrix(assignment,decisions={}){
 const c=assignment.applicability_check;
 return {source_return_id:c.source_return_id,input_sha256:c.input_sha256,entries:c.targets.map(t=>({target_id:t.id,decision:decisions[t.id]??'inapplicable',scope_keys:['method'],evidence_md:'Scripted source/domain comparison with source and exact scope locators.',assumptions_md:'The original finite domain only; no expanded theorem.'}))};
}
async function screening(w,s,decisions={}){
 const issued=await w.take(s.r1,j=>Boolean(j.applicability_check));
 const result=await s.r1.submit({applicability_assessment:matrix(issued,decisions)});
 return {issued,result};
}
async function consumer(w,lane,topics=[]){
 const l=await w.one('SELECT id FROM lanes WHERE problem_id=$1 AND slug=$2',[w.pid,lane]);
 return w.one(`INSERT INTO jobs(problem_id,lane_id,type,title,brief_md,min_tier,budget_hours,purpose,research_task) VALUES($1,$2,'explore','Distinct consumer','An uncovered finite question.',99,.1,'discovery',$3) RETURNING *`,[w.pid,l.id,JSON.stringify({intent:'new',topic_ids:topics,predecessor_returns:[],unresolved_obligation_md:'Distinct question.',expected_evidence_md:'Scoped evidence.',stop_if_md:'Already answered.',domain_md:'Named consumer domain.'})]);
}
test('only accepted endorsed science queues one screening; candidate and clerical records stay outside',async()=>{
 const w=await world('source-threshold'),a=await w.actor('a','gpt-6-astra'),r1=await w.actor('r1','claude-fable-5-1',{trusted:true}),r2=await w.actor('r2','gpt-6-astra',{trusted:true});
 const ret=await a.submit({type:'direction',research_evidence:{topic_ids:['self-match.methods'],scopes:[scope]}});
 const v={type:'review',return_id:ret.return_id,verdict:'accept',rung:'measured',research_assessment:{supported_scopes:[{scope_key:'method',scope_sha256:scopeHash(scope)}]},notes_md:'Exact source evidence.'};
 await r1.submit(v);assert.equal((await checks(w)).length,0);await r2.submit(v);assert.equal((await checks(w)).length,1);
 const {queueApplicability}=await import('../src/lib/research-applicability.ts');
 const ids=await Promise.all([queueApplicability(w.pid,w.slug,ret.return_id),queueApplicability(w.pid,w.slug,ret.return_id)]);assert.equal(ids[0],ids[1]);assert.equal((await checks(w)).length,1);
 const witness=await a.submit({type:'direction',research_evidence:{scopes:[{...scope,key:'witness',kind:'witness'}]}});
 for(const actor of [r1,r2])await actor.submit({...v,return_id:witness.return_id,research_assessment:{supported_scopes:[{scope_key:'witness',scope_sha256:scopeHash({...scope,key:'witness',kind:'witness'})}]}});
 assert.equal((await checks(w)).length,1);
 // Fault injection models the numerical verifier's distinct historical authority; this is not a scientific verdict.
 await w.q("INSERT INTO return_decisions(return_id,status,provisional,by,note) VALUES($1,'accepted',false,'verifier','Synthetic numerical witness authority')",[ret.return_id]);
 assert.equal(await queueApplicability(w.pid,w.slug,ret.return_id),null);await w.invariant();
});
test('trusted matrix transfers evidence across tracks without experiments or scientific acceptance',async()=>{
 const w=await world('md5-transfer'),s=await source(w),{issued,result}=await screening(w,s,{'all-zeros':'applicable','smallest-collision':'unresolved'});
 assert.equal(result.status,'recorded');assert.equal(result.reviews_requested,0);assert.equal((await checks(w)).length,1);
 const record=await w.read(`/return/${result.return_id}`);assert.equal(record.applicability_assessment.effective,true);assert.equal(record.applicability_assessment.scientific_authority,false);
 const {researchContext}=await import('../src/lib/shared-research.ts');
 const j=await consumer(w,'all-zeros',['all-zeros.methods']),context=await researchContext(w.pid,w.slug,{...j,lane_slug:'all-zeros'});
 assert.ok(context.items.some(i=>i.id===s.id));assert.equal(context.applicability[0].assessment_return_id,result.return_id);assert.equal(context.applicability[0].entries[0].target_id,'all-zeros');
 const collision=await consumer(w,'smallest-collision',['smallest-collision.methods']);assert.equal((await researchContext(w.pid,w.slug,{...collision,lane_slug:'smallest-collision'})).applicability.length,0);
 assert.equal((await w.read(`/return/${s.id}`)).status,'accepted');
 const retry=await s.r1.start();assert.ok(retry.job_id!==issued.job_id);await w.finish(s.r1);await w.invariant();
});
test('authorization, complete target matrix and exact bindings are enforced while invalid optional metadata remains receivable',async()=>{
 const w=await world('screen-guards'),s=await source(w),outsider=await w.actor('outsider','gpt-6-sol');
 await outsider.request(`/return/${s.id}/applicability/reopen`,{method:'POST',body:{note:'Untrusted reopening.'},status:403});
 const {applicableSources}=await import('../src/lib/research-applicability.ts');
 const issued=await w.take(s.r1,j=>Boolean(j.applicability_check)),bad=matrix(issued);bad.entries.pop();
 const recorded=await s.r1.submit({applicability_assessment:bad});assert.match(recorded.warnings.join('\n'),/every issued target/);assert.equal((await w.read(`/return/${recorded.return_id}`)).applicability_assessment,null);
 assert.equal((await applicableSources(w.pid,w.slug,{lane_slug:'all-zeros'},[])).length,0);
 const forged=await outsider.submit({type:'direction',applicability_assessment:{...matrix(issued),trusted:true,effective:true}});assert.match(forged.warnings.join('\n'),/issued administrative/);
 const other=await world('other-project');await s.r1.request(`/return/${s.id}/applicability/reopen`,{method:'POST',body:{note:'Explicit retry after incomplete matrix.'}});
 const fresh=await w.take(s.r1,j=>Boolean(j.applicability_check)),foreign=matrix(fresh);foreign.source_return_id=999999;
 const wrong=await s.r1.submit({applicability_assessment:foreign});assert.match(wrong.warnings.join('\n'),/issued target/);assert.equal((await other.read('/research-applicability')).sources.length,0);await w.invariant();
});
test('material corrections stale a held matrix, retries freeze it and exactly one fresh screening follows',async()=>{
 const w=await world('stale-matrix'),s=await source(w),issued=await w.take(s.r1,j=>Boolean(j.applicability_check));
 const corrector=await w.actor('corrector','claude-opus-5-5',{trusted:true});
 await corrector.submit({type:'review',return_id:s.id,verdict:'accept',rung:'measured',research_assessment:{...s.assessment,corrections_md:'The method requires an additional exact-domain constraint.'},notes_md:'Same accepted scope, corrected applicability assumptions.'});
 assert.equal((await checks(w)).filter(j=>['queued','assigned'].includes(j.status)).length,1);
 assert.deepEqual((await s.r1.request('/start')).applicability_check,issued.applicability_check);
 const result=await s.r1.submit({applicability_assessment:matrix(issued,{'all-zeros':'applicable'})});assert.match(result.warnings.join('\n'),/source or decision base changed/);
 const record=await w.read(`/return/${result.return_id}`);assert.equal(record.applicability_assessment.effective,false);
 const jobs=await checks(w);assert.equal(jobs.length,2);assert.equal(jobs.filter(j=>['queued','assigned'].includes(j.status)).length,1);assert.notEqual(jobs[0].applicability_check.input_sha256,jobs[1].applicability_check.input_sha256);await w.invariant();
});
test('unchanged evidence is reused; explicit trusted reopening removes current transfer until reassessed',async()=>{
 const w=await world('reuse-reopen'),s=await source(w),{result}=await screening(w,s,{'all-zeros':'applicable'});
 const {currentApplicability,reconsiderApplicability}=await import('../src/lib/research-applicability.ts');
 await w.q("UPDATE returns SET cites='{\"returns\":[]}' WHERE id=$1",[s.id]);await reconsiderApplicability(w.pid,w.slug);await reconsiderApplicability(w.pid,w.slug);assert.equal((await checks(w)).length,1);
 assert.equal((await currentApplicability(w.pid,w.slug,s.id)).current,true);
 await s.r2.request(`/return/${s.id}/applicability/reopen`,{method:'POST',body:{note:'A specific disputed transfer condition needs another read.'}});assert.equal((await currentApplicability(w.pid,w.slug,s.id)).current,false);
 const replacement=await screening(w,s,{'all-zeros':'unresolved'});assert.equal(replacement.result.reviews_requested,0);assert.equal((await currentApplicability(w.pid,w.slug,s.id)).id,replacement.result.return_id);assert.equal((await checks(w)).length,2);
 const {applicableSources}=await import('../src/lib/research-applicability.ts');assert.equal((await applicableSources(w.pid,w.slug,{lane_slug:'all-zeros'},[])).length,0);
 assert.equal((await w.read(`/return/${result.return_id}`)).applicability_assessment.effective,true);await w.invariant();
});
test('Twin Primes uses configured areas and preserves main theorem and secondary-obligation boundaries',async()=>{
 const w=await world('twin-transfer','twin-primes'),s=await source(w),{issued}=await screening(w,s,{'kk-lower-bound':'applicable','formalize':'applicable'});
 assert.equal(issued.applicability_check.targets.length,7);
 const {researchContext,settledTopics}=await import('../src/lib/shared-research.ts');
 const j=await consumer(w,'formalize',['kk-lower-bound.o2']),ctx=await researchContext(w.pid,w.slug,{...j,lane_slug:'formalize',paper_slug:'kk-lower-bound'});
 assert.equal(ctx.applicability[0].entries.length,2);assert.ok(ctx.items.some(i=>i.id===s.id));assert.equal(ctx.items.find(i=>i.id===s.id).scopes[0].domain_md,scope.domain_md);
 assert.deepEqual([...await settledTopics(w.pid,w.slug,['kk-lower-bound.main','kk-lower-bound.o2'])],[]);await w.invariant();
 const {applicableSources}=await import('../src/lib/research-applicability.ts');assert.equal((await applicableSources(w.pid,w.slug,{},[])).length,0);
});
test('reviewer revocation and source withdrawal remove automatic transfer without rewriting assessments',async()=>{
 const w=await world('authority-freshness'),s=await source(w),{result}=await screening(w,s,{'all-zeros':'applicable'});
 const {currentApplicability,applicableSources}=await import('../src/lib/research-applicability.ts');
 await w.q('DELETE FROM project_roles WHERE problem_id=$1 AND user_id=$2',[w.pid,s.r1.id]);assert.equal((await currentApplicability(w.pid,w.slug,s.id)).reviewer_current,false);assert.equal((await applicableSources(w.pid,w.slug,{lane_slug:'all-zeros'},[])).length,0);
 await w.q("UPDATE returns SET status='pending' WHERE id=$1",[s.id]);assert.equal((await currentApplicability(w.pid,w.slug,s.id)).source_current,false);
 assert.equal((await w.read(`/return/${result.return_id}`)).applicability_assessment.effective,true);await w.invariant();
});
test('MD5 challenge synthesis bypass still receives the independent screening with no record-search brief',async()=>{
 const w=await world('challenge-screen');w.c.challenge=JSON.parse(readFileSync(new URL('../projects/md5/project.json',import.meta.url))).challenge;
 writeFileSync(join(root,w.slug,'project.json'),JSON.stringify(w.c));
 const s=await source(w),{issued}=await screening(w,s,{'all-zeros':'applicable'});
 assert.equal(issued.applicability_check.targets.length,3);assert.match(issued.brief_md,/Bounded applicability screening/);assert.doesNotMatch(issued.brief_md,/Your search budget/);
 assert.equal(issued.assignment_reason.progress_preference.bonus,0);await w.invariant();
});
test('screening preserves distinct-family trust and the explicit own-handle grant exception',async()=>{
 const w=await world('independent-screen'),s=await source(w),job=(await checks(w))[0];
 const {selectJob}=await import('../src/lib/scheduler.ts');
 function agent(id,model,trusted,granted=trusted){return {sessionId:'screen-query-fixture',provider:null,lane:null,uid:id,slug:w.slug,problemId:w.pid,model,tier:1,effort:'max',trusted,granted,maxHours:2,cpuHours:1,ramGb:8,disk:10,hasGpu:false,reviewStreak:0,capabilities:{tools:[],sources:[]},workCheckOnly:true};}
 assert.ok(!await selectJob(agent(s.a.id,'claude-fable-5-1',true,false),true));
 assert.ok(!await selectJob(agent(s.r2.id,'gpt-6-astra',true),true));
 assert.ok(!await selectJob(agent(s.r1.id,'claude-fable-5-1',false),true));
 assert.equal(Number((await selectJob(agent(s.r1.id,'claude-fable-5-1',true),true)).id),Number(job.id));
 assert.equal(Number((await selectJob(agent(s.a.id,'claude-fable-5-1',true,true),true)).id),Number(job.id));await w.invariant();
});
test('administrative matrix citations resolve to the scientific source and do not invalidate unchanged covered evidence',async()=>{
 const w=await world('matrix-materiality'),s=await source(w),{result}=await screening(w,s,{'all-zeros':'applicable'});
 const {workEvidence,retireCoveredWork}=await import('../src/lib/work-disposition.ts');
 const fields={review_ids:[],message_ids:[],topic_ids:[]},direct=await workEvidence(w.pid,'scope-fixture',{...fields,predecessor_returns:[s.id]}),indirect=await workEvidence(w.pid,'scope-fixture',{...fields,predecessor_returns:[result.return_id]});
 assert.equal(direct.sha256,indirect.sha256);
 await s.r2.request(`/return/${s.id}/applicability/reopen`,{method:'POST',body:{note:'A scoped applicability dispute.'}});
 const job=(await checks(w)).at(-1);await retireCoveredWork(w.pid,w.slug);assert.equal((await w.one('SELECT status FROM jobs WHERE id=$1',[job.id])).status,'queued');await w.invariant();
});

test('clerical reviews and scheduling annotations do not cause another applicability screening',async()=>{
 const w=await world('clerical-noise'),s=await source(w);await screening(w,s,{'all-zeros':'applicable'});
 const clerk=await w.actor('clerk','claude-opus-5-5',{trusted:true});
 await clerk.submit({type:'review',return_id:s.id,verdict:'accept',rung:'measured',notes_md:'Clerical citation formatting; scientific scope and evidence unchanged.'});
 const {reconsiderApplicability,currentApplicability}=await import('../src/lib/research-applicability.ts');
 await reconsiderApplicability(w.pid,w.slug);assert.equal((await checks(w)).length,1);assert.equal((await currentApplicability(w.pid,w.slug,s.id)).current,true);await w.invariant();
});
async function acceptedUnscoped(w){
 const a=await w.actor('unscoped-author','gpt-6-astra'),j=await w.actor('unscoped-judge','claude-fable-5-1',{trusted:true}),j2=await w.actor('unscoped-judge2','gpt-6-astra',{trusted:true});
 const ret=await a.submit({type:'direction',report_md:'A scripted useful scientific claim accepted at its original finite domain; no typed scope metadata.'});
 for(const actor of (w.c.review_quorum??1)>1?[j,j2]:[j])await actor.submit({type:'review',return_id:ret.return_id,verdict:'accept',rung:'measured',notes_md:'Existing scientific acceptance only; no scope endorsement fabricated.'});
 return {a,r1:j,r2:j2,id:ret.return_id};
}
test('existing trusted acceptance queues consideration without a second scope quorum; empty references never transfer',async()=>{
 const w=await world('unscoped-consideration'),s=await acceptedUnscoped(w);assert.equal((await checks(w)).length,1);
 const issued=await w.take(s.r1,j=>Boolean(j.applicability_check));assert.equal(issued.applicability_check.consideration_only,true);assert.deepEqual(issued.applicability_check.scopes,[]);
 const a=matrix(issued,{'all-zeros':'applicable'});for(const e of a.entries)e.scope_keys=[];
 const result=await s.r1.submit({applicability_assessment:{...a,scientific_authority:true,provisional_relevance:false}});
 const record=await w.read(`/return/${result.return_id}`);assert.equal(record.applicability_assessment.effective,true);assert.equal(record.applicability_assessment.provisional_relevance,true);assert.equal(record.applicability_assessment.scientific_authority,false);assert.ok(record.applicability_assessment.entries.every(e=>!e.transfer_eligible));
 const {currentApplicability,applicableSources,reconsiderApplicability}=await import('../src/lib/research-applicability.ts');
 const current=await currentApplicability(w.pid,w.slug,s.id);assert.equal(current.consideration_current,true);assert.equal(current.current,false);assert.equal(current.transfer_current,false);
 assert.deepEqual(await applicableSources(w.pid,w.slug,{lane_slug:'all-zeros'},[]),[]);
 await reconsiderApplicability(w.pid,w.slug);await reconsiderApplicability(w.pid,w.slug);assert.equal((await checks(w)).length,1);assert.equal((await w.read(`/return/${s.id}`)).status,'accepted');await w.invariant();
});
test('declared but unendorsed scope may be considered, then material endorsements require a fresh bound matrix',async()=>{
 const w=await world('scope-after-consideration'),a=await w.actor('a','gpt-6-astra'),r1=await w.actor('r1','claude-fable-5-1',{trusted:true}),r2=await w.actor('r2','gpt-6-astra',{trusted:true});
 const ret=await a.submit({type:'direction',research_evidence:{scopes:[scope]}});
 for(const actor of [r1,r2])await actor.submit({type:'review',return_id:ret.return_id,verdict:'accept',rung:'measured',notes_md:'Whole source accepted without a typed endorsement.'});
 const s={a,r1,r2,id:ret.return_id};const first=await screening(w,s,{'all-zeros':'applicable'});
 assert.equal((await w.read(`/return/${first.result.return_id}`)).applicability_assessment.provisional_relevance,true);
 const {applicableSources,currentApplicability}=await import('../src/lib/research-applicability.ts');assert.deepEqual(await applicableSources(w.pid,w.slug,{lane_slug:'all-zeros'},[]),[]);
 const c1=await w.actor('scope-j1','claude-opus-5-5',{trusted:true}),c2=await w.actor('scope-j2','gpt-6.1-sol',{trusted:true});
 for(const actor of [c1,c2])await actor.submit({type:'review',return_id:ret.return_id,verdict:'accept',rung:'measured',notes_md:'The exact unchanged source scope is now explicitly endorsed.',research_assessment:{supported_scopes:[{scope_key:'method',scope_sha256:scopeHash(scope)}]}});
 assert.equal((await currentApplicability(w.pid,w.slug,ret.return_id)).consideration_current,false);assert.deepEqual(await applicableSources(w.pid,w.slug,{lane_slug:'all-zeros'},[]),[]);
 const refreshed=await screening(w,s,{'all-zeros':'applicable'});assert.equal((await w.read(`/return/${refreshed.result.return_id}`)).applicability_assessment.entries.find(e=>e.target_id==='all-zeros').transfer_eligible,true);
 assert.equal((await applicableSources(w.pid,w.slug,{lane_slug:'all-zeros'},[])).length,1);await w.invariant();
});
test('a validated sibling scope cannot promote a provisional applicable entry',async()=>{
 const w=await world('per-entry-authority'),s=await source(w),second={...scope,key:'unendorsed-method',statement_md:'A different declared but unendorsed source claim.'};
 // Initial historical fixture extension: actual scope authority remains with the original scientific reviewers only.
 await w.q('UPDATE returns SET research_evidence=$2 WHERE id=$1',[s.id,JSON.stringify({topic_ids:['self-match.methods'],scopes:[scope,second]})]);
 const issued=await w.take(s.r1,j=>Boolean(j.applicability_check)),a=matrix(issued,{'all-zeros':'applicable','self-match':'applicable'});
 a.entries.find(e=>e.target_id==='all-zeros').scope_keys=['unendorsed-method'];await s.r1.submit({applicability_assessment:a});
 const {applicableSources}=await import('../src/lib/research-applicability.ts');assert.deepEqual(await applicableSources(w.pid,w.slug,{lane_slug:'all-zeros'},[]),[]);assert.equal((await applicableSources(w.pid,w.slug,{lane_slug:'self-match'},[])).length,1);await w.invariant();
});
test('Twin Primes unscoped acceptance yields one seven-area provisional consideration without claiming obligations proved',async()=>{
 const w=await world('twin-unscoped','twin-primes'),s=await acceptedUnscoped(w),issued=await w.take(s.r1,j=>Boolean(j.applicability_check));
 assert.equal(issued.applicability_check.targets.length,7);const a=matrix(issued,{'formalize':'applicable','kk-lower-bound':'applicable'});for(const e of a.entries)e.scope_keys=[];
 await s.r1.submit({applicability_assessment:a});const {applicableSources}=await import('../src/lib/research-applicability.ts');assert.deepEqual(await applicableSources(w.pid,w.slug,{lane_slug:'formalize',paper_slug:'kk-lower-bound'},['kk-lower-bound.main']),[]);assert.equal((await checks(w)).length,1);await w.invariant();
});
test('legacy strict issued snapshots stay valid and unchanged completed evidence is not requeued for the new mode',async()=>{
 const w=await world('legacy-strict'),s=await source(w),{applicabilitySource,queueApplicability}=await import('../src/lib/research-applicability.ts');
 const old=await applicabilitySource(w.pid,w.slug,s.id),row=(await checks(w))[0],check={...row.applicability_check,input_sha256:old.input_sha256,source_snapshot:old.snapshot,scopes:old.scopes};delete check.consideration_only;
 await w.q('UPDATE jobs SET applicability_check=$2 WHERE id=$1',[row.id,JSON.stringify(check)]);
 const issued=await w.take(s.r1,j=>Boolean(j.applicability_check));assert.equal(issued.applicability_check.consideration_only,undefined);
 const result=await s.r1.submit({applicability_assessment:matrix(issued,{'all-zeros':'applicable'})});assert.equal((await w.read(`/return/${result.return_id}`)).applicability_assessment.effective,true);
 assert.equal(await queueApplicability(w.pid,w.slug,s.id),null);assert.equal((await checks(w)).length,1);await w.invariant();
});
test('existing trusted reopening can nominate unscoped accepted science; stale provisional responses stay ineffective',async()=>{
 const w=await world('provisional-reopen'),s=await acceptedUnscoped(w),issued=await w.take(s.r1,j=>Boolean(j.applicability_check));
 await w.q("UPDATE returns SET report_md=report_md||' Material corrected premise.' WHERE id=$1",[s.id]);
 const a=matrix(issued,{'all-zeros':'applicable'});for(const e of a.entries)e.scope_keys=[];const stale=await s.r1.submit({applicability_assessment:a});assert.match(stale.warnings.join('\n'),/source or decision base changed/);assert.equal((await w.read(`/return/${stale.return_id}`)).applicability_assessment.effective,false);
 assert.equal((await checks(w)).filter(j=>['queued','assigned'].includes(j.status)).length,1);await s.r2.request(`/return/${s.id}/applicability/reopen`,{method:'POST',body:{note:'Existing explicit nomination path; accepted source remains unscoped.'}});assert.equal((await checks(w)).filter(j=>['queued','assigned'].includes(j.status)).length,1);await w.invariant();
});
