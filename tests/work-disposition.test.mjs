import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseResearchTask} from '../src/lib/shared-research-format.ts';
import {parseKnownWork,parseWorkDisposition,workScopeHash,legacyCoverageEligible} from '../src/lib/work-disposition-format.ts';
import {materialEvidence,evidenceDelta} from '../src/lib/work-evidence.ts';
import {taskMarkdown} from '../src/lib/shared-research-format.ts';
const task=parseResearchTask({intent:'new',topic_ids:['all-zeros.study-1'],predecessor_returns:[1],unresolved_obligation_md:'Compare identical streams with lazy three-word observation.',changed_premise_md:'Same full-MD5 stream, new observer.',expected_evidence_md:'Paired decisions and output identity.',stop_if_md:'Already tested under these controls.',domain_md:'Four lanes, RFC IV, M12; throughput only.'});
test('coverage fingerprint distinguishes experiment, domain and changed premise; citations and intent grant no broader authority',()=>{
 assert.equal(workScopeHash(task),workScopeHash({...task,predecessor_returns:[2],intent:'replication'}));
 for(const field of ['unresolved_obligation_md','domain_md','changed_premise_md'])assert.notEqual(workScopeHash(task),workScopeHash({...task,[field]:task[field]+' changed'}));
 assert.notEqual(workScopeHash(task),workScopeHash({...task,topic_ids:['all-zeros.methods']}));
});
const rows=()=>({returns:[{id:1,status:'pending',provisional:false,report_md:'A scoped finite result.',research_evidence:{scopes:[],topic_ids:['study']}}],reviews:[{id:10,return_id:1,user_id:2,model:'model-a',trusted:true,verdict:'accept',rung:'heuristic',notes_md:'Finite scope only.',research_assessment:null}],history:[],findings:[],artifacts:[],messages:[]});
test('material evidence ignores metadata, nomination defaults, JSONB ordering and identical re-archives',()=>{
 const original=rows(),changed=structuredClone(original),before=materialEvidence(original);
 changed.returns[0]={...changed.returns[0],status:'recorded',final_rung:'recorded',cites:{returns:[8]},research_evidence:{topic_ids:['study'],scopes:[]}};
 const r=changed.reviews[0];Object.assign(r,{id:11,tokens:{output:999},transcript:'Different administrative log.',created_at:'later',research_assessment:{schema:'research-assessment-v1',supported_scopes:[],corrections_md:'',next_test_md:'',reopen_when_md:'',unsupported_extension_md:'',work_check:{predecessor_returns:[1]}}});
 changed.history.push({id:90,archived_at:'later',review:original.reviews[0]},{id:91,archived_at:'later again',review:original.reviews[0]});
 assert.equal(before.sha256,materialEvidence(changed).sha256);assert.deepEqual(evidenceDelta(before,materialEvidence(changed)),[]);
});
test('material evidence detects real corrections, independent authority, artifacts and changed accounting',()=>{
 const original=rows(),before=materialEvidence(original);
 for(const mutate of [r=>r.returns[0].report_md+=' A corrected bound.',r=>r.reviews[0].notes_md='A counterexample changes this scope.',r=>r.reviews[0].trusted=false,r=>r.reviews[0].research_assessment={comparison_checks:[{budget_complete:false}]},r=>r.artifacts.push({ref_id:1,file_sha:'b'.repeat(64)}),r=>r.reviews.push({...r.reviews[0],id:12,user_id:3,model:'model-b'})]) {
  const changed=rows();mutate(changed);const after=materialEvidence(changed);assert.notEqual(before.sha256,after.sha256);assert.ok(evidenceDelta(before,after).length);
 }
});
test('reordering set-like scope metadata is bookkeeping; changing a comparison assumption is material',()=>{
 const original=rows();original.returns[0].research_evidence={topic_ids:['a','b'],scopes:[{key:'x',assumptions_md:'A fixed corpus.',artifact_sha256:['a','b']},{key:'y',assumptions_md:'Another corpus.',artifact_sha256:[]}]};
 original.reviews[0].research_assessment={supported_scopes:[{scope_key:'x'},{scope_key:'y'}],comparison_checks:[{scope_key:'x',budget_complete:true},{scope_key:'y',budget_complete:false}]};
 const changed=structuredClone(original),e=changed.returns[0].research_evidence,a=changed.reviews[0].research_assessment;e.topic_ids.reverse();e.scopes.reverse();e.scopes[1].artifact_sha256.reverse();a.supported_scopes.reverse();a.comparison_checks.reverse();
 assert.equal(materialEvidence(original).sha256,materialEvidence(changed).sha256);a.comparison_checks[0].budget_complete=true;assert.notEqual(materialEvidence(original).sha256,materialEvidence(changed).sha256);
});
test('legacy triage structural eligibility excludes science and accepts source-only packages without granting authority',()=>{
 const r={status:'pending',type:'explore',cpu_hours:0};assert.equal(legacyCoverageEligible(r),true);
 for(const change of [{cpu_hours:1},{research_evidence:{}},{verification_plan:{}},{type:'paper'},{status:'accepted'},{patch:'a change'},{target:{kind:'return'}}])assert.equal(legacyCoverageEligible({...r,...change}),false);
});
test('experiment contracts preserve explicit contribution, prospective criterion, replication goal and fair controls',()=>{
 const t=parseResearchTask({...task,intent:'replication',contribution_md:'Test portability of the inherited gate on an independent compiler.',decision_criterion_md:'No disagreement in the preregistered corpus; timing uncertainty is reported separately.',replication_objective_md:'Independent compiler and hardware correctness validation.',comparison_plan_md:'Matched streams and optimized observer baseline, complete costs and paired intervals.'});
 const brief=taskMarkdown(t);for(const value of [t.contribution_md,t.decision_criterion_md,t.replication_objective_md,t.comparison_plan_md])assert.ok(brief.includes(value));
 assert.match(taskMarkdown({...task,predecessor_returns:[]}),/does not establish novelty/);assert.match(taskMarkdown(task),/context delivery alone does not prove reuse/);
 assert.throws(()=>parseResearchTask({...task,decision_criterion_md:''}));
});
test('compact stop requires explicit real source locators and reopening condition',()=>{
 assert.throws(()=>parseKnownWork({predecessor_returns:[],comparison_md:'Known.',reopen_when_md:'New premise.'}));
 const parsed=parseKnownWork({predecessor_returns:[1,1],review_ids:[2],message_ids:[3],comparison_md:'Exact prior paired test.',reopen_when_md:'Different observer.',task});
 assert.deepEqual(parsed.predecessor_returns,[1]);assert.equal(parsed.task.domain_md,task.domain_md);
 assert.throws(()=>parseWorkDisposition({decision:'accepted'}));
 assert.equal(parseWorkDisposition({decision:'covered',scope_sha256:workScopeHash(task),input_sha256:'a'.repeat(64),rationale_md:'Same test.',reopen_when_md:'Changed stream.'}).decision,'covered');
});
