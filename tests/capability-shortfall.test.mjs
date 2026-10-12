import assert from 'node:assert/strict';
import {test} from 'node:test';
const {operationalShortfall,obstacleShortfall,waitingStep,describeNeeds,requirementKey,waitingFor}=await import('../src/lib/capability-shortfall.ts');
const {parseResearch,computeNeeds}=await import('../src/lib/research-format.ts');
const {parseCapabilities}=await import('../src/lib/agent-profile.ts');

// The obstacles that closed md5 routes 268, 263, 265 and 261 (Oct 2026): limits of the machine that ran the step.
const operational={
  268:'This host lacks an RTX 2080 Ti (sm_75), CUDA 12.9/NVCC, and WSL2 required for exact independent replication of return 2999’s v4/v0 interleaving gain.',
  263:'Cannot execute a Q16-style forced m15=0x00000080 solve on stock Stevens md5sbc within 2 CPU-h: no constrain interface, and host TTF too slow for a constrained multi-attempt budget (2830).',
  265:'Independent steered Q29 arms require a completed Q3×Q6 lookup table (≥2^20 entries) before equal-wall L=62/L=63 runs; table precompute did not finish in this sprint.',
  261:'Could not measure the fraction of single-block colliding pairs with m15=0x00000080 among N>=200 pairs: the Stevens 2012 md5sbc tool emitted 0 full collisions in ~14 CPU-minutes on Linux aarch64/g++-O2.',
};
// Research findings that must stay obstacles, from the same record: method negatives, missing theorems, a compute reach of the problem.
const findings=[
  'On full 64-step one-block MD5, Z3 bit-blast/CDCL encodings cost ~1e7-1e8 hash equivalents at 1-3 hex-char prefixes and mostly exceed 2.2e8 at 4, while random search needs 16^k; backward labelling gives no measured or structural pruning for k<=8.',
  'C-compiled step-61 H0-abort nibble hill-climb does not beat full-MD5 C hill-climb in score>=4 finds per wall-second on Linux aarch64/gcc-O3 (median ratio 0.998; success bar 1.2).',
  'The constructive branch cannot decide the base-10 window at any budget tried: min-conflicts warm-started from the published a(23) >= 1859 reaches a(25) >= 2231 (K = 371), below the bar K >= 409.',
  'No located theorem bounds the shift-two correlation with beta = mu, the non-smooth parity weight, on the shifted cofactor.',
  'The inspected public sources do not provide the specific 846-coefficient rational witness for bgp212 Theorem 11.1.',
  'Any finite-integer-gauge kernel is a function of n mod lcm(q); no finite-z kernel separates twin primes from rough composites.',
];

test('machine limits are recognised, with the GPU model or the time they show',()=>{
  assert.deepEqual(operationalShortfall(operational[268]),{gpu:true,gpu_name:'rtx 2080 ti',time:false,tool:false});
  for (const id of [263,265,261]) { const f=operationalShortfall(operational[id]); assert.ok(f?.time,`route ${id}`); assert.equal(f.gpu,false,`route ${id}`); }
  assert.ok(operationalShortfall('The tool is not installed on this machine and the package needs it.')?.tool);
  assert.ok(operationalShortfall('No CUDA-capable GPU is available here, so the kernel benchmark could not run.')?.gpu);
});
test('research findings stay obstacles',()=>{
  for (const text of findings) assert.equal(operationalShortfall(text),null,text.slice(0,60));
});
test('only the statement decides; its evidence may name the GPU model',()=>{
  const o={kind:'scoped_obstruction',statement:'This machine has no NVIDIA GPU for the replication.',assumptions:'',evidence:'nvidia-smi absent; the original ran on an RTX 4090.',revisit_when:'A machine with an RTX 4090.'};
  assert.equal(obstacleShortfall(o).gpu_name,'rtx 4090');
  assert.equal(obstacleShortfall({...o,statement:'The bound fails for k>=8.',evidence:'This host lacks a GPU.'}),null);
});
test('a waiting step asks for the GPU or twice the CPU hours the session offered',()=>{
  const step={question:'q',method:'m',success:'s',failure:'f',budget_hours:2,compute:{cpu_hours:0,ram_gb:2,disk_gb:1},required_tools:[],required_sources:[]};
  const gpu=waitingStep(step,operationalShortfall(operational[268]),operational[268]);
  assert.deepEqual(gpu.compute,{cpu_hours:0,ram_gb:2,disk_gb:1,gpu:true,gpu_name:'rtx 2080 ti'});
  assert.equal(gpu.shortfall,operational[268]);
  assert.equal(waitingStep(step,operationalShortfall(operational[265]),operational[265],{cpu_hours:4}).compute.cpu_hours,8);
  assert.equal(waitingStep({...step,compute:{...step.compute,cpu_hours:3}},{gpu:false,gpu_name:null,time:true,tool:false},'x',{cpu_hours:1}).compute.cpu_hours,5);
  assert.equal(describeNeeds(gpu),'GPU RTX 2080 Ti');
  assert.equal(waitingFor({state:'active',next_step:gpu}),'GPU RTX 2080 Ti');
  assert.equal(waitingFor({state:'blocked',next_step:gpu}),null);
  assert.equal(waitingFor({state:'active',next_step:step}),null);
  assert.notEqual(requirementKey(gpu.compute,[],[]),requirementKey(step.compute,[],[]));
  assert.equal(requirementKey({...gpu.compute,capability_wait:true},[],[]),requirementKey(gpu.compute,[],[]));
});
test('reports, steps and capabilities carry the requirement',()=>{
  assert.deepEqual(computeNeeds({gpu_name:'RTX  2080 Ti',cpu_hours:8},'c'),{cpu_hours:8,ram_gb:2,disk_gb:1,gpu:true,gpu_name:'rtx 2080 ti'});
  assert.throws(()=>computeNeeds({gpu:'yes'},'c'),/true or false/);
  const step={question:'q?',method:'m',success:'s',failure:'f',budget_hours:1,compute:{gpu:true,vram_gb:11},shortfall:'no GPU here'};
  const r=parseResearch({route_id:3,outcome:'needs_capability',evidence_md:'The benchmark needs a GPU this machine lacks.',next_step:step});
  assert.equal(r.outcome,'needs_capability');assert.equal(r.next_step.shortfall,'no GPU here');assert.equal(r.next_step.compute.vram_gb,11);
  const filed=parseResearch({route_id:3,outcome:'blocked',evidence_md:'e',obstacle:{kind:'capability',statement:'This host lacks a GPU.'}});
  assert.equal(filed.outcome,'needs_capability');assert.equal(filed.obstacle.statement,'This host lacks a GPU.');
  assert.deepEqual(parseCapabilities({gpu:{name:'NVIDIA GeForce RTX 2080 Ti',vram_gb:11}}).gpu,{name:'NVIDIA GeForce RTX 2080 Ti',vram_gb:11});
  assert.throws(()=>parseCapabilities({gpu:{name:'',vram_gb:11}}),/gpu must be/);
});
