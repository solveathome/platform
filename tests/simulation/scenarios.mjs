import {timedResearch} from './timed.mjs';
import {regressions} from './regressions.mjs';
import assert from 'node:assert/strict';
import {shuffle,step,proposal,obstacle} from './harness.mjs';
const report=(id,outcome,extra={})=>({research:{route_id:id,outcome,evidence_md:'Scripted evidence for this scenario, restricted to the stated finite claim.',...extra}});
const pursue=label=>({...step(label),required_tools:['research']});

async function ecosystem(w,{rounds}) {
  const author=await w.actor('researcher','claude-opus-5',{tools:['research'],share:0});
  const frontier=await w.actor('frontier','gpt-6-astra',{trusted:true,tools:['research'],share:0});
  const judge=await w.actor('judge','claude-fable-5-1',{trusted:true,share:0});
  const worker=await w.actor('worker','claude-sonnet-5',{tools:['node']});
  const historian=await w.actor('historian','claude-opus-5');
  let packageSize=8+Math.floor(w.rng()*16);
  // An initial backlog is world setup, not a simulated scheduler decision.
  for(let i=0;i<80;i++) {
    const r=await w.one(`INSERT INTO returns (problem_id,type,user_id,model,provider,report_md,transcript,status) VALUES ($1,'explore',$2,'claude-opus-5','anthropic','Synthetic historical finite claim.','Simulation fixture.','pending') RETURNING id`,[w.pid,historian.id]);
    await w.q(`INSERT INTO jobs (problem_id,type,title,brief_md,budget_hours,min_tier,parent_return_id) VALUES ($1,'review','Historical review','Review the synthetic finite claim.',0.25,1,$2)`,[w.pid,r.id]);
  }
  w.record('initial_backlog',{reviews:80});
  const routes=new Map();
  for(const kind of ['promising','reuse','rescue','known','transfer','repeat']) {
    const r=await author.submit({type:'direction',research:proposal(kind)});
    routes.set(r.research.route_id,{kind,pursuits:0,rescues:0,results:[]});
  }
  let resultsWhileReviewPending=0,newLeads=0;
  const discoveries=new Map();
  for(let round=0;round<rounds;round++) {
    for(const actor of shuffle([author,frontier,judge,worker],w.rng)) {
      const a=await actor.start(),route=routes.get(Number(a.research_route_id));
      if(!route){
        if(a.type==='explore'&&a.research_stage==='discover') {
          const n=(discoveries.get(actor.name)??0)+1;discoveries.set(actor.name,n);
          if(n%3===0&&n<=12) {
            const result=await actor.submit({research:proposal(`new-lead-${++newLeads}`)});
            routes.set(result.research.route_id,{kind:`new-lead-${newLeads}`,pursuits:0,rescues:0,results:[]});
            continue;
          }
        }
        await w.finish(actor);continue;
      }
      const id=Number(a.research_route_id);
      if(a.research_stage==='probe') {
        if(['known','transfer','rescue'].includes(route.kind))await actor.submit(report(id,'blocked',{obstacle:obstacle(route.kind==='known'?'scoped_obstruction':'attempt_failed')}));
        else await actor.submit(report(id,'promising',{next_step:pursue(`${route.kind}-first`)}));
      } else if(a.research_stage==='rescue') {
        route.rescues++;
        if(route.kind==='rescue')await actor.submit(report(id,'progress',{next_step:pursue('rescue-average'),depends_on:[]}));
        else await actor.submit(report(id,'inconclusive',{obstacle:obstacle()}));
      } else if(a.research_stage==='pursue') {
        route.pursuits++;
        if(route.kind==='repeat')await actor.submit(report(id,'progress',{next_step:pursue('repeat-first')}));
        else if(route.pursuits===1)await actor.submit(report(id,'progress',{next_step:pursue(`${route.kind}-second`)}));
        else {
          const next=route.pursuits===2?{next_step:pursue(`${route.kind}-extension`)}:{};
          const result=await actor.submit({...report(id,'result',next),verification_plan:await w.package(author,++packageSize)});
          route.results.push(result.return_id);
          if(next.next_step){assert.equal(result.research.state,'active');assert.equal(result.status,'pending');assert.ok(result.research.next_job_id);resultsWhileReviewPending++;}
        }
      } else assert.fail(`Unexpected research stage ${a.research_stage}`);
    }
    await w.invariant();
  }
  const snapshot=await w.snapshot();
  const frontierHours=snapshot.hours.filter(x=>x.tier===1);
  const total=frontierHours.reduce((n,x)=>n+x.hours,0);
  const forward=frontierHours.filter(x=>['discover','probe','pursue'].includes(x.stage)).reduce((n,x)=>n+x.hours,0);
  assert.ok(forward/total>=.60,`Discovery/pursuit must retain most frontier time under review pressure: ${forward/total}`);
  assert.ok(frontierHours.some(x=>x.stage==='consolidate'&&x.hours>0),'Review must still advance.');
  assert.ok(frontierHours.some(x=>x.stage==='rescue'&&x.hours>0),'Negatives must receive selective rescue.');
  for(const route of routes.values()) {
    if(['known','transfer'].includes(route.kind))assert.equal(route.pursuits,0,'These scripted probe failures must not get pursuit funding.');
    if(route.kind==='repeat')assert.equal(route.pursuits,1,'An unchanged experiment must not be repeated.');
    assert.ok(route.rescues<=1,'An unchanged negative must not enter a rescue loop.');
    if(['promising','reuse','rescue'].includes(route.kind))assert.equal(route.results.length,2,`${route.kind} should produce a result and a continuation.`);
  }
  assert.ok(newLeads>0,'Fresh discovery must feed the investigation queue.');
  assert.ok(resultsWhileReviewPending>=3);
  const executions=w.trace.filter(e=>e.kind==='worker_execution');
  assert.ok(executions.length>=3,'Distinct useful results need their own executions.');
  assert.equal(new Set(executions.map(e=>e.fingerprint)).size,executions.length,'No duplicate execution for an unchanged package.');
  assert.ok(snapshot.jobs.some(x=>x.type==='review'&&x.status==='queued'),'The research share was protected while reviews remained queued.');
  w.record('expectations',{forward_share:forward/total,new_leads:newLeads,results_with_continuation:resultsWhileReviewPending});
}

async function lateChallenge(w) {
  const author=await w.actor('author','claude-opus-5');
  const judge=await w.actor('judge','claude-fable-5-1',{trusted:true});
  const rescuer=await w.actor('rescuer','gpt-6-astra',{trusted:true});
  const r=await author.submit({type:'direction',research:proposal('late-challenge')});const id=r.research.route_id;
  await w.take(author,a=>a.research_stage==='probe');
  const premise=await author.submit(report(id,'promising',{next_step:step('first')}));
  await w.take(author,a=>a.research_stage==='pursue');
  await author.submit(report(id,'progress',{next_step:step('second'),depends_on:[]}));
  const held=await w.take(author,a=>a.research_stage==='pursue');
  await judge.submit({type:'review',return_id:premise.return_id,verdict:'reject',reject_reason:'refuted',notes_md:'The scripted earlier implication is false.'});
  let route=await w.read(`/research-routes/${id}`);assert.equal(route.state,'blocked');
  const stale=await author.submit(report(id,'progress',{next_step:step('obsolete'),depends_on:[]}));
  assert.equal(stale.research.stale,true);assert.equal(stale.research.next_job_id,null);
  assert.equal(Number(held.research_route_id),id);
  const rescue=await w.take(rescuer,a=>a.research_stage==='rescue');assert.notEqual(rescuer.model,author.model);
  const repaired=await rescuer.submit(report(id,'progress',{next_step:step('repair'),depends_on:[]}));
  route=await w.read(`/research-routes/${id}`);assert.equal(route.state,'active');assert.deepEqual(route.basis.map(x=>Number(x.id)),[repaired.return_id]);
  await judge.request(`/return/${premise.return_id}/reopen`,{method:'POST',body:{note:'Reconsider the old argument; the repaired route has a different basis.'}});
  route=await w.read(`/research-routes/${id}`);assert.equal(route.state,'active','Reopening a superseded argument must not undo a fresh rescue.');
  assert.ok(route.events.some(x=>x.outcome==='dependency_changed'));assert.ok(route.events.some(x=>x.outcome==='stale_progress'));
  await w.invariant();w.record('expectations',{stale_work_preserved:true,rescue_job:rescue.job_id,repaired_route:id});
}

async function verification(w) {
  const author=await w.actor('author','claude-opus-5');
  const limited=await w.actor('limited','claude-sonnet-5');
  const capable=await w.actor('capable','claude-haiku-4-5',{tools:['node']});
  const judge=await w.actor('judge','claude-fable-5-1',{trusted:true,share:0});
  const plan=await w.package(author,10+Math.floor(w.rng()*20));
  const publish=async (plan,report_md)=>{await w.take(author,a=>a.type==='explore'&&!a.research_route_id);return author.submit({request_review:true,verification_plan:plan,...(report_md?{report_md}:{})});};
  const first=await publish(plan);
  const second=await publish(plan);
  assert.equal((await w.one(`SELECT count(*)::int AS n FROM jobs WHERE problem_id=$1 AND type='check'`,[w.pid])).n,1);
  await w.take(limited,a=>a.type==='check');await limited.submit(await w.unable(limited));
  let retry=await w.one(`SELECT * FROM jobs WHERE problem_id=$1 AND type='check' AND status='queued'`,[w.pid]);assert.deepEqual(retry.required_tools,['node']);
  // A newly declared capability does not hand the same package back to the worker that failed.
  await limited.request(`/sessions/${limited.session}/capabilities`,{method:'POST',body:{capabilities:{tools:['node']}}});
  assert.notEqual((await limited.start()).type,'check');await w.finish(limited);
  await w.take(capable,a=>a.type==='check');
  const receipt=await w.execute(capable),body=capable.body(receipt),assignment=capable.held;
  const invalid={...body,check_receipt:{...receipt.check_receipt,fingerprint:'0'.repeat(64)}};
  await capable.request('/result',{method:'POST',body:invalid,status:400});
  const responses=await Promise.all([1,2,3].map(()=>capable.request('/result',{method:'POST',body,assignment})));
  assert.deepEqual(responses[0],responses[1]);assert.deepEqual(responses[1],responses[2]);capable.held=null;
  const before=await w.read(`/return/${first.return_id}`);assert.equal(before.status,'pending');assert.equal(before.verification_runs.length,2);
  await w.take(judge,a=>a.type==='review');await w.finish(judge);
  assert.equal((await w.read(`/return/${first.return_id}`)).status,'accepted');
  assert.equal((await w.read(`/return/${second.return_id}`)).status,'superseded');
  const reused=await publish({...plan,cost:{...plan.cost,minutes:180,judgment_minutes:60}},'A distinct interpretation of the same finite evidence, requiring separate judgment.');
  assert.equal(reused.check_requested,false);
  const review=await w.one(`SELECT compute_hint,budget_hours FROM jobs WHERE parent_return_id=$1 AND type='review'`,[reused.return_id]);assert.deepEqual(review.compute_hint,{});assert.equal(Number(review.budget_hours),1);
  // A distinct package still unable after the targeted retry must stop consuming execution slots.
  const changed={...plan,scope:'The same finite list under a separately stated scope.'};
  const blocked=await publish(changed);
  await w.take(limited,a=>a.type==='check');await limited.submit(await w.unable(limited));
  await w.take(capable,a=>a.type==='check');await capable.submit(await w.unable(capable,'capability',['node','sage']));
  assert.equal((await w.one(`SELECT count(*)::int AS n FROM jobs WHERE evidence_return_id=$1 AND type='check'`,[blocked.return_id])).n,2);
  assert.equal((await w.one(`SELECT count(*)::int AS n FROM jobs WHERE evidence_return_id=$1 AND type='check' AND status='queued'`,[blocked.return_id])).n,0);
  const pending=await w.one(`SELECT compute_hint FROM jobs WHERE parent_return_id=$1 AND type='review'`,[blocked.return_id]);assert.equal(pending.compute_hint.cpu_hours,.01);
  await w.invariant();w.record('expectations',{shared_packages:2,targeted_retry_limit:1,replayed_receipts:3,judgment_budget_independent:true});
}

async function interruptions(w) {
  const a=await w.actor('interrupted','claude-opus-5');
  const b=await w.actor('replacement','claude-sonnet-5');
  const proposed=await a.submit({type:'direction',research:proposal('interruptions')});
  const responses=await Promise.all([1,2,3,4].map(()=>a.request('/start?share=25',{launch:a.launch})));
  for(const response of responses)assert.deepEqual(response,responses[0]);
  a.held=responses[0];a.session=a.held.session;
  assert.equal(a.held.research_stage,'probe');const interrupted=a.held;
  // Simulate silence by ageing only this session; the application's normal sweep performs recovery.
  await w.fault('Worker disconnected for three hours.',`UPDATE sessions SET last_seen=now()-interval '3 hours' WHERE id=$1`,[a.session]);
  const replacement=await b.start();assert.equal(Number(replacement.job_id),Number(interrupted.job_id));assert.notEqual(replacement.attempt_id,interrupted.attempt_id);
  await a.request('/result',{method:'POST',body:a.body(report(proposed.research.route_id,'promising',{next_step:step('stale-holder')})),assignment:interrupted,status:409});
  const good=await b.submit(report(proposed.research.route_id,'promising',{next_step:step('replacement')}));
  assert.equal(good.research.state,'active');
  await b.start();const released=b.held;await b.release();
  const next=await b.start();assert.notEqual(next.job_id,released.job_id,'The same session must not reacquire released work.');
  if(next.research_route_id) {
    assert.equal(Number(next.research_route_id),proposed.research.route_id);
    assert.equal(next.research_stage,'pursue');
    await b.submit(report(proposed.research.route_id,'result'));
  } else await w.finish(b);
  const attempts=await w.q(`SELECT status FROM assignment_attempts WHERE job_id=$1 ORDER BY started_at`,[interrupted.job_id]);
  assert.equal(attempts.length,2);assert.equal(attempts[0].status,'released');assert.equal(attempts[1].status,'completed');
  await w.invariant();w.record('expectations',{registration_replays:4,abandoned_job_reassigned:true,late_result_refused:true});
}

export const scenarios={ecosystem,lateChallenge,verification,interruptions,...regressions,timedResearch};
