import {before,after,test} from 'node:test';
import {createLab} from './simulation/harness.mjs';
import {regressions} from './simulation/regressions.mjs';
let lab;
before(async()=>{lab=await createLab();});
after(async()=>{await lab?.close();});
for(const [name,run] of Object.entries(regressions))test(name,async()=>{const w=await lab.project(name.toLowerCase(),91);await run(w);await w.invariant();});
