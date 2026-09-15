import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLab} from './simulation/harness.mjs';
let lab,w,auth,terms,u,v,token,otherToken,dep,remote,external,one,two,general;
const random=()=>randomBytes(16).toString('hex');
before(async()=>{
  lab=await createLab(); w=await lab.project('departments',315);
  auth=await import('../src/lib/auth.ts'); terms=(await import('../src/lib/terms.ts')).TERMS_VERSION;
  u=await w.one(`INSERT INTO users(github_id,handle,terms_version) VALUES($1,$2,$3) RETURNING *`,[Math.floor(Math.random()*1e12),'department-owner-'+random(),terms]);
  v=await w.one(`INSERT INTO users(github_id,handle,terms_version) VALUES($1,$2,$3) RETURNING *`,[Math.floor(Math.random()*1e12),'department-other-'+random(),terms]);
  token=await auth.issueToken(Number(u.id)); otherToken=await auth.issueToken(Number(v.id));
  await w.q(`UPDATE problems SET research_allocation=NULL WHERE id=$1`,[w.pid]);
  for(let i=0;i<12;i++)await w.q(`INSERT INTO jobs(problem_id,type,title,brief_md,git_ref,budget_hours,min_tier) VALUES($1,'source',$2,'Look up a finite source.','main',.5,99)`,[w.pid,'Ordinary queue '+i]);
});
after(async()=>{await lab?.close();});
async function call(path,{run,body,headers={},status=200,credential=token,root=false}={}) {
  const h={authorization:`Bearer ${credential}`,accept:'application/json','x-model':'claude-opus-5','x-effort':'high',...(run?{'x-session':run.session,'x-department':run.department_id}:{}),...headers};
  if(body!==undefined)h['content-type']='application/json';
  const r=await fetch(w.origin+(root?'':w.base)+path,{headers:h,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json();assert.equal(r.status,status,`${path}: ${JSON.stringify(data).slice(0,700)}`);return data;
}
const bootstrap=(key=random(),credential)=>call('/departments/bootstrap',{credential,body:{registration_key:key}});
async function launch(department,direction,query='',credential=token){
  const key=random(),path='/start'+(query ? '?'+query.replace(/^&/, '') : ''),url=w.origin+w.base+path;
  const headers={'x-department':department,'x-launch-id':key,'x-instruction-url':url,...(direction?{'x-direction-id':direction}: {})};
  const result=await call(path,{headers,credential});
  return {...result,launch:key,launchHeaders:headers,query:path};
}
const submit=run=>call('/result',{run,headers:{'x-attempt':run.attempt_id},body:{job_id:run.job_id,report_md:'Planning fixture: bounded uncertainty remains.',transcript:'Scripted test: no model inference or token claims.',transcript_approved:true}});

async function account() {
  const user=await w.one(`INSERT INTO users(github_id,handle,terms_version) VALUES($1,$2,$3) RETURNING id`,[Math.floor(Math.random()*1e12),'framework-'+random(),terms]);
  return {id:Number(user.id),credential:await auth.issueToken(Number(user.id))};
}

test('the exact agent token survives concurrent retrieval, browser sign-in and logout; only explicit invalidation replaces it',async()=>{
  assert.deepEqual(await Promise.all(Array.from({length:5},()=>auth.issueToken(Number(u.id)))),Array(5).fill(token));
  const browser=await auth.issueBrowserSession(Number(u.id));
  const get=()=>call('/me/token',{root:true,body:{},headers:{authorization:'',cookie:'sah_session='+browser,'sec-fetch-site':'same-origin'}});
  assert.equal((await get()).token,token);
  await call('/auth/logout',{root:true,body:{},headers:{authorization:'',cookie:'sah_session='+browser}});
  assert.equal(await auth.issueToken(Number(u.id)),token);
  await call('/me',{root:true});
  const temp=await w.one(`INSERT INTO users(github_id,handle,terms_version) VALUES($1,$2,$3) RETURNING id`,[Math.floor(Math.random()*1e12),'legacy-'+random(),terms]);
  const legacy='sah_'+randomBytes(24).toString('base64url');
  await w.q(`INSERT INTO tokens(user_id,token_hash) VALUES($1,$2)`,[temp.id,auth.hashToken(legacy)]);
  await assert.rejects(auth.issueToken(Number(temp.id)),auth.TokenRecoveryRequired);
  await call('/me',{root:true,credential:legacy});
  assert.equal(await auth.issueToken(Number(temp.id)),legacy,'legacy hash-only token is captured unchanged');
  await auth.invalidateToken(Number(temp.id));
  assert.notEqual(await auth.issueToken(Number(temp.id)),legacy);
  assert.equal(await auth.issueToken(Number(u.id)),token,'other account stays unchanged');
});
test('concurrent folder bootstrap converges, another computer and another account stay distinct',async()=>{
  const key=random(),results=await Promise.all([bootstrap(key),bootstrap(key),bootstrap(key)]);
  assert.equal(new Set(results.map(x=>x.department_id)).size,1);dep=results[0].department_id;
  remote=(await bootstrap()).department_id;external=(await bootstrap(key,otherToken)).department_id;
  assert.notEqual(dep,remote);assert.notEqual(dep,external);
  await call('/start',{credential:otherToken,headers:{'x-department':dep,'x-launch-id':random()},status:403});
});
test('sibling directions and general mode remain separate; exact launch retries replay the compact scope',async()=>{
  const direction=await call(`/departments/${dep}/directions`,{body:{words:'Keep researching the finite alpha bound.'},headers:{'x-request-id':random()}});
  one=await launch(dep,direction.direction_id,'&directions=1');
  const second=await call(`/departments/${dep}/directions`,{body:{words:'Investigate beta counterexamples.'}});
  two=await launch(dep,second.direction_id);general=await launch(dep);
  assert.notEqual(one.run_id,two.run_id);assert.equal(one.direction.words,'Keep researching the finite alpha bound.');
  assert.equal(two.direction.words,'Investigate beta counterexamples.');assert.equal(general.direction,null);
  for(const run of [one,two,general])assert.match(run.brief_md,/self-review your local framework/);
  assert.match(general.brief_md,/Ordinary queue/);assert.doesNotMatch(general.brief_md,/alpha|beta/);
  const replay=await call(one.query,{headers:one.launchHeaders});assert.equal(replay.attempt_id,one.attempt_id);assert.equal(replay.brief_md,one.brief_md);
  assert.ok(one.brief_md.length<6000,`effective brief should be compact (${one.brief_md.length})`);
  await call('/run/context',{run:one,headers:{'x-department':remote},status:403});
  const before=await w.one(`SELECT count(*)::int n FROM sessions WHERE problem_id=$1`,[w.pid]);
  await call('/start',{headers:{'x-department':dep,'x-launch-id':random(),'x-direction-id':direction.direction_id},status:409});
  assert.equal((await w.one(`SELECT count(*)::int n FROM sessions WHERE problem_id=$1`,[w.pid])).n,before.n);
});
test('a completed first task retains the direction and requires a justified next step; updates preserve in-flight provenance',async()=>{
  await submit(one);
  const waiting=await call('/start',{run:one});assert.equal(waiting.state,'needs_next_step');assert.equal(waiting.job_id,undefined);
  await call('/run/next-step',{run:one,body:{revision:0,title:'stale',question:'q',why:'w',stop_when:'s',budget_hours:.5},status:409});
  const next=await call('/run/next-step',{run:one,body:{revision:1,title:'Alpha finite test',question:'Test alpha for n=12.',why:'Bound the alpha uncertainty.',stop_when:'One finite witness or the bound.',budget_hours:.5},headers:{'x-request-id':'nextstep_'+random()}});
  const second=await call('/start',{run:one});assert.equal(second.job_id,next.job_id);assert.equal(second.direction.words,one.direction.words);Object.assign(one,second);
  assert.match(second.brief_md,/Build and validate missing essentials now/);
  assert.match(second.brief_md,/self-review your local framework/);
  await call('/run/direction',{run:one,body:{revision:1,words:'Now test alpha for n=13.',user_instruction:true}});
  const current=await call('/run/context',{run:one});assert.equal(current.direction.revision,2);assert.equal(current.attempt.direction_snapshot.revision,1);
  assert.equal((await call('/start',{run:one})).direction.revision,1,'held attempt replays issued scope');
  await submit(one);
  await call('/run/direction',{run:one,body:{revision:2,state:'complete',note:'The requested scope is complete.'}});
  assert.equal((await call('/start',{run:one})).state,'complete');
  assert.equal((await call('/run/context',{run:two})).direction.words,'Investigate beta counterexamples.');
  const saved=await w.one(`SELECT scheduled,department_id,run_id FROM assignment_attempts WHERE id=$1`,[one.attempt_id]);
  assert.equal(saved.scheduled,false);assert.equal(saved.department_id,dep);
});
test('one-task caps stop directed work, and explicit continuation copies direction without copying consent',async()=>{
  const copy=await call(`/departments/${dep}/directions`,{body:{continue_direction_id:two.direction.id}});
  const bounded=await launch(dep,copy.direction_id,'&time=1task&share=0&subagents=no');
  await submit(bounded);await call('/start',{run:bounded,status:409});
  assert.notEqual(copy.direction_id,two.direction.id);
  await call('/run/direction',{run:two,body:{revision:1,words:'Beta revised by its user.',user_instruction:true}});
  assert.equal((await call('/run/context',{run:bounded})).direction.words,'Investigate beta counterexamples.');
});
test('department questions have one fenced answer, retained deliveries and idempotent retries',async()=>{
  const asker=await launch(remote);
  const ask=await call('/asks',{run:asker,body:{to_department:dep,body_md:'What did the alpha investigation find?'},headers:{'x-request-id':'ask_'+random()}});
  const inbox=await call('/department/inbox',{run:general});assert.ok(inbox.questions.some(x=>x.id===ask.id));
  const requests=await Promise.all([general,two].map(run=>fetch(w.origin+w.base+`/asks/${ask.id}/claim`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json','x-model':'claude-opus-5','x-session':run.session,'x-department':dep},body:'{}'})));
  assert.deepEqual(requests.map(r=>r.status).sort(),[200,409]);
  const winner=requests[0].status===200?general:two, loser=winner===general?two:general;
  const claim=await requests.find(r=>r.status===200).json();
  await call(`/asks/${ask.id}/answer`,{run:loser,body:{body_md:'Duplicate',claim_generation:claim.claim_generation},status:409});
  await call('/chat/messages',{run:loser,body:{kind:'reply',reply_to:ask.message_id,body_md:'Bypass'},status:409});
  const request='answer_'+random(),body={body_md:'The saved local evidence records a finite bound, not a proof.',claim_generation:claim.claim_generation};
  const answer=await call(`/asks/${ask.id}/answer`,{run:winner,body,headers:{'x-request-id':request}});
  assert.deepEqual(await call(`/asks/${ask.id}/answer`,{run:winner,body,headers:{'x-request-id':request}}),answer);
  await call(`/asks/${ask.id}/answer`,{run:winner,body:{...body,body_md:'Changed'},headers:{'x-request-id':request},status:409});
  const messages=await call('/department/inbox',{run:asker});assert.ok(messages.deliveries.some(x=>Number(x.message_id)===Number(answer.message_id)));
  assert.deepEqual((await call('/department/inbox',{run:asker})).deliveries,messages.deliveries,'reading does not acknowledge');
  await call('/department/inbox/ack',{run:asker,body:{delivery_ids:messages.deliveries.map(x=>x.id)}});
  assert.equal((await call('/department/inbox',{run:asker})).deliveries.length,0);
  const publicAsk=await call(`/asks/${ask.id}`);assert.equal(publicAsk.ask.claimed_session,undefined);assert.equal(publicAsk.ask.from_session,undefined);
});
test('an exact run hands off only within its department, and only when allowed',async()=>{
  const asker=await launch(remote),original=await launch(dep);
  const fallback=await call('/asks',{run:asker,body:{to_run:original.run_id,body_md:'Please explain the local evidence.',handoff:'department'}});
  const exact=await call('/asks',{run:asker,body:{to_run:original.run_id,body_md:'This question is only for this run.',handoff:'none'}});
  await call(`/asks/${fallback.id}/claim`,{run:general,body:{},status:403});
  await call(`/sessions/${original.session}/end`,{run:original,body:{note:'fixture ended'}});
  await call(`/asks/${fallback.id}/claim`,{run:general,body:{}});
  await call(`/asks/${exact.id}/claim`,{run:general,body:{},status:403});
  await call(`/asks/${fallback.id}/claim`,{run:asker,body:{},status:403});
});
test('public identity never exposes session credentials; forged chat sessions are rejected',async()=>{
  const directory=await call('/who');assert.ok(directory.departments.some(x=>x.department_id===dep));
  const text=JSON.stringify(directory);assert.ok(!text.includes(general.session));
  await call('/chat/messages',{run:general,body:{body_md:'Forged session'},headers:{'x-session':random()},status:403});
  const message=await call('/chat/messages',{run:general,body:{body_md:'A reusable local finding exists.'}});
  const record=await call(`/chat/messages/${message.id}`);assert.equal(record.run_id,general.run_id);assert.equal(record.department_id,dep);assert.equal(record.session,undefined);
});

test('recovery needs a fresh eligible run in the original department and fences the old attempt',async()=>{
  const before=await launch(dep);
  await call('/release',{run:before,body:{job_id:before.job_id,note:'Interrupted with checkpoint'},headers:{'x-attempt':before.attempt_id}});
  const resumed=await call('/start',{headers:{'x-department':dep,'x-launch-id':random(),'x-recover-attempt':before.attempt_id}});
  assert.equal(resumed.job_id,before.job_id);assert.notEqual(resumed.attempt_id,before.attempt_id);
  await call('/result',{run:before,body:{job_id:before.job_id,report_md:'Stale result',transcript:'test',transcript_approved:true},headers:{'x-attempt':before.attempt_id},status:409});
  assert.equal((await w.one(`SELECT new_attempt_id FROM assignment_recoveries WHERE old_attempt_id=$1`,[before.attempt_id])).new_attempt_id,resumed.attempt_id);
});

test('linked work keeps ordinary eligibility and channel membership stays per run',async()=>{
  await call('/chat/join',{run:general,body:{}});const joined=await call('/chat/join',{run:two,body:{}});
  assert.ok(joined.members.some(m=>m.run_id===general.run_id));assert.ok(joined.members.some(m=>m.run_id===two.run_id));
  await call('/chat/leave',{run:two,body:{}});
  const retained=await w.one(`SELECT 1 FROM run_channel_members WHERE session_id=$1`,[general.session]);assert.ok(retained);
  const linked=await w.one(`INSERT INTO jobs(problem_id,type,title,brief_md,git_ref,budget_hours,min_tier,required_sources) VALUES($1,'source','Link needs archive','Inspect one source.','main',.5,99,ARRAY['restricted-archive']) RETURNING id`,[w.pid]);
  const d=await call('/run/context',{run:two});
  await call('/run/link-step',{run:two,body:{revision:d.direction.revision,job_id:linked.id,why:'The original beta source resolves this question.'}});
  await call('/release',{run:two,body:{job_id:two.job_id,note:'Use linked source'},headers:{'x-attempt':two.attempt_id}});
  assert.equal((await call('/start',{run:two})).state,'needs_next_step','a link does not grant private source access');
  await call(`/sessions/${two.session}/capabilities`,{run:two,body:{capabilities:{sources:['restricted-archive']}}});
  assert.equal((await call('/start',{run:two})).job_id,linked.id);
});

test('database guards prohibit automatic token revocation and preserve all active token hashes on migration',async()=>{
  const old=await w.one(`SELECT token_hash FROM tokens WHERE user_id=$1 AND revoked_at IS NULL`,[u.id]);
  await assert.rejects(w.q(`UPDATE tokens SET revoked_at=now() WHERE user_id=$1`,[u.id]),/explicit user invalidation/);
  await (await import('../src/db/index.ts')).migrate();
  assert.deepEqual(await w.one(`SELECT token_hash FROM tokens WHERE user_id=$1 AND revoked_at IS NULL`,[u.id]),old);
  assert.equal(await auth.issueToken(Number(u.id)),token);
});

test('guidance discovery supports API-only clients, a local handoff and a separate computer',async()=>{
  const {credential,id}=await account();
  const contract=await call('/joining-contract',{credential});
  assert.equal(contract.distribution,'guidance');assert.equal(contract.helper_url,undefined);
  assert.match(contract.guidance,/before requesting any assignment/);
  assert.match(contract.guidance,/Do not call the joining URL.*until readiness passes/);
  assert.match(contract.guidance,/Before every assignment, self-review/);
  const response=await fetch(contract.protocol_url);assert.equal(response.status,200);
  const protocol=await response.json();assert.match(protocol.version,/^department-v2\./);
  assert.equal(protocol.helper,undefined);assert.equal(protocol.effort_commands,undefined);
  assert.match(protocol.sections.bootstrap,/X-Instruction-URL/);assert.match(protocol.sections.api,/X-Request-ID/);
  assert.match(protocol.sections.publication,/Transcript \(required\)/);
  assert.match(protocol.sections.bootstrap,/Required before research/);
  assert.ok(protocol.sections.bootstrap.indexOf('6. Implement and exercise')<protocol.sections.bootstrap.indexOf('7. Only after readiness passes'));
  assert.match(protocol.sections.lifecycle,/no work and submit nothing/);
  assert.match(protocol.sections.lifecycle,/nonzero exit status/);
  assert.match(protocol.sections.lifecycle,/all-complete verification fails/);
  assert.match(protocol.sections.accounting,/accepted does not prove token credit/);
  assert.match(protocol.sections.framework,/persist and reload task progress/);
  assert.match(protocol.sections.framework,/research completion, server submission and accounting completeness separately/);
  assert.match(protocol.sections.accounting,/Implement or reuse and validate/);
  assert.match(protocol.sections.accounting,/Freebuff/);
  assert.match(protocol.sections.accounting,/next authorized startup or job/);
  const framework=await call('/department-protocol?section=framework',{credential});
  assert.deepEqual(Object.keys(framework.sections),['framework']);
  const focused=await call('/department-protocol?section=accounting',{credential});
  assert.deepEqual(Object.keys(focused.sections),['accounting']);assert.equal(focused.version,protocol.version);
  const markdown=await fetch(contract.protocol_url+'?section=bootstrap',{headers:{accept:'text/markdown'}});
  assert.match(markdown.headers.get('vary'),/Accept/);
  assert.match(markdown.headers.get('content-type'),/text\/markdown/);assert.match(await markdown.text(),/POST .*\/departments\/bootstrap/);
  await call('/department-protocol?section=toString',{credential,status:400});
  await call('/department-protocol?section=bootstrap&section=api',{credential,status:400});
  // Deliberately plain HTTP and files: no production client or fixed local database.
  // This is a scripted handoff fixture, not evidence that arbitrary generated tools are safe.
  const folder=mkdtempSync(join(tmpdir(),'sah-guidance-ü-'));
  const words='Study “alpha” exactly.\nPreserve this direction across assignments.';
  try {
    mkdirSync(join(folder,'runs'));
    const key=random(),manifest={server:w.origin,account_id:(await call('/me',{credential,root:true})).account_id,registration_key:key};
    writeFileSync(join(folder,'department.json'),JSON.stringify(manifest),'utf8');
    const bindings=await Promise.all([bootstrap(key,credential),bootstrap(key,credential)]);
    assert.equal(bindings[0].department_id,bindings[1].department_id);
    const did=bindings[0].department_id;
    const direction=await call(`/departments/${did}/directions`,{credential,body:{words},headers:{'x-request-id':random()}});
    const [first,second]=await Promise.all([launch(did,direction.direction_id,'&directions=1',credential),launch(did,null,'',credential)]);
    for(const run of [first,second])writeFileSync(join(folder,'runs',run.run_id+'.json'),JSON.stringify(run),'utf8');
    assert.equal(first.direction.words,words);assert.equal(second.direction,null);assert.notEqual(first.session,second.session);
    const requestId=random(),body={job_id:first.job_id,report_md:'A bounded alpha question remains unresolved.',transcript:'Scripted API fixture; no claimed computation.',transcript_approved:true};
    const receipt=await call('/result',{credential,run:first,body,headers:{'x-attempt':first.attempt_id,'x-request-id':requestId}});
    assert.deepEqual(await call('/result',{credential,run:first,body,headers:{'x-attempt':first.attempt_id,'x-request-id':requestId}}),receipt);
    const note={id:random(),topic:'alpha',body:body.report_md,author_run:first.run_id,return_id:receipt.return_id,status:'submitted',uncertainty:'No proof established.'};
    writeFileSync(join(folder,'evidence.json'),JSON.stringify(note),'utf8');
    writeFileSync(join(folder,'README.md'),'Research is in evidence.json; private run bindings are under runs/.','utf8');
    await call(`/sessions/${first.session}/end`,{credential,run:first,body:{}});
    const successor=await launch(did,null,'',credential),saved=JSON.parse(readFileSync(join(folder,'evidence.json'),'utf8'));
    assert.equal(successor.direction,null);assert.equal(saved.author_run,first.run_id);
    const remoteDepartment=(await bootstrap(random(),credential)).department_id;
    const remoteRun=await launch(remoteDepartment,null,'',credential);
    const ask=await call('/asks',{credential,run:remoteRun,body:{to_department:did,body_md:'What is known about alpha?'}});
    const claim=await call(`/asks/${ask.id}/claim`,{credential,run:successor,body:{}});
    const answer=await call(`/asks/${ask.id}/answer`,{credential,run:successor,body:{body_md:`${saved.body} Source: return #${saved.return_id}, original run ${saved.author_run}.`,claim_generation:claim.claim_generation}});
    const message=await call(`/chat/messages/${answer.message_id}`,{credential});assert.equal(message.run_id,successor.run_id);
    assert.notEqual(remoteRun.department_id,did);assert.equal(await auth.issueToken(id),credential);
    assert.equal((await call('/run/context',{credential,run:second})).direction,null);
  } finally {rmSync(folder,{recursive:true,force:true});}
});

test('ended runs can correct their own historical transcripts with exact retries, without starting work',async()=>{
  const {credential}=await account(),did=(await bootstrap(random(),credential)).department_id;
  const author=await launch(did,null,'',credential),sibling=await launch(did,null,'',credential);
  const receipt=await call('/result',{credential,run:author,headers:{'x-attempt':author.attempt_id},body:{job_id:author.job_id,report_md:'A scoped source observation.',transcript:'Pending usage fixture.',transcript_approved:true}});
  await call(`/sessions/${author.session}/end`,{credential,run:author,body:{}});
  const transcript=JSON.stringify({type:'assistant',effort:'high',timestamp:new Date().toISOString(),message:{id:random(),model:'claude-opus-5',usage:{input_tokens:100,output_tokens:20},content:[{type:'text',text:`Observed assignment #${author.job_id}.`}]}});
  const path=`/return/${receipt.return_id}/transcript`,body={transcript},headers={'x-request-id':random()};
  await call(path,{credential,run:sibling,body,status:403});
  await call(path,{credential:otherToken,body,status:403});
  const corrected=await call(path,{credential,run:author,body,headers});assert.equal(corrected.tokens.output,20);
  assert.deepEqual(await call(path,{credential,run:author,body,headers}),corrected);
  await call(path,{credential,run:author,body:{transcript:transcript+'\n'},headers,status:409});
  await call('/chat/messages',{credential,run:author,body:{body_md:'No new activity'},status:409});
  await call('/run/next-step',{credential,run:author,body:{},status:409});
  await call('/files',{credential,run:author,root:true,body:{name:'ended.txt',content:'no new uploads'},status:409});
  await call('/start',{credential,run:author,status:409});
  const recovered=await call(path,{credential,body,headers:{'x-request-id':random()}});assert.equal(recovered.tokens.output,20,'account-level recovery retains validation and deduplication');
  const stored=await w.one(`SELECT run_id,tokens,transcript_resubmitted_at FROM returns WHERE id=$1`,[receipt.return_id]);
  assert.equal(stored.run_id,author.run_id);assert.equal(stored.tokens.output,20);assert.ok(stored.transcript_resubmitted_at);
});

test('ended review runs can attach their own usage, including self-assigned reviews',async()=>{
  const {credential}=await account(),did=(await bootstrap(random(),credential)).department_id;
  const reviewer=await launch(did,null,'',credential);
  await call('/release',{credential,run:reviewer,headers:{'x-attempt':reviewer.attempt_id},body:{job_id:reviewer.job_id,note:'Scripted advisory review fixture'}});
  const subject=await w.one(`SELECT id FROM returns WHERE problem_id=$1 AND user_id=$2 ORDER BY id LIMIT 1`,[w.pid,u.id]);
  await call(`/return/${subject.id}/request-review`,{credential,run:reviewer,body:{note:'Review the bounded fixture claim.'}});
  const result=await call('/result',{credential,run:reviewer,body:{type:'review',return_id:Number(subject.id),verdict:'reject',rung:'conjectured',verification:'read',notes_md:'Scripted fixture: evidence is incomplete.',transcript:'Pending usage fixture.',transcript_approved:true}});
  assert.ok(result.review_id);
  await call(`/sessions/${reviewer.session}/end`,{credential,run:reviewer,body:{}});
  const transcript=JSON.stringify({type:'assistant',message:{id:random(),model:'claude-opus-5',usage:{input_tokens:30,output_tokens:10}}});
  const body={transcript},path=`/review/${result.review_id}/transcript`;
  const corrected=await call(path,{credential,run:reviewer,body,headers:{'x-request-id':random()}});
  assert.equal(corrected.tokens.output,10);
  const sibling=await launch(did,null,'',credential);
  await call(path,{credential,run:sibling,body,status:403});
});

test('pausing department launches covers existing folders but preserves exact retries and live sessions',async()=>{
  const {credential}=await account(),did=(await bootstrap(random(),credential)).department_id;
  const run=await launch(did,null,'',credential),previous=process.env.DEPARTMENT_MODE;
  try {
    process.env.DEPARTMENT_MODE='off';
    assert.equal((await call('/joining-contract',{credential})).enabled,false);
    await call('/start',{credential,headers:{'x-department':did,'x-launch-id':random()},status:503});
    assert.equal((await call(run.query,{credential,headers:run.launchHeaders})).session,run.session);
    assert.equal((await call('/start',{credential,run})).attempt_id,run.attempt_id);
  } finally {if(previous===undefined)delete process.env.DEPARTMENT_MODE;else process.env.DEPARTMENT_MODE=previous;}
});

test('a timed run finishing a held task retains its addressed questions until its work is complete',async()=>{
  const {credential}=await account(),did=(await bootstrap(random(),credential)).department_id;
  const original=await launch(did,null,'&time=2h',credential),sibling=await launch(did,null,'',credential);
  await w.q(`UPDATE sessions SET ends_at=now()-interval '1 minute' WHERE id=$1`,[original.session]);
  const ask=await call('/asks',{credential,run:sibling,body:{to_run:original.run_id,body_md:'Clarify the held evidence.',handoff:'department'}});
  await call(`/asks/${ask.id}/claim`,{credential,run:sibling,body:{},status:403});
  const claimed=await call(`/asks/${ask.id}/claim`,{credential,run:original,body:{}});
  await call(`/asks/${ask.id}/answer`,{credential,run:original,body:{body_md:'The held task remains in progress.',claim_generation:claimed.claim_generation}});
  await call('/release',{credential,run:original,headers:{'x-attempt':original.attempt_id},body:{job_id:original.job_id,note:'Finished the bounded investigation'}});
  await call('/department/inbox',{credential,run:original,status:403});
});

test('expired directed assignments retire so the direction can choose another bounded step',async()=>{
  const {credential}=await account(),did=(await bootstrap(random(),credential)).department_id;
  const d=await call(`/departments/${did}/directions`,{credential,body:{words:'Investigate gamma sources.'}});
  const run=await launch(did,d.direction_id,'',credential);
  await w.q(`UPDATE jobs SET expires_at=now()-interval '1 minute' WHERE id=$1`,[run.job_id]);
  assert.equal((await call('/start',{credential,run})).state,'needs_next_step');
  assert.equal((await w.one(`SELECT status FROM jobs WHERE id=$1`,[run.job_id])).status,'expired');
  const next=await call('/run/next-step',{credential,run,body:{revision:1,title:'Gamma source lookup',question:'Which finite bound is sourced?',why:'The prior attempt expired without evidence.',stop_when:'One source or a missing-source report.',budget_hours:.5}});
  assert.equal((await call('/start',{credential,run})).job_id,next.job_id);
});

test('folder agents can ask already-running legacy research contacts and retain their answers',async()=>{
  const {credential}=await account(),did=(await bootstrap(random(),credential)).department_id;
  const asker=await launch(did,null,'',credential);
  const legacy=await call('/start',{credential,headers:{'x-launch-id':random(),'x-capabilities':JSON.stringify({research:'Finite archive evidence'})}});
  assert.ok(legacy.contact_id);
  const ask=await call('/asks',{credential,run:asker,body:{to_contact:legacy.contact_id,body_md:'What does the archive say?'}});
  assert.equal(ask.routing,null);
  const answer=await call(`/asks/${ask.id}/answer`,{credential,headers:{'x-session':legacy.session},body:{body_md:'The available archive leaves the bound unresolved.'}});
  assert.ok((await call('/department/inbox',{credential,run:asker})).deliveries.some(x=>Number(x.message_id)===Number(answer.message_id)));
});

test('a recipient needs a current question claim to delegate substantial research',async()=>{
  const asker=await launch(external,null,'',otherToken);
  const ask=await call('/asks',{credential:otherToken,run:asker,body:{to_department:dep,body_md:'Which source resolves the missing lemma?'}});
  const original=await call(`/asks/${ask.id}/claim`,{run:general,body:{}});
  await w.q(`UPDATE asks SET claim_until=now()-interval '1 minute' WHERE id=$1`,[ask.id]);
  await call(`/asks/${ask.id}/research`,{run:general,body:{claim_generation:original.claim_generation},status:403});
  const renewed=await call(`/asks/${ask.id}/claim`,{run:general,body:{}});
  await call(`/asks/${ask.id}/research`,{run:general,body:{claim_generation:renewed.claim_generation-1},status:403});
  const research=await call(`/asks/${ask.id}/research`,{run:general,body:{claim_generation:renewed.claim_generation}});
  assert.ok(research.job_id);assert.equal((await call(`/asks/${ask.id}`)).ask.status,'researching');
});

test('reconciliation exposes a never-submitted attempt, its eventual receipt, and a distinct release outcome',async()=>{
  const {credential}=await account(),did=(await bootstrap(random(),credential)).department_id;
  const direction=await call(`/departments/${did}/directions`,{credential,body:{words:'Verify lifecycle evidence for a bounded task.'}});
  const run=await launch(did,direction.direction_id,'',credential);
  const outstanding=await call('/run/context',{credential,run});
  assert.equal(outstanding.attempt.id,run.attempt_id);assert.equal(outstanding.attempt.status,'assigned');
  assert.equal(outstanding.attempt.receipt,null);assert.equal(Number(outstanding.attempt.assignment_payload.job_id),Number(run.job_id));
  const holds=async()=>((await call('/sessions',{credential,run})).sessions.find(s=>s.id===run.session)).holds;
  assert.ok((await holds()).some(j=>Number(j.id)===Number(run.job_id)));
  await call('/result',{credential,run,headers:{'x-attempt':run.attempt_id},body:{job_id:run.job_id},status:400});
  assert.equal((await call('/run/context',{credential,run})).attempt.receipt,null,'validation refusal cannot supply completion evidence');
  const receipt=await call('/result',{credential,run,headers:{'x-attempt':run.attempt_id,'x-request-id':random()},body:{job_id:run.job_id,report_md:'Lifecycle fixture: the bounded question remains unresolved.',transcript:'Scripted fixture with no model inference.',transcript_approved:true}});
  const completed=await call('/run/context',{credential,run});
  assert.equal(completed.attempt.status,'completed');assert.deepEqual(completed.attempt.receipt,receipt);
  assert.equal((await holds()).length,0);
  assert.equal(Number((await call(`/return/${receipt.return_id}`,{credential})).id),Number(receipt.return_id));
  const next=await call('/run/next-step',{credential,run,body:{revision:1,title:'Lifecycle follow-up',question:'Record a bounded follow-up.',why:'Check its explicit release outcome.',stop_when:'One checkpoint.',budget_hours:.5}});
  const assigned=await call('/start',{credential,run});assert.equal(assigned.job_id,next.job_id);
  const released=await call('/release',{credential,run,headers:{'x-attempt':assigned.attempt_id},body:{job_id:assigned.job_id,note:'Stopped at the fixture boundary'}});
  const ended=await call('/run/context',{credential,run});
  assert.ok(['released','cancelled'].includes(ended.attempt.status));assert.deepEqual(ended.attempt.receipt,released);
  assert.equal(ended.attempt.receipt.return_id,undefined,'release is not a submitted research result');
});
