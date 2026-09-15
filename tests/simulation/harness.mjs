/** Local system simulation: real application routes and SQL, scripted contributor decisions. */
import assert from 'node:assert/strict';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import express from 'express';
import pg from 'pg';

export const POLICY = {discover:.3,pursue:.4,rescue:.15,consolidate:.15};
export const CHECKER = `import {readFileSync} from 'node:fs';
const {terms}=JSON.parse(readFileSync(process.argv[2],'utf8'));
if (!Array.isArray(terms)||terms.length<2) throw Error('missing terms');
for(let i=0;i<terms.length;i++) if(terms[i] !== (i+1)*(i+2)/2) throw Error('incorrect term');
console.log(JSON.stringify({checked:terms.length,last:terms.at(-1)}));
`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function random(seed) {
  let state=seed>>>0;
  return () => {state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
}
export function shuffle(items,rng) {
  const out=[...items];for(let i=out.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[out[i],out[j]]=[out[j],out[i]];}return out;
}
export const step = label => ({question:`Does ${label} hold?`,method:`Test the finite implication for ${label}.`,success:'The specific implication survives the test.',failure:'A witness defeats this attempted implication.',budget_hours:.5});
export const obstacle = (kind='attempt_failed') => ({kind,statement:'The attempted uniform implication fails.',assumptions:'Only this uniform argument and the tested range.',evidence:'A scripted witness defeats that implication.',revisit_when:'A new argument using an average instead of a uniform bound.'});
export const proposal = label => ({outcome:'proposed',proposal:{title:label,contribution_md:'Synthetic lead toward a finite research target.',prior_art_md:'Scripted literature comparison; this is a simulation, not a novelty claim.',uncertainty_md:'Whether this intermediate implication survives.'},evidence_md:'A bounded test can discriminate between the proposed alternatives.',next_step:step(label),depends_on:[]});

export async function createLab() {
  if(!process.env.TEST_DATABASE_URL) throw Error('Set TEST_DATABASE_URL to a local disposable Postgres database; its role needs CREATEDB.');
  const source=new URL(process.env.TEST_DATABASE_URL);
  const database=`sah_sim_${process.pid}_${randomBytes(5).toString('hex')}`;
  const admin=new pg.Pool({connectionString:source.href,max:1});
  const temp=mkdtempSync(join(tmpdir(),'sah-simulation-'));
  let created=false,db,server;
  async function close() {
    try {
      if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
      if(db)await db.pool.end();
    } finally {
      try {if(created)await admin.query(`DROP DATABASE "${database}"`);} finally {await admin.end();rmSync(temp,{recursive:true,force:true});}
    }
  }
  try {
    // Never migrate or clear the supplied database. Only the unique database we create is dropped.
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    source.pathname='/'+database;source.searchParams.delete('options');
    Object.assign(process.env,{DATABASE_URL:source.href,FILES_DIR:join(temp,'files'),DOCS_DIR:join(temp,'docs'),OVERLAY_DIR:join(temp,'overlay'),TOKEN_VAULT_KEY_FILE:join(temp,'token-vault.key'),BASE_URL:'http://127.0.0.1',OWNER_HANDLES:'',TRUSTED_MODEL_FAMILIES:'',ABANDON_AFTER_MIN:'120'});
    db=await import('../../src/db/index.ts');await db.migrate();await db.migrate();
    const {job}=await import('../../src/routes/job.ts');
    const {board,root}=await import('../../src/routes/board.ts');
    const {asks}=await import('../../src/routes/asks.ts');
    const {chat}=await import('../../src/routes/chat.ts');
    const {logout}=await import('../../src/lib/auth.ts');
    const {filesRouter}=await import('../../src/routes/files.ts');
    const {issueToken}=await import('../../src/lib/auth.ts');
    const {TERMS_VERSION}=await import('../../src/lib/terms.ts');
    const app=express();app.use(express.json({limit:'2mb'}));app.use('/projects/:slug',job,board,asks,chat);app.use(filesRouter);app.use(root);app.post('/auth/logout',logout);
    app.use((error,req,res,next)=>res.status(error.status??500).json({error:error.message}));
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    process.env.BASE_URL=origin;
    return {close,async project(name,seed) {
      const slug=`simulation-${name}-${seed}-${randomBytes(3).toString('hex')}`;
      const p=await db.one(`INSERT INTO problems (slug,name,repo_url,status_md,discovery_share,research_allocation) VALUES ($1,$2,'https://example.org/simulation','Local scripted simulation',0,$3) RETURNING id`,[slug,name,JSON.stringify(POLICY)]);
      const pid=Number(p.id),base=`/projects/${slug}`,trace=[],rng=random(seed);
      const record=(kind,detail)=>trace.push({event:trace.length+1,kind,...detail});
      await db.q(`INSERT INTO channels (problem_id,path,title) VALUES ($1,'','Simulation')`,[pid]);
      const world={pid,seed,rng,trace,record,q:db.q,one:db.one,base,origin,minutes:0,
        async advance(minutes) {
          assert.ok(minutes>0&&minutes<=60);
          // Move fixture timestamps relative to PostgreSQL's real clock. Production gets no test clock.
          await db.projectTransaction(pid,async()=>{
            for(const [table,columns] of Object.entries({jobs:['created_at','assigned_at','expires_at'],sessions:['started_at','last_seen','ends_at'],assignment_attempts:['started_at','ended_at'],returns:['created_at'],research_routes:['created_at','updated_at']}))
              await db.q(`UPDATE ${table} SET ${columns.map(c=>`${c}=${c}-($2::numeric*interval '1 minute')`).join(',')} WHERE problem_id=$1`,[pid,minutes]);
          });
          world.minutes+=minutes;record('virtual_time',{minutes:world.minutes});
        },
        async actor(name,model,{trusted=false,tools=[],sources=[],share=25}={}) {
          assert.ok([0,25].includes(share),'The current simulation profiles use either no compute or a 25% offer.');
          const u=await db.one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`,[Math.floor(Math.random()*1e12),`${slug}-${name}`,TERMS_VERSION]);
          const token=await issueToken(Number(u.id));
          if(trusted)await db.q(`INSERT INTO project_roles (problem_id,user_id,role,note) VALUES ($1,$2,'trusted','Simulation fixture')`,[pid,u.id]);
          const actor={name,model,id:Number(u.id),session:null,held:null,launch:randomUUID(),share,capabilities:{tools,sources},
            async request(path,{method='GET',body,assignment=actor.held,status=200,launch}={}) {
              const headers={authorization:`Bearer ${token}`,'x-model':model,'x-effort':'max',accept:'application/json','content-type':'application/json'};
              if(actor.session)headers['x-session']=actor.session;
              if(assignment){headers['x-session']=assignment.session;headers['x-attempt']=assignment.attempt_id;}
              if(launch){headers['x-launch-id']=launch;headers['x-capabilities']=JSON.stringify(actor.capabilities);}
              const response=await fetch(origin+(path.startsWith('/files')?path:base+path),{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
              const data=await response.json();
              record('http',{actor:name,method,path:path.replace(/\/sessions\/[^/]+/,'/sessions/<session>'),status:response.status,job:data.job_id,return:data.return_id,review_of:data.review_of,research:data.research,error:data.error});
              assert.equal(response.status,status,`${name} ${method} ${path}: ${JSON.stringify(data)}`);
              if(path.endsWith('/capabilities')&&response.status===200)actor.capabilities=data.capabilities;
              return data;
            },
            async start() {
              const assignment=await actor.request(`/start?share=${share}`,{assignment:null,launch:actor.session?undefined:actor.launch});
              const detail=await actor.request(`/job/${assignment.job_id}`,{assignment:null});
              assert.ok((detail.compute_hint?.cpu_hours??0)<=(share===0?0:.5),'Assignment exceeds the simulated donor CPU offer.');
              assert.ok((detail.compute_hint?.ram_gb??0)<=(share===0?8:4),'Assignment exceeds the simulated donor memory offer.');
              assert.ok((detail.compute_hint?.disk_gb??0)<=1,'Assignment exceeds the simulated donor disk offer.');
              assert.ok(detail.required_tools.every(x=>actor.capabilities.tools.includes(x)),'Worker lacks a required tool.');
              assert.ok(detail.required_sources.every(x=>actor.capabilities.sources.includes(x)),'Worker lacks required source access.');
              if(assignment.type==='review')assert.ok(trusted,'Only explicitly trusted simulation agents may receive reviews.');
              Object.assign(assignment,{parent_return_id:detail.parent_return_id,evidence_return_id:detail.evidence_return_id,budget_hours:detail.budget_hours});
              actor.session=assignment.session;actor.held=assignment;
              record('assignment',{actor:name,model,type:assignment.type,stage:assignment.research_stage??assignment.assignment_reason?.research_bucket,job:assignment.job_id,route:assignment.research_route_id??null,budget_hours:Number(assignment.budget_hours)});
              return assignment;
            },
            body(body={}) {return {report_md:'Scripted system simulation; findings and scientific judgments are fixtures.',transcript:'Scripted simulation agent; no model inference or claimed token usage.',transcript_approved:true,...(actor.held?{job_id:actor.held.job_id}:{}),...body};},
            async submit(body={}) {const result=await actor.request('/result',{method:'POST',body:actor.body(body)});actor.held=null;return result;},
            async upload(name,content) {return (await actor.request('/files',{method:'POST',body:{name,content}})).sha256;},
            async release() {await actor.request('/release',{method:'POST',body:{job_id:actor.held.job_id,note:'Simulation interruption.'}});actor.held=null;},
          };return actor;
        },
        async read(path) {const response=await fetch(origin+base+path,{headers:{accept:'application/json'},signal:AbortSignal.timeout(20000)});const data=await response.json();record('read',{path,status:response.status,error:data.error});assert.equal(response.status,200,`${path}: ${JSON.stringify(data)}`);return data;},
        async package(author,n=12) {
          const checker=await author.upload('check.mjs',CHECKER),target=await author.upload('terms.json',JSON.stringify({terms:Array.from({length:n},(_,i)=>(i+1)*(i+2)/2)}));
          return {schema_version:1,manifest:[{path:'check.mjs',sha256:checker,role:'checker'},{path:'terms.json',sha256:target,role:'target'}],targets:['terms.json'],claim:`The supplied ${n} triangular numbers match their definition.`,scope:`Indices 1 through ${n} only.`,assumptions:'Exact integer arithmetic in this finite range.',checker,inputs:[target],environment:`Node ${process.version}; built-in modules only.`,command:'node check.mjs terms.json',expected:JSON.stringify({checked:n,last:n*(n+1)/2})+'\n',supports:'Each supplied term is checked against its finite definition.',coverage:'decisive',coverage_md:`All ${n} terms, with no assertion about an infinite sequence.`,comparison:'Exact JSON output and zero exit code.',availability:{status:'complete',details:'All files are pinned in the manifest.',network:false,required_sources:[]},cost:{minutes:2,judgment_minutes:15,cpu_hours:.01,ram_gb:1,disk_gb:1}};
        },
        async execute(actor) {
          const subject=await world.read(`/return/${actor.held.evidence_return_id}`),plan=subject.verification_plan;
          assert.notEqual(subject.model,actor.model,'Execution must use another model.');
          assert.notEqual(Number(subject.user_id),actor.id,'Execution must use another contributor.');
          const dir=mkdtempSync(join(temp,'worker-'));
          const began=performance.now();
          // Deliberately execute only this harness-owned checker, never arbitrary uploaded code.
          assert.equal(plan.checker,digest(CHECKER));
          for(const file of plan.manifest) {
            const response=await fetch(`${origin}/files/${file.sha256}`);assert.equal(response.status,200);
            const bytes=Buffer.from(await response.arrayBuffer());assert.equal(digest(bytes),file.sha256);
            assert.ok(['check.mjs','terms.json'].includes(file.path));writeFileSync(join(dir,file.path),bytes);
          }
          const run=spawnSync(process.execPath,['check.mjs','terms.json'],{cwd:dir,encoding:'utf8',timeout:5000});
          assert.equal(run.status,0,run.stderr);assert.equal(run.stdout,plan.expected);
          // Independent control cases: corrupt a value and then omit the target entirely.
          writeFileSync(join(dir,'terms.json'),'{"terms":[1,999]}');
          assert.equal(spawnSync(process.execPath,['check.mjs','terms.json'],{cwd:dir,timeout:5000}).status,1);
          rmSync(join(dir,'terms.json'));
          assert.equal(spawnSync(process.execPath,['check.mjs','terms.json'],{cwd:dir,timeout:5000}).status,1);
          rmSync(dir,{recursive:true,force:true});
          const elapsed=(performance.now()-began)/1000;
          const stdout=await actor.upload('stdout.txt',run.stdout);
          record('worker_execution',{actor:actor.name,fingerprint:subject.verification_fingerprint,elapsed_seconds:elapsed,controls:['corrupt target rejected','missing target rejected']});
          return {check_receipt:{fingerprint:subject.verification_fingerprint,outcome:'pass',observed:run.stdout,elapsed_seconds:elapsed,stdout_sha256:stdout,exit_code:0,environment:plan.environment,coverage_md:plan.coverage_md,method:'rerun',shared_components_md:'Harness-owned checker supplied by the simulated author.',controls_md:'Corrupted value and missing target both failed in separate control runs.'}};
        },
        async unable(actor,kind='capability',tools=['node']) {
          const subject=await world.read(`/return/${actor.held.evidence_return_id}`);
          return {check_receipt:{fingerprint:subject.verification_fingerprint,outcome:'unable',observed:`Injected ${kind} obstacle; execution did not start.`,elapsed_seconds:0,exit_code:null,environment:'Simulated worker without the required runtime.',coverage_md:'Nothing executed.',method:'rerun',shared_components_md:'No checker ran.',controls_md:'No controls ran.',blocker:{kind,required_tools:kind==='capability'?tools:[],required_sources:[]}}};
        },
        async finish(actor) {
          if(actor.held.type==='check')return actor.submit(await world.execute(actor));
          if(actor.held.type==='review') {
            const subject=await world.read(`/return/${actor.held.parent_return_id}`);
            const receipt=subject.verification_runs?.find(r=>r.independent&&r.outcome==='pass'&&['recorded','accepted'].includes(r.receipt_status));
            if(subject.verification_plan)assert.ok(receipt,'Scripted acceptance requires a completed independent check.');
            return actor.submit({verdict:'accept',rung:'measured',notes_md:'Scripted judgment restricted to the finite fixture.',...(receipt?{verification_receipt_id:Number(receipt.id),verification_sufficiency_md:'The known fixture checker covers every declared finite term; no broader claim is made.'}:{})});
          }
          assert.ok(!actor.held.research_route_id,'A route investigation needs a scenario-specific decision.');return actor.submit();
        },
        async take(actor,predicate,limit=30) {
          for(let i=0;i<limit;i++){const a=await actor.start();if(predicate(a))return a;await world.finish(actor);}
          assert.fail(`No matching assignment for ${actor.name} within ${limit} scheduler decisions.`);
        },
        async invariant() {
          const duplicates=await db.q(`SELECT research_route_id FROM jobs WHERE problem_id=$1 AND research_route_id IS NOT NULL AND research_stage IN ('triage','pursue','rescue') AND status IN ('queued','assigned') GROUP BY research_route_id HAVING count(*)>1`,[pid]);assert.deepEqual(duplicates,[],'At most one open investigation per route.');
          const holds=await db.q(`SELECT assigned_session FROM jobs WHERE problem_id=$1 AND status='assigned' GROUP BY assigned_session HAVING count(*)>1`,[pid]);assert.deepEqual(holds,[],'At most one held assignment per session.');
          const unjudged=await db.q(`SELECT r.id FROM returns r WHERE r.problem_id=$1 AND r.status='accepted' AND NOT r.provisional AND NOT EXISTS(SELECT 1 FROM reviews v WHERE v.return_id=r.id AND v.trusted)`,[pid]);assert.deepEqual(unjudged,[],'Acceptance requires trusted scientific judgment.');
        },
        async snapshot() {
          const hours=await db.q(`SELECT a.tier,coalesce(a.research_stage,'unknown') AS stage,sum(a.budget_hours)::float AS hours,count(*)::int AS assignments FROM assignment_attempts a WHERE a.problem_id=$1 GROUP BY 1,2 ORDER BY 1,2`,[pid]);
          const jobs=await db.q(`SELECT type,status,count(*)::int AS count FROM jobs WHERE problem_id=$1 GROUP BY 1,2 ORDER BY 1,2`,[pid]);
          const routes=await db.q(`SELECT id,title,state,revision,last_return_id FROM research_routes WHERE problem_id=$1 ORDER BY id`,[pid]);
          const returns=await db.q(`SELECT type,status,count(*)::int AS count FROM returns WHERE problem_id=$1 GROUP BY 1,2 ORDER BY 1,2`,[pid]);
          const verification=await db.one(`SELECT count(*)::int AS receipts,count(DISTINCT v.fingerprint)::int AS packages,coalesce(sum(v.elapsed_seconds),0)::float AS observed_execution_seconds FROM verification_runs v JOIN returns r ON r.id=v.result_return_id WHERE r.problem_id=$1`,[pid]);
          const reuse=await db.one(`SELECT count(*)::int AS reviews_using_receipts,count(DISTINCT v.verification_receipt_id)::int AS receipts_used FROM reviews v JOIN returns r ON r.id=v.return_id WHERE r.problem_id=$1 AND v.verification_receipt_id IS NOT NULL`,[pid]);
          return {hours,jobs,routes,returns,verification:{...verification,...reuse}};
        },
        async fault(description,sql,params) {record('injected_fault',{description});return db.q(sql,params);},
      };return world;
    }};
  } catch(error) {await close();throw error;}
}
