import assert from 'node:assert/strict';
import {proposal,step,obstacle} from './harness.mjs';
const advance=(id,label,depends_on)=>({research:{route_id:id,outcome:'progress',evidence_md:`Bounded progress: ${label}.`,next_step:step(label),...(depends_on?{depends_on}:{})}});

export async function transitiveEvidence(w) {
  const a=await w.actor('a','claude-opus-5'),b=await w.actor('b','claude-sonnet-5');
  const c=await w.actor('c','claude-haiku-4-5'),judge=await w.actor('judge','claude-fable-5-1',{trusted:true});
  const ar=await a.submit({type:'direction',research:proposal('A')});
  await w.take(a,j=>j.research_stage==='probe');const first=await a.submit(advance(ar.research.route_id,'A1'));
  await w.take(a,j=>j.research_stage==='pursue');const derived=await a.submit(advance(ar.research.route_id,'A2'));
  await w.take(a,j=>j.research_stage==='pursue');
  const br=await b.submit({type:'direction',research:{...proposal('B'),depends_on:[derived.return_id]}});
  await w.take(b,j=>j.research_stage==='probe');const bEvidence=await b.submit(advance(br.research.route_id,'B1'));
  await w.take(b,j=>j.research_stage==='pursue');
  const cr=await c.submit({type:'direction',research:{...proposal('C'),depends_on:[bEvidence.return_id]}});
  await w.take(c,j=>j.research_stage==='probe');await c.submit(advance(cr.research.route_id,'C1'));
  await judge.submit({type:'review',return_id:first.return_id,verdict:'reject',reject_reason:'refuted',notes_md:'The initial premise fails.'});
  assert.deepEqual((await w.q('SELECT state FROM research_routes WHERE problem_id=$1 ORDER BY id',[w.pid])).map(r=>r.state),['blocked','blocked','blocked']);
  assert.equal((await w.one('SELECT count(*)::int AS n FROM return_dependencies WHERE return_id=$1',[bEvidence.return_id])).n,1);
  const before=await w.one("SELECT count(*)::int AS n FROM research_events WHERE outcome='dependency_changed' AND route_id=$1",[cr.research.route_id]);
  const {reconsiderDependents}=await import('../../src/lib/research.ts');
  await reconsiderDependents(first.return_id,'rejected');
  assert.equal((await w.one("SELECT count(*)::int AS n FROM research_events WHERE outcome='dependency_changed' AND route_id=$1",[cr.research.route_id])).n,before.n);
  w.record('expectations',{transitive_routes_flagged:3,duplicate_flags_suppressed:true});
}

export async function withdrawnReceipt(w) {
  const author=await w.actor('author','claude-opus-5'),worker=await w.actor('worker','claude-sonnet-5');
  const judge=await w.actor('judge','claude-fable-5-1',{trusted:true,share:0});
  const plan=await w.package(author);
  await author.start();const claim=await author.submit({request_review:true,verification_plan:plan});
  await w.take(worker,j=>j.type==='check');const receipt=await worker.submit(await w.execute(worker));
  await w.take(judge,j=>j.type==='review');await w.finish(judge);
  const route=await author.submit({type:'direction',research:{...proposal('Dependent'),depends_on:[claim.return_id]}});
  await w.take(author,j=>j.research_stage==='probe');await author.submit(advance(route.research.route_id,'Dependent1'));
  await judge.submit({type:'review',return_id:receipt.return_id,verdict:'reject',reject_reason:'refuted',notes_md:'Withdraw the execution observation.'});
  let subject=await w.read(`/return/${claim.return_id}`);
  assert.equal(subject.status,'pending');assert.equal(subject.verification_state.execution,'not_attempted');
  assert.equal((await w.read(`/research-routes/${route.research.route_id}`)).state,'blocked');
  assert.ok(subject.decisions.some(d=>d.status==='accepted'));assert.ok(subject.decisions.some(d=>d.by==='evidence'));
  const originalReview=Number(subject.reviews[0].id);
  const reviews=await w.q("SELECT * FROM jobs WHERE parent_return_id=$1 AND type='review' AND status='queued'",[claim.return_id]);
  assert.equal(reviews.length,1);assert.deepEqual(reviews[0].compute_hint,{});
  for(let i=0;i<12;i++){
    const j=await judge.start();if(j.type==='review'&&Number(j.parent_return_id)===claim.return_id)break;
    if(j.research_route_id)await judge.submit({research:{route_id:Number(j.research_route_id),outcome:'inconclusive',evidence_md:'The missing evidence remains unresolved.',obstacle:obstacle('unresolved')}});
    else await w.finish(judge);
  }
  assert.equal(judge.held.type,'review');
  await judge.submit({verdict:'reject',reject_reason:'unverifiable',notes_md:'The withdrawn evidence no longer supports the claim.'});
  subject=await w.read(`/return/${claim.return_id}`);assert.equal(subject.status,'rejected');assert.equal(subject.review_history.length,1);
  assert.equal(subject.review_history[0].review.verdict,'accept');
  assert.ok(subject.decisions.find(d=>d.status==='accepted').review_ids.includes(originalReview));
  const page=await fetch(w.origin+w.base+`/return/${claim.return_id}`,{headers:{accept:'text/html'}});
  assert.equal(page.status,200);assert.match(await page.text(),/Previous judgments/);
  assert.equal((await w.one("SELECT count(*)::int AS n FROM credits WHERE source_type='return' AND source_id=$1 AND kind='result'",[String(claim.return_id)])).n,1);
  w.record('expectations',{receipt_withdrawal_reassessed:true,original_reviewer_can_return:true,historical_judgment_preserved:true});
}

export async function waitingCheck(w) {
  const author=await w.actor('author','claude-opus-5'),worker=await w.actor('worker','claude-sonnet-5');
  const judge=await w.actor('judge','claude-fable-5-1',{trusted:true,share:0});
  const plan=await w.package(author);plan.cost.minutes=180;
  await author.start();const claim=await author.submit({request_review:true,verification_plan:plan});
  const extended=await worker.request('/start?share=25&time=4h',{launch:worker.launch,assignment:null});
  worker.session=extended.session;worker.held=extended;
  // Discovery is now reserved for this tier too; the long check remains eligible afterwards.
  if(extended.type!=='check'){await w.finish(worker);await w.take(worker,j=>j.type==='check');}
  const detail=await worker.request(`/job/${worker.held.job_id}`);assert.equal(Number(detail.budget_hours),3.1);
  worker.held.evidence_return_id=claim.return_id;
  await worker.submit(await w.unable(worker,'capability',['unavailable-runtime']));
  await w.fault('No suitable worker arrived for a day.',"UPDATE jobs SET created_at=now()-interval '25 hours' WHERE problem_id=$1 AND type='check' AND status='queued'",[w.pid]);
  await w.take(judge,j=>j.type==='review');
  assert.match(judge.held.brief_md,/within 24 hours/);
  const checks=await w.q("SELECT status,check_wait_expired_at FROM jobs WHERE problem_id=$1 AND type='check'",[w.pid]);
  assert.equal(checks.filter(j=>j.check_wait_expired_at).length,1);
  assert.equal((await w.read(`/return/${claim.return_id}`)).verification_state.execution,'unable');
  await judge.submit({verdict:'reject',reject_reason:'unverifiable',notes_md:'Capacity unavailable; claim remains unsupported.'});
  assert.equal((await w.q("SELECT id FROM jobs WHERE problem_id=$1 AND type='check' AND status='queued'",[w.pid])).length,0);
  w.record('expectations',{long_url_assignment_supported:true,waiting_check_escalated:true,no_invented_execution:true});
}

export async function duplicateClaims(w) {
  const author=await w.actor('author','claude-opus-5'),worker=await w.actor('worker','claude-sonnet-5');
  const judge=await w.actor('judge','claude-fable-5-1',{trusted:true});
  const plan=await w.package(author),publish=async()=>{await author.start();return author.submit({request_review:true,verification_plan:plan});};
  const first=await publish(),second=await publish();assert.equal(second.canonical_return_id,first.return_id);
  await w.take(worker,j=>j.type==='check');await worker.submit(await w.execute(worker));
  assert.equal((await w.one("SELECT count(*)::int AS n FROM jobs WHERE problem_id=$1 AND type='review'",[w.pid])).n,1);
  await w.take(judge,j=>j.type==='review');await w.finish(judge);
  const third=await publish();assert.equal(third.status,'superseded');
  for(const duplicate of [second,third]){const r=await w.read(`/return/${duplicate.return_id}`);assert.equal(r.status,'superseded');assert.equal(Number(r.canonical_return.id),first.return_id);}
  assert.equal((await w.one("SELECT count(*)::int AS n FROM credits WHERE problem_id=$1 AND kind='result'",[w.pid])).n,1);
  await judge.request('/result',{method:'POST',status:409,body:judge.body({type:'review',return_id:second.return_id,verdict:'accept',rung:'measured',verification_sufficiency_md:'Duplicate scope.'})});
  await judge.request(`/return/${second.return_id}/reopen`,{method:'POST',body:{note:'Reassess the shared claim.'}});
  assert.equal((await w.read(`/return/${first.return_id}`)).status,'pending');
  w.record('expectations',{identical_claims:3,judgments:1,result_payments:1,canonical_reopen:true});
}

export async function freshProbe(w) {
  const a=await w.actor('author','claude-opus-5');
  const old=await a.submit({type:'direction',research:proposal('Established')});
  await w.take(a,j=>j.research_stage==='probe');await a.submit(advance(old.research.route_id,'Established1'));
  const fresh=await a.submit({type:'direction',research:proposal('Fresh')});
  let seen=false,pursuits=0;
  for(let i=0;i<4;i++){
    const job=await w.take(a,j=>['probe','pursue'].includes(j.research_stage));
    if(job.research_stage==='probe'){assert.equal(Number(job.research_route_id),fresh.research.route_id);seen=true;break;}
    pursuits++;await a.submit(advance(old.research.route_id,`Established${i+2}`));
  }
  assert.ok(seen,'A fresh eligible lead must receive a probe after at most three pursuits.');
  await a.submit(advance(fresh.research.route_id,'Fresh1'));
  w.record('expectations',{pursuits_before_fresh_probe:pursuits});
}
export async function lateConflict(w) {
  const author=await w.actor('author','claude-opus-5'),worker=await w.actor('worker','claude-sonnet-5');
  const judge=await w.actor('judge','claude-fable-5-1',{trusted:true});
  const plan=await w.package(author);await author.start();
  const claim=await author.submit({request_review:true,verification_plan:plan});
  await w.take(worker,j=>j.type==='check');await worker.submit(await w.execute(worker));
  await w.take(judge,j=>j.type==='review');await w.finish(judge);
  await w.fault('A separately requested repeat can expose a contradiction after acceptance.',
    "INSERT INTO jobs (problem_id,type,title,brief_md,budget_hours,min_tier,evidence_return_id,research_stage) VALUES ($1,'check','Independent repeat','Run the same finite package.',0.1,99,$2,'consolidate')",[w.pid,claim.return_id]);
  await w.take(worker,j=>j.type==='check');
  const observed=await w.execute(worker);
  w.record('injected_fault',{description:'The second simulated worker reports a contradictory comparison.'});
  await worker.submit({check_receipt:{...observed.check_receipt,outcome:'fail',observed:'Injected contradictory comparison from a worker with a defective comparator.'}});
  let subject=await w.read(`/return/${claim.return_id}`);
  assert.equal(subject.status,'pending');assert.equal(subject.verification_state.unresolved_conflict,true);
  assert.equal((await w.one("SELECT count(*)::int AS n FROM jobs WHERE parent_return_id=$1 AND type='review' AND status='queued'",[claim.return_id])).n,1);
  await w.take(judge,j=>j.type==='review');
  const acceptance={verdict:'accept',rung:'measured',verification_sufficiency_md:'The full finite target was checked; no infinite claim.',verification_receipt_id:Number(subject.verification_runs.find(r=>r.outcome==='pass').id)};
  await judge.request('/result',{method:'POST',body:judge.body(acceptance),status:409});
  await judge.submit({...acceptance,verification_conflict_resolution_md:'The injected second comparator was defective. The first observed execution matches the finite definition; restrict the decision to that target.'});
  subject=await w.read(`/return/${claim.return_id}`);assert.equal(subject.status,'accepted');assert.equal(subject.verification_state.unresolved_conflict,false);
  assert.equal(subject.review_history.length,1);
  w.record('expectations',{late_conflict_reopens_claim:true,reconciliation_required:true});
}
export async function firstAcceptance(w) {
  const author=await w.actor('author','claude-opus-5'),judge=await w.actor('judge','claude-fable-5-1',{trusted:true});
  const route=await author.submit({type:'direction',research:proposal('Conditional research')});
  await w.take(author,j=>j.research_stage==='probe');
  const premise=await author.submit(advance(route.research.route_id,'First pursuit'));
  const before=await w.read(`/research-routes/${route.research.route_id}`);
  await judge.submit({type:'review',return_id:premise.return_id,verdict:'accept',rung:'measured',notes_md:'The scoped preliminary evidence holds.'});
  const after=await w.read(`/research-routes/${route.research.route_id}`);
  assert.equal(after.state,'active');assert.equal(after.revision,before.revision);
  assert.ok(after.jobs.some(j=>j.research_stage==='pursue'&&j.status==='queued'));
  w.record('expectations',{first_acceptance_preserves_pursuit:true});
}
export async function opusResearch(w) {
  const {researchAllocation}=await import('../../src/lib/scheduler.ts');
  const actors=await Promise.all(['a','b'].map(name=>w.actor(name,'claude-opus-5'))),author=actors[0];
  // Six actual submissions reproduce a contributor who has exhausted the pending-claim allowance.
  for(let i=0;i<6;i++)await author.submit({type:'direction',report_md:`Earlier unstructured claim ${i}; awaiting scientific judgment.`});
  await author.request('/result',{method:'POST',body:author.body({type:'direction'}),status:429});
  await author.request('/result',{method:'POST',body:author.body({type:'direction',research:proposal('Requires judgment'),request_review:true}),status:429});
  const initial=await author.submit({type:'direction',research:proposal('Opus tangent beyond the queue')});
  assert.equal(initial.status,'recorded');
  // A large eligible mechanical backlog must not consume all of Opus's discovery capacity.
  await w.fault('Initial backlog of inexpensive finite measurements.',
    "INSERT INTO jobs (problem_id,type,title,brief_md,budget_hours,min_tier,research_stage) SELECT $1,'measure','Finite measurement '||n,'Scripted finite task.',0.5,99,'consolidate' FROM generate_series(1,80) n",[w.pid]);
  const pursuits=new Map(),claims=[],discovered=[];
  for(let turn=0;turn<40;turn++) {
    const actor=actors[Math.floor(w.rng()*actors.length)],job=await actor.start(),routeId=Number(job.research_route_id);
    assert.equal(job.assignment_reason.policy,'research portfolio');
    assert.equal(job.assignment_reason.tier,2);
    assert.notEqual(job.type,'review');
    if(job.research_stage==='probe') {
      await actor.submit(advance(routeId,`First experiment ${routeId}`));
    } else if(job.research_stage==='pursue') {
      const n=(pursuits.get(routeId)??0)+1;pursuits.set(routeId,n);
      const result=await actor.submit({research:{route_id:routeId,outcome:'result',evidence_md:`Scripted finite result ${n}; broader implications are conditional.`,...(n===1?{next_step:step(`Second experiment ${routeId}`)}:{})}});
      assert.equal(result.status,'pending');
      if(n===1)assert.ok(result.research.next_job_id,'A pending result must still advance its route.');
      claims.push(result.return_id);
    } else if(job.type==='explore') {
      assert.equal(job.assignment_reason.research_bucket,'discover');
      // Limit scripted idea supply, so the test observes spare capacity lending as well.
      if(discovered.length<4)discovered.push(await actor.submit({research:proposal(`Fresh lead ${turn}`)}));
      else await actor.submit();
    } else {
      assert.equal(job.type,'measure');
      await actor.submit({recipe_md:'Scripted finite measurement fixture: no real scientific finding is asserted.'});
    }
  }
  assert.equal(discovered.length,4);
  assert.ok(pursuits.get(initial.research.route_id)>=2,'The tangent reaches successive pursuit without any reviewer.');
  assert.ok(claims.length>=6,'Several routes produce results while all judgments remain pending.');
  assert.equal((await w.one("SELECT count(*)::int AS n FROM returns WHERE problem_id=$1 AND status='accepted'",[w.pid])).n,0);
  const hours=await researchAllocation(w.pid,2),frontier=await researchAllocation(w.pid);
  assert.equal(frontier.total,0);assert.ok(hours.discover>0&&hours.pursue>0&&hours.consolidate>0);
  assert.ok(hours.discover/hours.total>=.25,'Discovery retains capacity despite abundant mechanical work.');
  assert.ok((await w.one("SELECT count(*)::int AS n FROM jobs WHERE problem_id=$1 AND type='review' AND status='queued'",[w.pid])).n>=6);
  // Even after the review backlog grows, fresh self-assigned proposals can still get a probe.
  const late=await author.submit({type:'direction',research:proposal('Another original lead after the backlog grows')});
  assert.equal(late.status,'recorded');assert.ok(late.research.next_job_id);
  w.record('expectations',{only_opus_researchers:true,tier_1_hours:frontier.total,opus_hours:hours,results_awaiting_judgment:claims.length,new_routes:discovered.length+2,pending_cap_does_not_block_recorded_proposals:true});
}
export async function opusRescue(w) {
  const author=await w.actor('author','claude-opus-5'),other=await w.actor('other','claude-opus-5');
  const route=await author.submit({type:'direction',research:proposal('Uniform bound')});
  await w.take(author,j=>j.research_stage==='probe');
  const negative=await author.submit({research:{route_id:route.research.route_id,outcome:'blocked',evidence_md:'The uniform argument has a finite counterexample.',obstacle:obstacle()}});
  for(let n=0;n<5;n++){const job=await other.start();assert.notEqual(job.research_stage,'rescue');await w.finish(other);}
  assert.equal((await w.read(`/research-routes/${route.research.route_id}`)).state,'blocked');
  // A changed method is allowed even when the only available model authored the original negative.
  const variant=await author.submit({type:'direction',cites:{returns:[negative.return_id]},research:{...proposal('Use an average instead of a uniform bound'),parent_route_id:route.research.route_id}});
  await w.take(other,j=>Number(j.research_route_id)===variant.research.route_id);
  await other.submit({research:{route_id:variant.research.route_id,outcome:'result',evidence_md:'The finite average survives; no general theorem claimed.'}});
  // Historical Astra evidence, with no Astra sessions or current tier-1 capacity.
  await w.fault('The original negative came from an earlier Astra contributor.',
    "UPDATE returns SET model='gpt-6-astra' WHERE id=$1",[negative.return_id]);
  const rescue=await w.take(other,j=>j.research_stage==='rescue');
  assert.equal(Number(rescue.research_route_id),route.research.route_id);
  assert.equal((await other.request(`/job/${rescue.job_id}`)).min_tier,99);
  await other.submit(advance(route.research.route_id,'A genuinely changed average argument',[]));
  await w.take(other,j=>j.research_stage==='pursue');
  await other.submit({research:{route_id:route.research.route_id,outcome:'result',evidence_md:'The finite changed implication holds conditionally.'}});
  assert.equal((await w.read(`/return/${negative.return_id}`)).research.obstacle.kind,'attempt_failed');
  assert.equal((await w.one('SELECT count(*)::int AS n FROM assignment_attempts WHERE problem_id=$1 AND tier=1',[w.pid])).n,0);
  w.record('expectations',{opus_rescues_astra:true,same_model_automatic_rescue_prevented:true,changed_linked_tangent_allowed:true,original_obstacle_preserved:true});
}
export async function priorWorkFirst(w) {
  const author=await w.actor('author','claude-opus-5',{share:0}),other=await w.actor('other','claude-sonnet-5',{share:0});
  const original=proposal('A count that may already be published');
  const proposed=await author.submit({type:'direction',research:original});
  const id=proposed.research.route_id;
  await w.take(author,j=>Number(j.research_route_id)===id);
  assert.match(author.held.brief_md,/Search the global body of work first/);
  assert.match(author.held.brief_md,/Do not regenerate published counts/);
  // External findings are scripted fixtures. The simulation performs no online search.
  const found='Scripted online lookup, 2026-09-14; query: finite count exact range. https://example.org/published-counts, table 2, rows 1–20. The definitions and range cover the entire proposed count; values are externally reported, not reproduced here.';
  const known={route_id:id,outcome:'known',evidence_md:'The original published table already answers this proposed computation.',prior_art_md:found};
  await author.request('/result',{method:'POST',body:author.body({research:{...known,prior_art_md:undefined}}),status:400});
  const closed=await author.submit({research:known});
  assert.equal(closed.status,'recorded');assert.equal(closed.reviews_requested,0);
  assert.equal(closed.research.state,'known');assert.equal(closed.research.next_job_id,null);
  const current=await w.read(`/research-routes/${id}`);
  assert.equal(current.prior_art_md,found);assert.equal(current.next_step,null);assert.equal(current.obstacle,null);
  assert.equal((await w.read(`/return/${proposed.return_id}`)).research.proposal.prior_art_md,original.proposal.prior_art_md,'The earlier search account remains on its original return.');
  for(let n=0;n<4;n++){const j=await other.start();assert.notEqual(Number(j.research_route_id),id);assert.notEqual(j.research_stage,'rescue');await w.finish(other);}
  assert.equal((await w.one("SELECT count(*)::int AS n FROM jobs WHERE research_route_id=$1 AND status IN ('queued','assigned')",[id])).n,0);
  assert.equal((await w.one("SELECT count(*)::int AS n FROM jobs WHERE problem_id=$1 AND type IN ('check','review')",[w.pid])).n,0);

  const extension=await other.submit({type:'direction',cites:{returns:[closed.return_id]},research:{...proposal('An uncovered weighted version'),parent_route_id:id}});
  await w.take(other,j=>Number(j.research_route_id)===extension.research.route_id);
  const updated='Scripted follow-up search: weighted finite count. https://example.org/weighted-counts, definition 3 excludes the proposed weighting; the remaining uncertainty is genuinely different. Reuse table 2 as externally reported input.';
  const progress=advance(extension.research.route_id,'Only the uncovered weighted implication');progress.research.prior_art_md=updated;
  await other.submit(progress);
  await w.take(other,j=>j.research_stage==='pursue');assert.ok(other.held.brief_md.includes(updated),'The next researcher receives the updated search instead of repeating it.');
  await other.submit({research:{...known,route_id:extension.research.route_id,prior_art_md:updated+' A later inspected appendix also covers the weighting.',evidence_md:'The appendix eliminates the remaining gap before another computation.'}});
  assert.equal((await w.read(`/research-routes/${id}`)).state,'known','A linked extension does not erase the prior-work match.');
  assert.equal((await w.one('SELECT count(*)::int AS n FROM verification_runs v JOIN returns r ON r.id=v.result_return_id WHERE r.problem_id=$1',[w.pid])).n,0);
  w.record('expectations',{published_count_not_recomputed:true,prior_work_stops_probe_and_pursuit:true,no_automatic_review_or_rescue:true,search_record_reused:true,uncovered_extension_allowed:true,source_findings_are_scripted:true});
}
export async function guidanceDelivery(w) {
  const {GUIDANCE_VERSION}=await import('../../src/lib/research-guidance.ts');
  const author=await w.actor('author','claude-opus-5'),worker=await w.actor('worker','claude-sonnet-5');
  const judge=await w.actor('judge','claude-fable-5-1',{trusted:true});
  const observed=[];
  const inspect=async(actor,role,criterion)=>{
    const job=actor.held;
    assert.equal(job.guidance_version,GUIDANCE_VERSION);
    assert.equal(job.assignment_reason.guidance_version,GUIDANCE_VERSION);
    assert.match(job.brief_md,criterion);
    assert.match(job.brief_md,/Search the global body of work first/);
    assert.match(job.brief_md,/further checking needs a concrete unresolved issue/);
    assert.match(job.brief_md,/self-review your local framework/);
    assert.match(job.brief_md,/Build and validate missing essentials now/);
    assert.match(job.brief_md,/ALL issued attempts, including those with no submission/);
    assert.match(job.brief_md,/model\/thinking-level lookup/);assert.match(job.brief_md,/compatible pinned tools across folders/);
    assert.match(job.brief_md,/If you cannot read your own session, follow runtime_lifecycle/);
    assert.match(job.brief_md,/automated extraction and submission scripts/);
    assert.match(job.brief_md,/detect agent\/model\/effort changes and preserve each turn's attribution/);
    assert.ok(job.brief_md.indexOf('## Your local research framework')<job.brief_md.indexOf('## The task'));
    assert.ok(job.brief_md.indexOf('## The task')<job.brief_md.indexOf('## Hand documents to other agents'));
    const saved=await w.one('SELECT reason,assignment_payload FROM assignment_attempts WHERE id=$1',[job.attempt_id]);
    assert.equal(saved.reason.guidance_version,GUIDANCE_VERSION);
    assert.equal(saved.assignment_payload.guidance_version,GUIDANCE_VERSION);
    assert.equal(saved.assignment_payload.brief_md,job.brief_md);
    observed.push(role);
  };
  await author.start();
  await inspect(author,'discover',/Find an uncovered contribution/);
  // A network retry replays the exact issued instructions, not a newly rendered assignment.
  const issued=author.held,replay=await author.request('/start');
  assert.equal(replay.attempt_id,issued.attempt_id);assert.equal(replay.brief_md,issued.brief_md);
  assert.equal(replay.guidance_version,GUIDANCE_VERSION);
  const route=await author.submit({research:proposal('A bounded guidance delivery fixture')});
  await w.take(author,j=>j.research_stage==='probe');
  await inspect(author,'probe',/A probe is the route’s first bounded test/);
  await author.submit(advance(route.research.route_id,'The finite implication'));
  await w.take(author,j=>j.research_stage==='pursue');
  await inspect(author,'pursue',/Advance the selected experiment/);
  const plan=await w.package(author);
  const claim=await author.submit({research:{route_id:route.research.route_id,outcome:'result',evidence_md:'The supplied finite fixture matches the declared definition.'},verification_plan:plan});
  await w.take(worker,j=>j.type==='check');
  await inspect(worker,'check',/Complete this check once/);
  await worker.submit(await w.execute(worker));
  await w.take(judge,j=>j.type==='review');
  await inspect(judge,'review',/Reuse eligible receipts/);
  await w.finish(judge);
  const subject=await w.read(`/return/${claim.return_id}`);
  assert.equal(subject.status,'accepted');assert.equal(subject.verification_runs.length,1);
  assert.ok(subject.reviews[0].verification_receipt_id,'Judgment cites the existing execution.');
  w.record('expectations',{guidance_version:GUIDANCE_VERSION,roles_checked:observed,issued_brief_replayed:true,version_persisted:true,one_execution_reused_for_judgment:true,scientific_outcomes_are_scripted:true});
}
export const regressions={transitiveEvidence,withdrawnReceipt,waitingCheck,duplicateClaims,freshProbe,lateConflict,firstAcceptance,opusResearch,opusRescue,priorWorkFirst,guidanceDelivery};
