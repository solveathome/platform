import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseResearch, nextStep} from '../src/lib/research-format.ts';
import {parseVerificationPlan, fingerprint, judgmentBudget, parseCheckBlocker, isCompletedCheck} from '../src/lib/verification.ts';
import {researchPolicy, portfolioOrder} from '../src/lib/scheduler.ts';
import {routeFilesMd} from '../src/lib/research.ts';

const step = {question:'Does the bound survive?',method:'Inspect the smallest case.',success:'Bound holds there.',failure:'A witness violates the bound.',budget_hours:0.5};
const proposal = {outcome:'proposed',proposal:{title:'Test route',contribution_md:'Would remove an obstacle.',prior_art_md:'The known result needs a stronger hypothesis.',uncertainty_md:'Whether the weaker assumption suffices.'},evidence_md:'A specific implication to test.',next_step:step};
const plan = {schema_version:1,manifest:[{path:'check.py',sha256:'a'.repeat(64),role:'checker'},{path:'input.json',sha256:'b'.repeat(64),role:'target'}],targets:['input.json'],coverage_md:'Every supplied record.',comparison:'Exact integer equality.',availability:{status:'complete',details:'All bytes in manifest.',network:false,required_sources:[]},claim:'The finite count is four.',scope:'The supplied finite set.',assumptions:'Exact integer arithmetic.',checker:'a'.repeat(64),inputs:['b'.repeat(64)],environment:'Python 3.12, input.json is the listed input.',command:'python check.py input.json',expected:'4',supports:'Counts every member of the declared set.',coverage:'decisive',cost:{minutes:1,cpu_hours:0.01,ram_gb:1}};

test('route reports require actionable experiments and scoped negative evidence',()=>{
  assert.equal(parseResearch(proposal).next_step.compute.cpu_hours,0);
  assert.throws(()=>parseResearch({...proposal,next_step:undefined}),/next_step/);
  assert.throws(()=>parseResearch({route_id:1,outcome:'blocked',evidence_md:'Failed'}),/obstacle/);
  assert.throws(()=>nextStep({...step,budget_hours:Infinity}),/budget_hours/);
  assert.throws(()=>nextStep({...step,required_tools:['anything OR true']}),/identifiers/);
  assert.throws(()=>parseResearch({...proposal,depends_on:[0]}),/ids/);
});
test('known work requires a prior-art account and cannot schedule another experiment',()=>{
  const known={route_id:1,outcome:'known',evidence_md:'The cited result covers the proposed finite range.',prior_art_md:'Searched the original source; table 2 already covers this range.'};
  assert.equal(parseResearch(known).prior_art_md,known.prior_art_md);
  assert.throws(()=>parseResearch({...known,prior_art_md:undefined}),/known requires prior_art_md/);
  assert.throws(()=>parseResearch({...known,next_step:step}),/without next_step/);
  assert.throws(()=>parseResearch({...known,obstacle:{}}),/without next_step or obstacle/);
  assert.throws(()=>parseResearch({...proposal,prior_art_md:'Ambiguous second search account.'}),/proposal.prior_art_md/);
});
test('verification reuse binds the claim, scope and executable artifacts; rebudgeting cannot change evidence',()=>{
  const original=parseVerificationPlan(plan), f=fingerprint(original);
  for(const field of ['claim','scope','assumptions','checker','inputs','environment','command','expected','supports','coverage','coverage_md','comparison','manifest','targets','availability']) {
    const replacement=field==='checker'?'c'.repeat(64):field==='inputs'?['d'.repeat(64)]:field==='coverage'?'sample':'Changed text';
    assert.notEqual(fingerprint({...original,[field]:replacement}),f,field);
  }
  assert.equal(fingerprint({...original,cost:{...original.cost,minutes:20}}),f);
  assert.throws(()=>parseVerificationPlan({...plan,cost:{...plan.cost,minutes:NaN}}),/cost.minutes/);
  assert.throws(()=>parseVerificationPlan({...plan,inputs:['https://mutable.example/input']}),/sha256/);
  assert.equal(judgmentBudget(original),0.25);
  assert.equal(judgmentBudget(),0.5);
});
test('scientific judgment has its own budget regardless of execution runtime',()=>{
  const original=parseVerificationPlan(plan), slow=parseVerificationPlan({...plan,cost:{...plan.cost,minutes:180}});
  assert.equal(judgmentBudget(slow),0.25);
  const deeper=parseVerificationPlan({...plan,cost:{...plan.cost,judgment_minutes:60}});
  assert.equal(judgmentBudget(deeper),1);
  assert.equal(fingerprint(deeper),fingerprint(original));
  assert.throws(()=>parseVerificationPlan({...plan,cost:{...plan.cost,judgment_minutes:0}}),/judgment_minutes/);
});
test('unable receipts require targeted capabilities to retry and never count as completed checks',()=>{
  assert.equal(parseCheckBlocker(undefined),null);
  assert.deepEqual(parseCheckBlocker({kind:'capability',required_tools:['python3']}),{kind:'capability',required_tools:['python3'],required_sources:[]});
  assert.equal(parseCheckBlocker({kind:'package'}).kind,'package');
  assert.throws(()=>parseCheckBlocker({kind:'capability'}),/missing tools or sources/);
  assert.throws(()=>parseCheckBlocker({kind:'capability',required_sources:['invalid source']}),/identifiers/);
  const run={independent:true,receipt_status:'recorded',outcome:'unable'};
  assert.equal(isCompletedCheck(run),false);
  assert.equal(isCompletedCheck({...run,outcome:'fail'}),true);
  assert.equal(isCompletedCheck({...run,outcome:'pass'}),true);
  assert.equal(isCompletedCheck({...run,outcome:'pass',independent:false}),false);
  assert.equal(isCompletedCheck({...run,outcome:'pass',receipt_status:'rejected'}),false);
});
test('verification manifests reject missing targets, unsafe paths and undeclared files',()=>{
  assert.throws(()=>parseVerificationPlan({...plan,targets:['missing.json']}),/targets/);
  assert.throws(()=>parseVerificationPlan({...plan,manifest:[{...plan.manifest[0],path:'../escape.py'},plan.manifest[1]]}),/relative paths/);
  assert.throws(()=>parseVerificationPlan({...plan,inputs:['c'.repeat(64)]}),/included/);
  assert.throws(()=>parseVerificationPlan({...plan,coverage_md:undefined}),/coverage_md/);
});
test('exact expected output retains whitespace in storage and package identity',()=>{
  const exact=parseVerificationPlan({...plan,expected:' 4\n'});
  assert.equal(exact.expected,' 4\n');
  assert.notEqual(fingerprint(exact),fingerprint(parseVerificationPlan({...plan,expected:'4'})));
});
test('research allocation is explicit, complete and retains a protected supply of fresh ideas',()=>{
  const policy=researchPolicy('no-project',{discover:.3,pursue:.4,rescue:.15,consolidate:.15});
  assert.throws(()=>researchPolicy('no-project',{discover:.3,pursue:.8,rescue:0,consolidate:0}),/summing/);
  assert.equal(researchPolicy('no-project'),null);
  assert.equal(portfolioOrder(policy,{total:20,discover:0,pursue:14,rescue:3,consolidate:3})[0],'discover');
});

// Issue #73: /result refused on the first missing field, so a five-field object took five rejected submissions to discover,
// each re-uploading about a megabyte of transcript. The rendered route page calls these "Next experiment", "Continue if" and
// "Stop this attempt if", which are reasonable names to guess and are not the API's.
test('issue #73: a malformed next_step names every problem at once and the shape that is accepted', () => {
  const ask = (next_step) => {
    try { parseResearch({route_id: 8, outcome: 'promising', evidence_md: 'The measurement moved the route.', next_step}); return null; }
    catch (error) { return String(error.message); }
  };
  const guessed = ask({experiment: 'run it', continue_if: 'it holds', stop_if: 'it does not', budget_hours: 0.5});
  assert.match(guessed, /next_step\.question/); assert.match(guessed, /next_step\.method/);
  assert.match(guessed, /next_step\.success/); assert.match(guessed, /next_step\.failure/);
  assert.match(guessed, /The accepted shape is next_step: \{"question"/, 'the skeleton is in the refusal, not only in the brief');
  assert.doesNotMatch(guessed, /budget_hours must be/, 'a field that was supplied correctly is not listed as a problem');
  assert.match(ask('a sentence'), /research\.next_step must be an object/);
  const ok = parseResearch({route_id: 8, outcome: 'promising', evidence_md: 'The measurement moved the route.',
    next_step: {question: 'Does the certificate grow?', method: 'Exact counts at 14 levels.', success: 'It grows.', failure: 'It reaches zero.', budget_hours: 0.5}});
  assert.equal(ok.next_step.question, 'Does the certificate grow?');
  assert.deepEqual(ok.next_step.compute, {cpu_hours: 0, ram_gb: 2, disk_gb: 1}, 'the optional parts keep their defaults');
});

test('issue #73: an obstacle reports its whole shape too', () => {
  let message = '';
  try { parseResearch({route_id: 8, outcome: 'blocked', evidence_md: 'The attempt failed.', obstacle: {kind: 'attempt_failed'}}); }
  catch (error) { message = String(error.message); }
  assert.match(message, /obstacle\.statement/); assert.match(message, /obstacle\.assumptions/);
  assert.match(message, /obstacle\.evidence/); assert.match(message, /obstacle\.revisit_when/);
  assert.match(message, /The accepted shape is obstacle: \{"kind"/);
});

test('a route brief lists the latest returns\' files and points to the route record for the rest',()=>{
  assert.equal(routeFilesMd([],59),'- none');
  const one=routeFilesMd([{return_id:1075,names:['falsifier1676.py','shuffle1676.py']}],59);
  assert.equal(one,'- Return #1075: falsifier1676.py, shuffle1676.py');
  const many=Array.from({length:30},(_,i)=>({return_id:1000+i,names:Array.from({length:25},(_,k)=>`f${k}.py`)}));
  const md=routeFilesMd(many,90).split('\n');
  assert.equal(md.length,13);assert.match(md[0],/^- Return #1018: /);assert.match(md[11],/^- Return #1029: .*, and 5 more$/);
  assert.match(md[12],/Files of 18 earlier returns: the `files` field of GET <project base>\/research-routes\/90/);
});
