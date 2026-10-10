import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {optionalResearch,parseResearchEvidence,parseResearchAssessment,scopeHash,parseResearchLinks,parseResearchTask} from '../src/lib/shared-research-format.ts';
import {researchAuthority,contextMarkdown,boundResearchContext} from '../src/lib/shared-research.ts';
const scope={key:'cache-t8',statement_md:'Matched cache baseline improved throughput by 1.256539x.',domain_md:'Full MD5; 32 ASCII hex bytes; same candidate set, warmed caches.',kind:'throughput',assumptions_md:'Same implementation and hardware.',artifact_sha256:[],transfer_conditions_md:'No output bias or numerical record follows.'};
const evidence=parseResearchEvidence({topic_ids:['self-match.methods'],scopes:[scope]});
const vote=(id,family,trusted=true)=>({id,family,trusted,tier1:true,weight:1,provider:family,verdict:'accept',rung:'measured',research_assessment:{supported_scopes:[{scope_key:scope.key,scope_sha256:scopeHash(scope)}]}});
test('scope authority preserves quorum, source status, exact version and numerical-verifier boundary',()=>{
 const item={status:'accepted',provisional:false,research_evidence:evidence};
 assert.equal(researchAuthority(item,[vote(1,'openai')],2).scopes[0].research_status,'pending scoped endorsement');
 assert.equal(researchAuthority(item,[vote(1,'openai'),vote(2,'openai')],2).scopes[0].research_status,'pending scoped endorsement');
 assert.equal(researchAuthority(item,[vote(1,'openai'),vote(2,'anthropic')],2).scopes[0].research_status,'accepted');
 for(const extra of [{status:'pending'},{provisional:true},{lean_current:false},{decision_by:'verifier'},{verification_plan:{lean:{policy:'lean-kernel-v1'}}}])assert.notEqual(researchAuthority({...item,...extra},[vote(1,'openai'),vote(2,'anthropic')],2).scopes[0].research_status,'accepted');
 assert.equal(researchAuthority({...item,decision_by:'verifier'},[],2).witness_status,'verified input');
 assert.notEqual(researchAuthority({...item,research_evidence:parseResearchEvidence({topic_ids:[],scopes:[{...scope,domain_md:'Different IV'}]})},[vote(1,'openai'),vote(2,'anthropic')],2).scopes[0].research_status,'accepted');
 assert.notEqual(researchAuthority(item,[{...vote(1,'openai'),archived:true}],1).scopes[0].research_status,'accepted');
});
test('scope hashes are canonical, domain-specific and optional defects warn without refusing core research',()=>{
 assert.equal(scopeHash(scope),scopeHash({...scope,ignored:'discarded'}));
 assert.notEqual(scopeHash(scope),scopeHash({...scope,assumptions_md:'Different assumption'}));
 assert.equal(optionalResearch('research_evidence',{scopes:[{}]},parseResearchEvidence).value,null);
 assert.match(optionalResearch('research_evidence',{scopes:[{}]},parseResearchEvidence).warnings[0],/still receivable/);
 assert.throws(()=>parseResearchEvidence({scopes:[scope,scope]}));
 assert.throws(()=>parseResearchLinks([{subject_return_id:1,relation:'addresses',rationale_md:'X'}]));
 assert.equal(parseResearchAssessment({corrections_md:'CV conditioning invalidates the extension.'}).supported_scopes.length,0);
 assert.equal(parseResearchTask({intent:'replication',topic_ids:[],predecessor_returns:[3],unresolved_obligation_md:'Independent implementation',changed_premise_md:'Different implementation',expected_evidence_md:'Matched result',stop_if_md:'Difference resolved',domain_md:'Same finite set'}).intent,'replication');
});
test('brief preserves complete math or an explicit full-record locator and puts corrections beside claims',()=>{
 const ctx={items:[{id:1,status:'pending',handle:'a',model:'x',relevant_by:'topic evidence',scopes:[{...scope,scope_sha256:scopeHash(scope),research_status:'pending scoped endorsement',statement_md:'forall n > 1000, '+ 'exact '.repeat(1000)}],reviews:[{id:7,trusted:true,verdict:'reject',notes_md:'The multiblock extension does not follow; condition on CV.'}],files:[],report_md:'',research_evidence:evidence}],jobs:[],findings:[],omitted:true};
 const md=contextMarkdown(ctx,'https://example.org/projects/x',200);
 assert.match(md,/Complete scope\/correction exceeds/);assert.doesNotMatch(md,/forall n > 1000, exact/);
 assert.match(md,/condition on CV/);assert.match(md,/Additional potentially relevant results/);
});
test('both adapters retain distinct scientific goals and all seven open secondary obligations',()=>{
 const md5=JSON.parse(readFileSync(new URL('../projects/md5/project.json',import.meta.url)));
 const twin=JSON.parse(readFileSync(new URL('../projects/twin-primes/project.json',import.meta.url)));
 assert.equal(md5.review_quorum,2);assert.equal(md5.research_collaboration.topics.filter(t=>t.study).length,9);
 assert.equal(twin.research_collaboration.topics.filter(t=>/^O[1-7]$/.test(t.claim_id)).length,7);
 assert.equal(twin.lean_main_theorems[0].unproved_claims.length,7);
 assert.match(twin.research_collaboration.topics.find(t=>t.claim_id==='O3').domain_md,/A=12/);
 assert.match(twin.research_collaboration.topics[0].domain_md,/not twin-prime infinitude/);
});

test('public context bounds prose and preserves exact versions, corrections and locators without worker bindings',()=>{
 const sha=scopeHash(scope),long='forall n, '+ 'complete '.repeat(5000);
 const ctx={items:[{id:5,status:'accepted',decision_by:'trusted',research_evidence:evidence,scopes:[{...scope,statement_md:long,scope_sha256:sha,research_status:'accepted'}],report_md:long,research:null,verification_plan:null,reviews:[{id:8,notes_md:'Matched baseline correction.',research_assessment:{corrections_md:'Hold CV fixed.'}}]}],findings:[],jobs:[],input_vector:{},omitted:false};
 const bounded=boundResearchContext(ctx,300);assert.equal(bounded.items[0].scopes[0].scope_sha256,sha);assert.match(bounded.items[0].scopes[0].statement_md,/Complete text at GET/);assert.doesNotMatch(bounded.items[0].scopes[0].statement_md,/forall n/);assert.equal(bounded.items[0].reviews[0].research_assessment.corrections_md,'Hold CV fixed.');assert.ok(JSON.stringify(bounded).length<3000);
});
