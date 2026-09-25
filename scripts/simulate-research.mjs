/** Run seeded local system simulations. No models, external services or live project data. */
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createLab} from '../tests/simulation/harness.mjs';
import {scenarios} from '../tests/simulation/scenarios.mjs';

const options={seeds:[17,42,99],rounds:40,scenario:'all',out:'data/simulations/latest'};
for(const arg of process.argv.slice(2)) {
  if(arg==='--help'){console.log('npm run test:sim -- [--seeds=17,42,99] [--rounds=40] [--scenario=all|'+Object.keys(scenarios).join('|')+'] [--out=data/simulations/latest]\nRequires TEST_DATABASE_URL and a Postgres role with CREATEDB. Creates and removes its own temporary database.');process.exit(0);}
  const match=/^--(seeds|rounds|scenario|out)=(.+)$/.exec(arg);if(!match)throw Error(`Unknown option: ${arg}`);
  const [,key,value]=match;options[key]=key==='seeds'?value.split(',').map(Number):key==='rounds'?Number(value):value;
}
if(!options.seeds.length||options.seeds.length>20||options.seeds.some(x=>!Number.isInteger(x)||x<0||x>4294967295))throw Error('Use 1–20 unsigned integer seeds.');
if(!Number.isInteger(options.rounds)||options.rounds<30||options.rounds>80)throw Error('Use 30–80 rounds so scenarios have time to progress and stay inside ordinary contributor limits.');
if(options.scenario!=='all'&&!scenarios[options.scenario])throw Error('Unknown scenario.');
const output=resolve(options.out);mkdirSync(output,{recursive:true});
const report={version:2,options,scope:'Scripted agents, real HTTP routes and scheduler, private temporary database. Budgets are allocated hours, not measured model costs. Toy checker execution is measured on the simulated worker. Scientific quality and novelty are scripted, not evaluated.',runs:[]};
let lab;
function save() {
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  const rows=report.runs.map(r=>{
    const h=r.snapshot?.hours??[],hours=h.reduce((n,x)=>n+x.hours,0),forward=h.filter(x=>['discover','probe','pursue','rescue'].includes(x.stage)).reduce((n,x)=>n+x.hours,0);
    return `| ${r.scenario} | ${r.seed} | ${r.passed?'PASS':'FAIL'} | ${h.reduce((n,x)=>n+x.assignments,0)} | ${forward.toFixed(2)} | ${(hours-forward).toFixed(2)} | ${r.snapshot?.verification.receipts??0} |`;
  });
  const research=report.runs.filter(r=>r.scenario==='ecosystem').map(r=>{
    const f=(r.snapshot?.hours??[]).filter(x=>x.tier===1),total=f.reduce((n,x)=>n+x.hours,0),forward=f.filter(x=>['discover','probe','pursue'].includes(x.stage)).reduce((n,x)=>n+x.hours,0),v=r.snapshot?.verification;
    return `| ${r.seed} | ${options.rounds} | ${(100*forward/(total||1)).toFixed(1)}% | ${v?.reviews_using_receipts??0} | ${v?.receipts_used??0} |`;
  });
  const researchTable=research.length?`\n\n## Mixed-workload observations\n\n| Seed | Rounds | Frontier discovery + pursuit | Reviews using receipts | Distinct receipts used |\n|---|---:|---:|---:|---:|\n${research.join('\n')}\n\nShares reflect which work is available in the scenario, including lead supply and reviewer backlog. They are not estimates of mathematical productivity.`:'';
  const timed=report.runs.filter(r=>r.scenario==='timedResearch'&&r.metrics);
  const timedTable=timed.length ? `\n\n## Timed workload (scripted costs)\n\n| Seed | Distinct accepted claims | Verification minutes per claim | Peak queued reviews | Final queued reviews |\n|---|---:|---:|---:|---:|\n${timed.map(r=>`| ${r.seed} | ${r.metrics.distinct_useful_claims} | ${r.metrics.verification_minutes_per_distinct_claim.toFixed(1)} | ${r.metrics.peak_review_backlog} | ${r.metrics.final_review_backlog} |`).join('\n')}\n\nTask durations and useful findings are scenario assumptions. Verification includes execution attempts and judgment; unrelated exploration is accounted separately. These are not measured AI savings.` : '';
  writeFileSync(join(output,'report.md'),`# Research system simulations\n\n${report.scope}\n\n| Scenario | Seed | Result | Assignments | Research hours | Consolidation hours | Receipts |\n|---|---:|---|---:|---:|---:|---:|\n${rows.join('\n')}${researchTable}${timedTable}\n\nEach scenario has a JSON event trace. Replay with the same seed and round count; HTTP races may change request arrival order.\n${report.runs.filter(r=>!r.passed).map(r=>`\nFailure in ${r.scenario}, seed ${r.seed}: ${r.error}\n`).join('')}`);
}
try {
  lab=await createLab();
  for(const seed of options.seeds)for(const [name,run] of Object.entries(scenarios)) {
    if(options.scenario!=='all'&&options.scenario!==name)continue;
    const world=await lab.project(name.toLowerCase(),seed),result={scenario:name,seed,passed:false};
    console.log(`Running ${name}, seed ${seed}…`);
    try {await run(world,options);await world.invariant();result.passed=true;}
    catch(error){result.error=error.stack??String(error);process.exitCode=1;}
    finally {
      result.metrics=world.trace.filter(e=>e.kind==='expectations').at(-1)??null;
      result.snapshot=await world.snapshot();
      writeFileSync(join(output,`${name}-${seed}.json`),JSON.stringify({seed,scenario:name,events:world.trace,snapshot:result.snapshot,error:result.error},null,2)+'\n');
      report.runs.push(result);save();console.log(`${result.passed?'PASS':'FAIL'} ${name}, seed ${seed}${result.error?' — '+result.error.split('\n')[0]:''}`);
    }
  }
} finally {if(lab)await lab.close();save();}
console.log(`${report.runs.filter(r=>r.passed).length}/${report.runs.length} passed. Report: ${join(output,'report.md')}`);
