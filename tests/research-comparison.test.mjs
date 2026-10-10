import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseComparisonCheck,comparisonProblems,reportHash,optionalResearch,parseResearchAssessment} from '../src/lib/shared-research-format.ts';
const hash=reportHash('A synthetic comparison report.');
const check=(extra={})=>({report_sha256:hash,kind:'hit_rate',method:{unit:'digest_output',observations:20000,successes:1276,work_budget_md:'All preprocessing, solve/inverse steps, complete MD5 and verification charged.'},baseline:{unit:'digest_output',observations:160000,successes:9800,work_budget_md:'All generation, complete MD5 and verification charged.'},selection_stopping_md:'Fixed samples, same selected output event; dependence must be inspected.',baseline_equivalence_md:'Same full-MD5 domain and target event, with declared controls.',uncertainty_md:'Unequal samples are normalized with their actual denominators; no rare-event conclusion from zero hits.',budget_complete:true,baseline_equivalent:true,uncertainty_adequate:true,...extra});
test('terminal-only iterative histogram and uncharged 60-step solve cannot endorse the claimed comparison',()=>{
 const flawed=parseComparisonCheck(check({method:{unit:'final_iterate',observations:20000,successes:1276,work_budget_md:'160000 hashlib calls; the additional 60 MD5 steps per iteration used to solve M4 are omitted.'},budget_complete:false}));
 assert.deepEqual(comparisonProblems(flawed,hash),['different counted observation units','incomplete full work budget']);
 assert.notEqual(1276/20000,1276/160000,'a nominal work budget is not the terminal sample denominator');
});
test('unequal sample sizes remain valid declarations when units, controls, work and uncertainty are matched',()=>{
 const c=parseComparisonCheck(check());assert.equal(c.method.observations,20000);assert.equal(c.baseline.observations,160000);assert.deepEqual(comparisonProblems(c,hash),[]);
 assert.deepEqual(comparisonProblems(c,reportHash('Changed report.')),['stale report hash']);
});
test('comparison metadata requires explicit denominators, selection, complete budgets and uncertainty declarations',()=>{
 for(const field of ['selection_stopping_md','baseline_equivalence_md','uncertainty_md','budget_complete'])assert.throws(()=>parseComparisonCheck(check({[field]:undefined})));
 for(const successes of [-1,20001,undefined])assert.throws(()=>parseComparisonCheck(check({method:{...check().method,successes}})));
 assert.throws(()=>parseComparisonCheck(check({scope_key:'ratio'})));
 const invalid=optionalResearch('research_assessment',{comparison_checks:[check({uncertainty_md:undefined})]},parseResearchAssessment);assert.equal(invalid.value,null);assert.match(invalid.warnings[0],/still receivable/);
 assert.deepEqual(parseResearchAssessment({}).supported_scopes,[],'unrelated reviews have no mandatory benchmark fields');
});
