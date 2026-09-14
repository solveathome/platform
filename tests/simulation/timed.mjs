import assert from 'node:assert/strict';
import {proposal,step,shuffle} from './harness.mjs';

/** Discrete completion times, a continuing lead supply, and an eight-hour reviewer outage. */
export async function timedResearch(w) {
  const publisher=await w.actor('publisher','claude-opus-5',{share:0});
  const researcher=await w.actor('researcher','claude-opus-5',{share:0,tools:['research']});
  const limited=await w.actor('limited','claude-sonnet-5');
  const capable=await w.actor('capable','claude-haiku-4-5',{tools:['node']});
  const judge=await w.actor('judge','claude-fable-5-1',{trusted:true,share:0,tools:['research']});
  const secondJudge=await w.actor('second-judge','gpt-6-astra',{trusted:true,share:0,tools:['research']});
  const actors=[researcher,limited,capable,judge,secondJudge],pending=new Map(),claims=[],cost={research:0,execution:0,judgment:0,other:0};
  const backlog=[];let arrivals=0,injected=false;
  async function complete(actor) {
    const a=actor.held;
    if(a.type==='check') {
      if(actor===limited&&!injected){await actor.submit(await w.unable(actor));injected=true;}
      else await actor.submit(await w.execute(actor));
    } else if(a.type==='review')await w.finish(actor);
    else if(a.research_stage==='triage')await actor.submit({research:{route_id:Number(a.research_route_id),outcome:'promising',evidence_md:'Scripted literature and feasibility comparison found a distinct finite lead.',next_step:{...step(`route-${a.research_route_id}`),budget_hours:1,required_tools:['research']}}});
    else if(a.research_stage==='pursue') {
      const r=await actor.submit({research:{route_id:Number(a.research_route_id),outcome:'result',evidence_md:`New finite result for route ${a.research_route_id}.`},verification_plan:await w.package(publisher,60+claims.length)});
      claims.push({id:r.return_id,submitted:w.minutes});
    } else await w.finish(actor);
    w.record('virtual_completion',{actor:actor.name,job:a.job_id,minutes:w.minutes});
  }
  for(let tick=0;tick<112;tick++) {
    if(tick%8===0&&arrivals<8){await publisher.submit({type:'direction',research:proposal(`arrival-${++arrivals}`)});w.record('arrival',{minutes:w.minutes,lead:arrivals});}
    for(const actor of shuffle(actors,w.rng)) {
      const scheduled=pending.get(actor.name);
      if(scheduled&&scheduled.due<=w.minutes){await complete(actor);pending.delete(actor.name);}
      if(!actor.held&&!([judge,secondJudge].includes(actor)&&w.minutes>=240&&w.minutes<720)) {
        const a=await actor.start();
        const kind=a.type==='check'?'execution':a.type==='review'?'judgment':a.research_route_id?'research':'other';
        const duration=a.type==='check'?15:a.type==='review'?15:a.research_stage==='triage'?30:60;
        cost[kind]+=duration;pending.set(actor.name,{due:w.minutes+duration});
        w.record('virtual_start',{actor:actor.name,job:a.job_id,minutes:w.minutes,duration,kind});
      }
      // Long local work sends its usual session heartbeat, independently of completion.
      if(actor.held)await actor.request(`/job/${actor.held.job_id}`);
    }
    const queue=await w.one("SELECT count(*)::int AS n FROM jobs WHERE problem_id=$1 AND type='review' AND status='queued'",[w.pid]);
    backlog.push({minutes:w.minutes,reviews:queue.n});
    await w.invariant();await w.advance(15);
  }
  // Finish in-flight work at its scheduled completion; do not silently discard paid work.
  for(let tick=0;pending.size&&tick<8;tick++) {
    for(const actor of actors)if(pending.has(actor.name)){
      if(pending.get(actor.name).due<=w.minutes){await complete(actor);pending.delete(actor.name);}
      else await actor.request(`/job/${actor.held.job_id}`);
    }
    if(pending.size)await w.advance(15);
  }
  const accepted=await w.q("SELECT id,verification_fingerprint FROM returns WHERE problem_id=$1 AND verification_plan IS NOT NULL AND status='accepted'",[w.pid]);
  const unique=new Set(accepted.map(r=>r.verification_fingerprint)).size;
  assert.equal(arrivals,8);assert.equal(claims.length,8);assert.equal(unique,8);
  const outage=backlog.filter(b=>b.minutes>=240&&b.minutes<720);
  assert.ok(Math.max(...outage.map(b=>b.reviews))>outage[0].reviews,'Review backlog must grow during the outage.');
  assert.equal(backlog.at(-1).reviews,0,'Review backlog must drain after the reviewer returns.');
  assert.ok(cost.execution+cost.judgment<cost.research,'This explicitly cheap-check fixture should spend less on verification than research.');
  w.record('expectations',{virtual_minutes:w.minutes,distinct_useful_claims:unique,scripted_cost_minutes:cost,
    verification_minutes_per_distinct_claim:(cost.execution+cost.judgment)/unique,
    peak_review_backlog:Math.max(...backlog.map(b=>b.reviews)),final_review_backlog:backlog.at(-1).reviews,
    capability_retry_exercised:injected,backlog});
}
