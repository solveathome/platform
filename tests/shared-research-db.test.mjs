import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLab,proposal,step} from './simulation/harness.mjs';
import {scopeHash} from '../src/lib/shared-research-format.ts';
const root=mkdtempSync(join(tmpdir(),'shared-research-config-'));
process.env.PROJECTS_DIR=root;
let lab;
before(async()=>{lab=await createLab();});
after(async()=>{await lab?.close();rmSync(root,{recursive:true,force:true});});
const scope={key:'h0-gate',statement_md:'The exact H0 gate is established on this candidate set.',domain_md:'Full MD5, RFC IV, 32 literal ASCII hex bytes, exact padding.',assumptions_md:'Same baseline and candidate set.',kind:'throughput',artifact_sha256:[],transfer_conditions_md:'Throughput only; no bias.',settles_topic:'self-match.study-2'};
const evidence={topic_ids:['self-match.study-2'],scopes:[scope]};
const assessment={supported_scopes:[{scope_key:'h0-gate',scope_sha256:scopeHash(scope)}],unsupported_extension_md:'No universal lower bound.',corrections_md:'Condition on the chaining value.',next_test_md:'Use a matched strong baseline.',reopen_when_md:'Changed IV is a new scope.'};
function config(w,template='md5') {
 const slug=w.base.split('/').at(-1),c=JSON.parse(readFileSync(new URL(`../projects/${template}/project.json`,import.meta.url)));
 delete c.challenge;Object.assign(c,{slug,listed:true});mkdirSync(join(root,slug));writeFileSync(join(root,slug,'project.json'),JSON.stringify(c));return c;
}
test('HTTP evidence/review linkage reaches later assignments; pending and corrections retain authority boundaries and retries freeze context',async()=>{
 const w=await lab.project('shared-md5',17);config(w);
 const a=await w.actor('author','gpt-6-astra'),r1=await w.actor('reviewer','claude-fable-5-1',{trusted:true}),r2=await w.actor('reviewer2','gpt-6-astra',{trusted:true});
 const result=await a.submit({type:'direction',research_evidence:evidence,cites:{returns:[]}});
 const read=await w.read(`/return/${result.return_id}`);assert.equal(read.research_evidence.scopes[0].kind,'throughput');
 await r1.submit({type:'review',return_id:result.return_id,verdict:'accept',rung:'measured',research_assessment:assessment,notes_md:'Scoped benchmark only.'});
 assert.notEqual((await w.read(`/return/${result.return_id}`)).research_authority.scopes[0].research_status,'accepted');
 await r2.submit({type:'review',return_id:result.return_id,verdict:'accept',rung:'measured',research_assessment:assessment,notes_md:'Exact restricted statement.'});
 assert.equal((await w.read(`/return/${result.return_id}`)).research_authority.scopes[0].research_status,'accepted');
 const route=await a.submit({type:'direction',research:proposal('New gate obligation')});
 const r3=await w.actor('association-reviewer','claude-opus-5-5',{trusted:true});
 await r3.submit({type:'review',return_id:result.return_id,verdict:'accept',rung:'measured',research_assessment:assessment,notes_md:'Exact restricted statement.',research_links:[{subject_return_id:result.return_id,route_id:route.research.route_id,relation:'addresses',rationale_md:'The old return answers part of this gate.'}]});
 const assignment=await w.take(a,j=>Number(j.research_route_id)===route.research.route_id);
 assert.match(assignment.brief_md,/Condition on the chaining value/);assert.match(assignment.brief_md,/Throughput only/);
 assert.ok(assignment.research_context.items.some(i=>i.id===result.return_id));
 assert.equal(assignment.research_task.intent,'extend');
 const retry=await a.request('/start');assert.deepEqual(retry.research_context,assignment.research_context);
 const snap=await w.one('SELECT research_context FROM assignment_attempts WHERE id=$1',[assignment.attempt_id]);assert.ok(snap.research_context.input_vector);
 for(const item of assignment.research_context.items)for(const forbidden of ['session','transcript','attempt_id','assigned_session'])assert.ok(!(forbidden in item));
 await a.submit({research:{route_id:route.research.route_id,outcome:'known',prior_art_md:'The exact earlier full-MD5 H0 gate covers this proposed contribution; its matched candidate scope is unchanged.',evidence_md:'The scoped gate is already present; no need to repeat it.',depends_on:[result.return_id]}});
 assert.equal((await w.read(`/research-routes/${route.research.route_id}`)).state,'known');await w.invariant();
});
test('old-return corrections invalidate a pursuit comparison certificate; unchanged comparisons do not loop',async()=>{
 const w=await lab.project('old-correction',42);config(w);
 const a=await w.actor('a','gpt-6-astra'),judge=await w.actor('judge','claude-fable-5-1',{trusted:true});
 const route=await a.submit({type:'direction',research:proposal('Controlled GPU gate')});
 await w.take(a,j=>j.research_stage==='first_look');const first=await a.submit({request_review:true,research:{route_id:route.research.route_id,outcome:'promising',evidence_md:'The controlled comparison is still open.',next_step:step('controlled baseline')}});
 const pursuit=await w.one("SELECT * FROM jobs WHERE research_route_id=$1 AND research_stage='pursue' AND status='queued'",[route.research.route_id]);
 const {stepInputVector,holdForStepCheck,recordResearch,retireRedundantStepChecks}=await import('../src/lib/research.ts');
 const baseline=await stepInputVector(w.pid,route.research.route_id);await w.q('UPDATE jobs SET step_checked_vector=$2,step_checked_through=$3 WHERE id=$1',[pursuit.id,JSON.stringify(baseline),first.return_id]);
 await judge.submit({type:'review',return_id:first.return_id,verdict:'reject',reject_reason:'overclaimed',notes_md:'A GPU throughput improvement needs a matched baseline; it does not close the mathematical route.',research_assessment:{corrections_md:'Old CV statistics were confounded.',next_test_md:'Hold CV fixed.'}});
 assert.notDeepEqual(await stepInputVector(w.pid,route.research.route_id),baseline);
 const check=await holdForStepCheck(await w.one('SELECT * FROM jobs WHERE id=$1',[pursuit.id]));assert.ok(check);assert.match(check.brief_md,/assessment.*changed/);
 await retireRedundantStepChecks(w.pid);assert.equal((await w.one('SELECT status FROM jobs WHERE id=$1',[check.id])).status,'queued');
 // Exercise the unchanged comparison through the real result path.
 await w.take(a,j=>String(j.job_id)===String(check.id));await a.submit({research:{route_id:route.research.route_id,outcome:'promising',evidence_md:'The narrow correction does not answer this controlled gate; preserve it and continue the exact step.',next_step:step('controlled baseline'),depends_on:[]}});
 const restored=await w.one('SELECT * FROM jobs WHERE id=$1',[pursuit.id]);assert.equal(restored.status,'queued');assert.equal(await holdForStepCheck(restored),null);await w.invariant();
});
test('optional errors warn, cross-project links cannot alter routes, and stale exact-scope endorsements do not count',async()=>{
 const w=await lab.project('link-guards',99);config(w);
 const other=await lab.project('other-link-target',99);
 const a=await w.actor('a','gpt-6-astra'),j=await w.actor('j','claude-fable-5-1',{trusted:true});
 const oa=await other.actor('other-author','gpt-6-astra');const rr=await oa.submit({type:'direction',research:proposal('Other project')});const route={id:rr.research.route_id};
 const bad=await a.submit({type:'direction',research_evidence:{scopes:[{}]}});assert.match(bad.warnings.join('\n'),/metadata not recorded/);
 const ret=await a.submit({type:'direction',research_evidence:evidence});
 const review=await j.submit({type:'review',return_id:ret.return_id,verdict:'accept',rung:'measured',research_assessment:{...assessment,supported_scopes:[{scope_key:'h0-gate',scope_sha256:'0'.repeat(64)}]},research_links:[{subject_return_id:ret.return_id,route_id:Number(route.id),relation:'addresses',rationale_md:'Invalid cross-project target.'}]});
 assert.match(review.warnings.join('\n'),/exact scope hash/);assert.match(review.warnings.join('\n'),/same-project/);assert.equal((await w.read(`/return/${ret.return_id}`)).research_links.length,0);
 assert.equal((await w.read(`/review/${review.review_id}`)).research_assessment.supported_scopes.length,0);
});
test('Twin Primes O2 corrections reach paper jobs without marking the main theorem or other obligations proved',async()=>{
 const w=await lab.project('shared-twin',91);config(w,'twin-primes');
 const a=await w.actor('a','gpt-6-astra'),j=await w.actor('j','claude-fable-5-1',{trusted:true});
 const s={...scope,key:'o2-fixed-u',statement_md:'A fixed-u finite comparison is consistent with the cited asymptotic.',domain_md:'Fixed u only; no two-variable uniformity.',kind:'finite',settles_topic:undefined};
 const ret=await a.submit({type:'direction',research_evidence:{topic_ids:['kk-lower-bound.o2'],scopes:[s]}});
 await j.submit({type:'review',return_id:ret.return_id,verdict:'reject',reject_reason:'overclaimed',notes_md:'Finite checking does not establish uniform asymptotic equality.',research_assessment:{corrections_md:'Uniformity for u <= Z^(1-epsilon) is unproved.',next_test_md:'Produce a quantified uniform remainder or a counterexample.'}});
 const job=await w.one("INSERT INTO jobs(problem_id,type,title,brief_md,min_tier,budget_hours,purpose,priority) VALUES($1,'explore','O2 uniformity obligation','paper.slug: kk-lower-bound',99,0.2,'discovery',10) RETURNING id",[w.pid]);
 const assignment=await w.take(a,t=>String(t.job_id)===String(job.id));assert.match(assignment.brief_md,/Uniformity for u <= Z/);assert.match(assignment.brief_md,/sufficient A=12/);assert.match(assignment.brief_md,/main theorem/);
 assert.equal(assignment.research_context.items.find(i=>i.id===ret.return_id).status,'rejected');assert.equal(assignment.research_task.topic_ids.length,8);
 const {settledTopics}=await import('../src/lib/shared-research.ts');assert.deepEqual([...await settledTopics(w.pid,w.base.split('/').at(-1),assignment.research_task.topic_ids)],[]);
 await w.finish(a);await w.invariant();
});
test('challenge studies retain exact topic IDs and skip only accepted exact scoped answers',async()=>{
 const w=await lab.project('study-selection',19),c=config(w),slug=w.base.split('/').at(-1);
 c.challenge=JSON.parse(readFileSync(new URL('../projects/md5/project.json',import.meta.url))).challenge;
 writeFileSync(join(root,slug,'project.json'),JSON.stringify(c));
 for(const track of c.challenge.tracks)await w.q('INSERT INTO lanes(problem_id,slug,title) VALUES($1,$2,$3)',[w.pid,track.lane,track.name]);
 const {challengeJob}=await import('../src/lib/challenges.ts');
 const {taskForJob,settledTopics}=await import('../src/lib/shared-research.ts');
 const author=await w.actor('author','gpt-6-astra'),j1=await w.actor('j1','claude-fable-5-1',{trusted:true}),j2=await w.actor('j2','gpt-6-astra',{trusted:true});
 const s={...scope,key:'word-dependence',kind:'restricted_fact',statement_md:'The scoped dependence question is answered for this full candidate domain.',settles_topic:'self-match.study-1'};
 const claim=await author.submit({type:'direction',research_evidence:{topic_ids:['self-match.study-1'],scopes:[s]}});
 await challengeJob(w.pid,slug,'self-match');let study=await challengeJob(w.pid,slug,'self-match');
 assert.equal(study.brief_md,c.challenge.tracks[0].studies[0]);assert.ok((await taskForJob(w.pid,slug,study)).topic_ids.includes('self-match.study-1'));
 const endorse={supported_scopes:[{scope_key:s.key,scope_sha256:scopeHash(s)}]};
 await j1.submit({type:'review',return_id:claim.return_id,verdict:'accept',rung:'measured',notes_md:'Exact scoped answer.',research_assessment:endorse});
 assert.deepEqual([...await settledTopics(w.pid,slug,['self-match.study-1'])],[]);
 await j2.submit({type:'review',return_id:claim.return_id,verdict:'accept',rung:'measured',notes_md:'Same exact scientific scope.',research_assessment:endorse});
 assert.deepEqual([...await settledTopics(w.pid,slug,['self-match.study-1'])],['self-match.study-1']);
 await w.q("UPDATE jobs SET status='returned' WHERE problem_id=$1 AND origin_key LIKE 'challenge:%'",[w.pid]);
 await challengeJob(w.pid,slug,'self-match');study=await challengeJob(w.pid,slug,'self-match');assert.notEqual(study.brief_md,c.challenge.tracks[0].studies[0]);
});

test('idempotent startup migration preserves populated decisions, scoped metadata and associations',async()=>{
 const {migrate}=await import('../src/db/index.ts');
 const w=await lab.project('schema-residue',23);config(w);const a=await w.actor('a','gpt-6-astra');
 const ret=await a.submit({type:'direction',research_evidence:evidence});
 const {saveResearchLinks}=await import('../src/lib/shared-research.ts');const link={subject_return_id:ret.return_id,topic_id:'self-match.study-2',relation:'bears_on',rationale_md:'An exact association with authentic producing provenance.'};
 await saveResearchLinks(w.pid,{returnId:ret.return_id},[link]);await saveResearchLinks(w.pid,{returnId:ret.return_id},[link]);
 const before=await w.read(`/return/${ret.return_id}`);assert.equal(before.research_links.length,1);
 await migrate();await migrate();const after=await w.read(`/return/${ret.return_id}`);
 assert.deepEqual(after.research_evidence,before.research_evidence);assert.deepEqual(after.research_links,before.research_links);assert.equal(after.status,before.status);
});
test('association provenance brings another reviewed return and its corrections into context and certificates without adding proof premises',async()=>{
 const w=await lab.project('association-provenance',31);config(w);const a=await w.actor('a','gpt-6-astra'),j=await w.actor('j','claude-fable-5-1',{trusted:true});
 const route=await a.submit({type:'direction',research:proposal('Old claim gate')});
 const later=await a.submit({type:'direction',research_evidence:evidence});
 await j.submit({type:'review',return_id:later.return_id,verdict:'accept',rung:'measured',notes_md:'This later report carries a correction to the associated older gate.',research_assessment:{corrections_md:'The inherited CV extension remains unsupported.'},research_links:[{subject_return_id:route.return_id,route_id:route.research.route_id,relation:'contradicts',rationale_md:'Correction bears on the original gate, not a new premise.'}]});
 const {researchContext}=await import('../src/lib/shared-research.ts');const {stepInputVector}=await import('../src/lib/research.ts');
 const ctx=await researchContext(w.pid,w.base.split('/').at(-1),{research_route_id:route.research.route_id});
 assert.ok(ctx.items.some(i=>i.id===later.return_id&&i.reviews.some(r=>r.research_assessment?.corrections_md.includes('CV extension'))));
 const before=await stepInputVector(w.pid,route.research.route_id);
 await w.q("UPDATE reviews SET needs_reassessment=true WHERE return_id=$1",[later.return_id]);
 assert.notDeepEqual(await stepInputVector(w.pid,route.research.route_id),before);
 assert.equal((await w.one('SELECT count(*)::int AS n FROM return_dependencies WHERE return_id=$1 AND depends_on_id=$2',[route.return_id,later.return_id])).n,0);
});


test('identical scoped patches fold while distinct scientific scopes and legacy patches retain separate identities',async()=>{
 const w=await lab.project('scoped-duplicate',11);config(w);
 const a=await w.actor('a','gpt-6-astra'),j1=await w.actor('j1','claude-fable-5-1',{trusted:true}),j2=await w.actor('j2','gpt-6-astra',{trusted:true});
 const body={type:'direction',report_md:'Same exact scoped patch and evidence.',patch:'diff --git a/gate.py b/gate.py\n--- a/gate.py\n+++ b/gate.py\n@@ -1 +1 @@\n-x=0\n+x=1\n',research_evidence:evidence};
 const first=await a.submit(body),pending=await a.submit(body);
 assert.equal(Number((await w.read(`/return/${pending.return_id}`)).duplicate_of),first.return_id);
 for(const j of [j1,j2])await j.submit({type:'review',return_id:first.return_id,verdict:'accept',rung:'measured',research_assessment:assessment,notes_md:'Exact controlled scoped patch.'});
 assert.equal((await w.read(`/return/${first.return_id}`)).status,'accepted');
 const replay=await a.submit(body);assert.equal(replay.status,'superseded');assert.equal(replay.superseded_by,first.return_id);
 const changed=await a.submit({...body,research_evidence:{...evidence,scopes:[{...scope,domain_md:'Distinct IV and candidate set.'}]}});
 assert.equal((await w.read(`/return/${changed.return_id}`)).duplicate_of,null);
 const legacy=await a.submit({...body,research_evidence:undefined});assert.equal((await w.read(`/return/${legacy.return_id}`)).duplicate_of,null);
 const legacyReplay=await a.submit({...body,research_evidence:undefined});assert.equal(Number((await w.read(`/return/${legacyReplay.return_id}`)).duplicate_of),legacy.return_id);
});
