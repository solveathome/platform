import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseProgress,PORTABLE_PROGRESS_GUIDANCE,PORTABLE_PROPOSAL_BONUS,PORTABLE_REVIEW_BONUS,nextStepHash} from '../src/lib/research-progress.ts';
import {nextStep} from '../src/lib/research-format.ts';
import {parseResearchTask,parseResearchAssessment,taskMarkdown} from '../src/lib/shared-research-format.ts';
import {materialEvidence} from '../src/lib/work-evidence.ts';
const step={question:'Can the bound be strengthened?',method:'Derive and test a sound constraint.',success:'A stronger sound constraint.',failure:'A counterexample.',budget_hours:0.5};
const progress={kind:'algorithmic',rationale_md:'Fewer evaluations with the same legal domain.'};
test('explicit progress metadata is bounded and legacy next steps retain their shape',()=>{
 assert.equal('progress' in nextStep(step),false);
 assert.deepEqual(nextStep({...step,progress}).progress,progress);
 assert.deepEqual(parseProgress({...progress,bonus:1e9,priority:99,trusted:true}),progress);
 assert.equal(PORTABLE_PROPOSAL_BONUS,8);assert.equal(PORTABLE_REVIEW_BONUS,12);
 assert.throws(()=>nextStep({...step,progress:{kind:'GPU'}}),/progress needs/);
 assert.throws(()=>parseProgress({...progress,rationale_md:''}),/progress needs/);
});
test('device facts and portable contribution remain separate in generic briefs and review metadata',()=>{
 const task=parseResearchTask({intent:'new',unresolved_obligation_md:'Count fewer operations.',expected_evidence_md:'Sound bound.',stop_if_md:'Bound refuted.',domain_md:'Specified mathematical domain.',progress:{kind:'device_benchmark',rationale_md:'Timing on the named device only.'},comparison_plan_md:'Recorded device A, compiler B and matched corpus.'});
 const md=taskMarkdown(task);assert.match(md,/device_benchmark/);assert.match(md,/device A, compiler B/);assert.match(md,/not scientific acceptance/);
 const assessment=parseResearchAssessment({next_step_progress:{...progress,report_sha256:'a'.repeat(64),next_step_sha256:nextStepHash(step),next_step:{forged:true}}});assert.equal(assessment.next_step_progress.next_step,undefined);
 assert.match(PORTABLE_PROGRESS_GUIDANCE,/fewer operations or trials/);assert.match(PORTABLE_PROGRESS_GUIDANCE,/Do not require everyone to own reference hardware/);assert.doesNotMatch(PORTABLE_PROGRESS_GUIDANCE,/MD5|Twin Prime|CUDA/);
});
test('classification alone does not invalidate covered scientific evidence',()=>{
 const rows={returns:[{id:1,status:'recorded',report_md:'A scoped result.',research:{outcome:'progress',next_step:step}}],reviews:[{id:2,return_id:1,user_id:3,model:'m',verdict:'accept',rung:'measured',trusted:true,research_assessment:{}}],history:[],findings:[],artifacts:[],messages:[]};
 const before=materialEvidence(rows).sha256;
 rows.returns[0].research.next_step={...step,progress};rows.reviews[0].research_assessment={next_step_progress:{...progress,report_sha256:'a'.repeat(64)}};
 assert.equal(materialEvidence(rows).sha256,before);
 rows.returns[0].research.next_step.method='A genuinely different construction.';assert.notEqual(materialEvidence(rows).sha256,before);
});
