import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const dir = mkdtempSync(join(tmpdir(), 'record-credit-'));
const slug = `record-credit-${Date.now()}`;
process.env.PROJECTS_DIR = dir;
mkdirSync(join(dir,slug));
const config = JSON.parse(readFileSync(new URL('../projects/md5/project.json', import.meta.url),'utf8'));
writeFileSync(join(dir,slug,'project.json'),JSON.stringify({...config,slug}));
const {migrate,q,one,pool,projectTransaction} = await import('../src/db/index.ts');
const {submit,challengeConfig,recordCreditPlan,reconcileRecordCredit,submissionRow,publicSubmission} = await import('../src/lib/challenges.ts');
const {standings} = await import('../src/lib/standings.ts');
const {leaderboard} = await import('../src/lib/credit.ts');
const users=[];
let pid, seq=0;
const track=challengeConfig(slug).tracks[0];
const send=(u,candidate,extra={}) => projectTransaction(pid,()=>submit({problemId:pid,slug,userId:users[u],sessionId:null,jobId:null,model:'gpt-6-astra'},
  {challenge_id:track.id,idempotency_key:`recordtest-${++seq}`,candidate,...extra}));
const net=async sid => Number((await one(`SELECT coalesce(sum(points),0) AS p FROM credits WHERE kind='record' AND source_type='challenge_submission' AND source_id=$1`,[String(sid)])).p);
before(async()=>{
  await migrate();
  pid=Number((await one(`INSERT INTO problems(slug,name,repo_url) VALUES($1,'Record test','https://example.org') RETURNING id`,[slug])).id);
  await q(`INSERT INTO lanes(problem_id,slug,title) VALUES($1,$2,'Record test')`,[pid,track.lane]);
  for(let i=0;i<3;i++) users.push(Number((await one(`INSERT INTO users(github_id,handle) VALUES($1,$2) RETURNING id`,[Math.floor(950000000+Math.random()*10000000),`${slug}-${i}`])).id));
});
after(async()=>{
  await q(`DELETE FROM credits WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM challenge_corrections WHERE submission_id IN(SELECT id FROM challenge_submissions WHERE problem_id=$1)`,[pid]);
  await q(`DELETE FROM challenge_events WHERE problem_id=$1`,[pid]);
  await q(`UPDATE challenge_submissions SET duplicate_of=NULL WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM challenge_submissions WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM lanes WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM problems WHERE id=$1`,[pid]);
  await q(`DELETE FROM users WHERE id=ANY($1)`,[users]);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM credits WHERE problem_id=$1`,[pid])).n),0);
  await pool.end();rmSync(dir,{recursive:true,force:true});
});
let old, improved, reference, tied;
test('receipts pay immediately without a report, only higher tiers add points and the model gets none',async()=>{
  old=(await send(0,'000000000000000000000000000000e6')).body.submission_id; // score 2
  let candidate;
  for(let i=0;i<8192;i++){const c=i.toString(16).padStart(32,'0'),d=createHash('md5').update(c).digest('hex');if(c.slice(0,2)===d.slice(0,2)&&c[2]!==d[2]&&c!=='000000000000000000000000000000e6'){candidate=c;break;}}
  assert.ok(candidate,'bounded fixture search finds a distinct score-2 candidate');
  tied=(await send(2,candidate)).body.submission_id;assert.equal(await net(tied),0);
  improved=(await send(0,'72690dc972013c32bce5e984a6681b99')).body.submission_id; // score 5
  assert.equal(await net(old),60);assert.equal(await net(improved),0);
  const out=await send(1,'7087922310543c220000bb7b19348954'); // independently found published-reference match
  reference=out.body.submission_id;
  assert.equal(out.body.score,12);assert.equal(out.body.record_credit.points,100);
  assert.equal(await net(reference),100);
  const c=await one(`SELECT model,provider FROM credits WHERE source_type='challenge_submission' AND source_id=$1`,[String(reference)]);
  assert.equal(c.model,null);assert.equal(c.provider,null);
  assert.equal((await one(`SELECT count(*)::int AS n FROM returns WHERE problem_id=$1`,[pid])).n,0);
  const st=await standings(pid,'all',50);
  assert.equal(Number(st.people.find(r=>r.handle===`${slug}-1`).points),100);
  assert.equal(st.leaders.record.handle,`${slug}-1`);
  const board=await leaderboard(pid,'all');assert.equal(Number(board.by_kind.record[0].points),100);
});
test('concurrent duplicate receipts, replay and demo do not repay or change attribution',async()=>{
  const many=await Promise.all(Array.from({length:4},()=>send(2,'7087922310543c220000bb7b19348954')));
  for(const out of many){assert.equal(out.body.duplicate_of,reference);assert.equal(out.body.record_credit.points,0);}
  const body={challenge_id:track.id,candidate:'7087922310543c220000bb7b19348954',idempotency_key:'replay-record-credit'};
  const ctx={problemId:pid,slug,userId:users[2],sessionId:null,jobId:null,model:null};
  const first=await projectTransaction(pid,()=>submit(ctx,body));
  const again=await projectTransaction(pid,()=>submit(ctx,body));
  assert.equal(again.status,200);assert.equal(again.body.submission_id,first.body.submission_id);
  assert.equal(await net(first.body.submission_id),0);
  const demo=await send(2,'7087922310543c220000bb7b19348954',{demo:true});assert.equal(demo.body.record_credit.points,0);
});
test('void and restore append balancing entries, retain original credit and are idempotent',async()=>{
  const correction=async kind=>projectTransaction(pid,async()=>{
    await q(`INSERT INTO challenge_corrections(submission_id,kind,note,user_id) VALUES($1,$2,'test correction',$3)`,[reference,kind,users[0]]);
    await reconcileRecordCredit(pid,slug,track,'managed');
  });
  await correction('void');assert.equal(await net(reference),0);
  const rows=await q(`SELECT points::int FROM credits WHERE source_type='challenge_submission' AND source_id=$1 ORDER BY id`,[String(reference)]);
  assert.deepEqual(rows.map(r=>r.points),[100,-100]);
  assert.equal(publicSubmission(await submissionRow(pid,reference)).record_credit.points,0);
  await correction('restore');assert.equal(await net(reference),100);
  await reconcileRecordCredit(pid,slug,track,'managed');
  assert.equal((await one(`SELECT count(*)::int AS n FROM credits WHERE source_type='challenge_submission' AND source_id=$1`,[String(reference)])).n,3);
});
test('historical backfill plans without writes and applies once without rewriting receipts',async()=>{
  await q(`DELETE FROM credits WHERE problem_id=$1`,[pid]); // simulate a pre-policy history, only in this test's fixture
  await q(`UPDATE challenge_submissions SET response=response-'record_credit' WHERE problem_id=$1`,[pid]);
  const original=await q(`SELECT id,response FROM challenge_submissions WHERE problem_id=$1 ORDER BY id`,[pid]);
  const plan=await recordCreditPlan(pid,slug,track);
  assert.equal(plan.reduce((s,r)=>s+r.delta,0),160);
  assert.equal((await one(`SELECT count(*)::int AS n FROM credits WHERE problem_id=$1`,[pid])).n,0);
  const dry=execFileSync(process.execPath,['--import','tsx','scripts/record-credit-backfill.ts',`--project=${slug}`],{env:process.env,encoding:'utf8'});
  assert.ok(JSON.parse(dry.trim().split('\n')[0]).changes.length>0);
  execFileSync(process.execPath,['--import','tsx','scripts/record-credit-backfill.ts',`--project=${slug}`,'--apply'],{env:process.env,encoding:'utf8'});
  assert.equal(await net(old),60);assert.equal(await net(reference),100);
  assert.deepEqual(await q(`SELECT id,response FROM challenge_submissions WHERE problem_id=$1 ORDER BY id`,[pid]),original);
  const count=(await one(`SELECT count(*)::int AS n FROM credits WHERE problem_id=$1`,[pid])).n;
  await reconcileRecordCredit(pid,slug,track);
  assert.equal((await one(`SELECT count(*)::int AS n FROM credits WHERE problem_id=$1`,[pid])).n,count);
  await projectTransaction(pid,async()=>{
    await q(`INSERT INTO challenge_corrections(submission_id,kind,note,user_id) VALUES($1,'void','historical priority test',$2)`,[old,users[0]]);
    await reconcileRecordCredit(pid,slug,track,'managed');
  });
  assert.equal(await net(old),0);assert.equal(await net(tied),60);assert.equal(await net(improved),60);
  await projectTransaction(pid,async()=>{
    await q(`INSERT INTO challenge_corrections(submission_id,kind,note,user_id) VALUES($1,'restore','historical priority test',$2)`,[old,users[0]]);
    await reconcileRecordCredit(pid,slug,track,'managed');
  });
  assert.equal(await net(old),60);assert.equal(await net(tied),0);assert.equal(await net(improved),0);
});


test('independent concurrent improvements on another track share the cap, without changing research credit',async()=>{
  const zero=challengeConfig(slug).tracks[1];
  const ctx={problemId:pid,slug,userId:users[0],sessionId:null,jobId:null,model:'gpt-6-astra'};
  const results=await Promise.all(['06','9b37e36766f0622f34777adbc78a4ab0'].map(input_hex=>projectTransaction(pid,()=>submit(ctx,
    {challenge_id:zero.id,idempotency_key:`concurrent-credit-${++seq}`,input_hex}))));
  assert.ok(results.every(r=>r.status===201));
  assert.equal(results.reduce((s,r)=>s+r.body.record_credit.points,0),60);
  assert.equal(Number((await one(`SELECT sum(points) AS p FROM credits WHERE problem_id=$1 AND kind='record' AND source_id=ANY($2)`,[pid,results.map(r=>String(r.body.submission_id))])).p),60);
  assert.equal((await one(`SELECT count(*)::int AS n FROM credits WHERE problem_id=$1 AND kind='result'`,[pid])).n,0);
});
