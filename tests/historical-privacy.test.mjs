import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import express from 'express';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const tmp = mkdtempSync(join(tmpdir(), 'sah-historical-privacy-'));
for (const [name, folder] of [['PROJECTS_DIR','projects'],['DOCS_DIR','repos'],['FILES_DIR','files'],['OVERLAY_DIR','overlay']]) process.env[name] = join(tmp, folder);
const {migrate, one, q, pool} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job} = await import('../src/routes/job.ts');
const {filesRouter} = await import('../src/routes/files.ts');
const slug = `historical-privacy-${randomUUID().slice(0,8)}`;
const model = 'claude-fable-5-1';
const syntheticId = name => createHash('md5').update(`${slug}:${name}`).digest('hex');
const ids = {old:syntheticId('old'), current:syntheticId('current'), wrongJob:syntheticId('wrong-job'), unknown:syntheticId('unknown')};
const localRun = `run-${syntheticId('local-run').slice(0,16)}`;
const scientificMD5 = syntheticId('scientific-control');
const anchor = '75053614359224265389282351';
const scientificContent = `{"fixture":"${slug}","scientific_anchor":${anchor},"negative_zero":-0,"exponent":1.25e+30}\n`;
const scientificSHA = createHash('sha256').update(scientificContent).digest('hex');
const diagnostic = `attempt ${ids.old.slice(0,8)}… of job #41 was replaced by ${ids.current}, which another of your sessions holds. Local checkpoint ${localRun}.`;
const science = `Scientific MD5 ${scientificMD5}; SHA256 ${scientificSHA}; finite anchor ${anchor}; public return #1569 and job #41.`;
let uid, pid, token, server, base;
const sessions = [randomUUID(), randomUUID(), randomUUID()];

before(async () => {
  await migrate();
  uid = Number((await one(`INSERT INTO users(github_id,handle,terms_version,terms_accepted_at) VALUES($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random()*1e8), slug, TERMS_VERSION])).id);
  token = await issueToken(uid);
  pid = Number((await one(`INSERT INTO problems(slug,name,repo_url,status_md,discovery_share) VALUES($1,'Historical privacy fixture','https://example.org/r','open',0) RETURNING id`, [slug])).id);
  await q(`INSERT INTO channels(problem_id,path,title) VALUES($1,'','Project')`, [pid]);
  for (const id of sessions) await q(`INSERT INTO sessions(id,problem_id,user_id,model,ai) VALUES($1,$2,$3,$4,'{"transcript_preapproved":true}')`, [id,pid,uid,model]);
  const app = express(); app.use(express.json()); app.use(filesRouter); app.use('/projects/:slug',job);
  app.use((error,req,res,next) => res.status(500).json({error:error.message}));
  server = app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  base = `http://127.0.0.1:${server.address().port}/projects/${slug}`;
});
after(async () => {
  try {
    if (server) await new Promise(r=>server.close(r));
    if (pid) {
      await q(`DELETE FROM messages WHERE user_id=$1`,[uid]);
      await q(`DELETE FROM channel_members WHERE user_id=$1`,[uid]);
      await q(`DELETE FROM credits WHERE problem_id=$1`,[pid]);
      await q(`DELETE FROM counted_entries WHERE user_id=$1`,[uid]);
      await q(`DELETE FROM reviews WHERE user_id=$1`,[uid]);
      await q(`DELETE FROM file_refs WHERE file_sha IN (SELECT sha256 FROM files WHERE user_id=$1)`,[uid]);
      await q(`DELETE FROM files WHERE user_id=$1`,[uid]);
      await q(`DELETE FROM returns WHERE problem_id=$1`,[pid]);
      await q(`DELETE FROM jobs WHERE problem_id=$1`,[pid]);
      await q(`DELETE FROM sessions WHERE problem_id=$1`,[pid]);
      await q(`DELETE FROM pool WHERE problem_id=$1`,[pid]);
      await q(`DELETE FROM channels WHERE problem_id=$1`,[pid]);
      await q(`DELETE FROM problems WHERE id=$1`,[pid]);
    }
    if (uid) {
      await q(`DELETE FROM tokens WHERE user_id=$1`,[uid]);
      await q(`DELETE FROM reputation WHERE user_id=$1`,[uid]);
      await q(`DELETE FROM users WHERE id=$1`,[uid]);
    }
  } finally { await pool.end(); rmSync(tmp,{recursive:true,force:true}); }
});
const call = (path,{method='GET',session,attempt,body,requestId,accept='application/json'}={}) => fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,accept,'content-type':'application/json','x-model':model,'x-effort':'max',...(session?{'x-session':session}:{}),...(attempt?{'x-attempt':attempt}:{}),...(requestId?{'x-request-id':requestId}:{})},body:body?JSON.stringify(body):undefined});
const resultBody = job_id => ({job_id,report_md:'A synthetic fixture observation.',transcript:'fixture',transcript_approved:true});
const assignedJob = async (session, attempt) => {
  const j = await one(`INSERT INTO jobs(problem_id,type,title,brief_md,min_tier,status,assigned_to,assigned_session,assigned_at,expires_at,attempt_id) VALUES($1,'explore','Privacy fixture','Synthetic task',99,'assigned',$2,$3,now(),now()+interval '1 hour',$4) RETURNING id`, [pid,uid,session,attempt]);
  await q(`INSERT INTO assignment_attempts(id,job_id,problem_id,session_id,user_id,model,budget_hours) VALUES($1,$2,$3,$4,$5,$6,1)`, [attempt,j.id,pid,session,uid,model]);
  return Number(j.id);
};
function noOwnershipValues(text, values=Object.values(ids)) {
  for (const value of [...values,...sessions]) {
    assert.ok(!text.includes(value),'a diagnostic must not disclose an ownership identifier');
    assert.ok(!text.includes(value.slice(0,8)),'a diagnostic must not disclose a shortened ownership identifier');
  }
}

test('public job JSON omits previous ownership and sanitizes legacy diagnostics without rewriting the job',async()=>{
  const jid=await assignedJob(sessions[0],syntheticId('job-view'));
  const brief=`An observation. ${diagnostic} ${science}`;
  await q('UPDATE jobs SET last_released_session=$2,brief_md=$3 WHERE id=$1',[jid,sessions[1],brief]);
  const response=await fetch(base+`/job/${jid}?format=json`);assert.equal(response.status,200);
  const raw=await response.text();const view=JSON.parse(raw);
  for(const key of ['last_released_session','assigned_session','attempt_id'])assert.ok(!Object.hasOwn(view,key));
  noOwnershipValues(raw,[ids.old,ids.current,localRun]);assert.ok(view.brief_md.includes(scientificSHA));
  assert.deepEqual(await one('SELECT brief_md,last_released_session FROM jobs WHERE id=$1',[jid]),{brief_md:brief,last_released_session:sessions[1]});
  const html=await fetch(base+`/job/${jid}`,{headers:{accept:'text/html'}});assert.equal(html.status,200);
  noOwnershipValues(await html.text(),[ids.old,ids.current,localRun]);
  await q("UPDATE jobs SET status='returned',assigned_session=NULL WHERE id=$1",[jid]);
  await q("UPDATE assignment_attempts SET status='returned',ended_at=now() WHERE job_id=$1",[jid]);
});

test('actual stale, unknown, wrong-job and replacement completion errors disclose no attempt or sibling session',async()=>{
  const jid = await assignedJob(sessions[0],ids.current);
  await q(`INSERT INTO assignment_attempts(id,job_id,problem_id,session_id,user_id,model,budget_hours,status,ended_at) VALUES($1,$2,$3,$4,$5,$6,1,'released',now())`, [ids.old,jid,pid,sessions[0],uid,model]);
  // The wrong-job header names an earlier terminal attempt of this same
  // session; a session cannot hold two live assignments simultaneously.
  const otherJob = Number((await one(`INSERT INTO jobs(problem_id,type,title,brief_md,min_tier,status) VALUES($1,'explore','Earlier privacy fixture','Synthetic earlier task',99,'queued') RETURNING id`, [pid])).id);
  await q(`INSERT INTO assignment_attempts(id,job_id,problem_id,session_id,user_id,model,budget_hours,status,ended_at) VALUES($1,$2,$3,$4,$5,$6,1,'released',now())`, [ids.wrongJob,otherJob,pid,sessions[0],uid,model]);
  for (const [attempt,pattern] of [[ids.unknown,/unknown attempt/],[ids.wrongJob,/different assignments/],[ids.old,/was replaced/]]) {
    const response = await call('/result',{method:'POST',session:sessions[0],attempt,body:resultBody(jid)});
    const body = await response.json(); assert.equal(response.status,409); assert.match(body.error,pattern); noOwnershipValues(JSON.stringify(body));
    assert.match(body.error,new RegExp(`job #${jid}`,'i'));
  }
  // A replacement can belong to a different session of this same fixture owner.
  await q(`UPDATE assignment_attempts SET session_id=$2 WHERE id=$1`,[ids.current,sessions[1]]);
  await q(`UPDATE jobs SET assigned_session=$2 WHERE id=$1`,[jid,sessions[1]]);
  const replaced = await call('/result',{method:'POST',session:sessions[0],attempt:ids.old,body:resultBody(jid)});
  const replacement = await replaced.json(); assert.equal(replaced.status,409); assert.match(replacement.error,/another session/); noOwnershipValues(JSON.stringify(replacement));
  const wrong = await call('/result',{method:'POST',session:sessions[0],attempt:ids.current,body:resultBody(jid)});
  const wrongBody = await wrong.json(); assert.equal(wrong.status,403); assert.ok(!Object.hasOwn(wrongBody,'held_by_session')); noOwnershipValues(JSON.stringify(wrongBody));
  // An older rolling-deployment slot can leave the job holder and attempt journal
  // out of agreement. Exercise the route's independent ownership defence too:
  // the middleware accepts this original attempt, but the live job has moved.
  await q(`UPDATE assignment_attempts SET session_id=$2 WHERE id=$1`,[ids.current,sessions[0]]);
  const drifted = await call('/result',{method:'POST',session:sessions[0],attempt:ids.current,body:resultBody(jid)});
  const driftedBody = await drifted.json(); assert.equal(drifted.status,403); assert.match(driftedBody.error,/held by another session/);
  assert.ok(!Object.hasOwn(driftedBody,'held_by_session')); noOwnershipValues(JSON.stringify(driftedBody));
  assert.equal((await one('SELECT count(*) AS n FROM returns WHERE job_id=ANY($1)',[[jid,otherJob]])).n,'0','refused ownership requests never submit research');
});

test('legacy return JSON, HTML and exact-token transcript views redact diagnostic prose without changing stored science',async()=>{
  const report = `${diagnostic}\n\n${science}`;
  const recipe = `Retain the original observations. ${diagnostic} ${science}`;
  const patch = `--- a/research/fixture.md\n+++ b/research/fixture.md\n@@ -1 +1,2 @@\n-old\n+${diagnostic}\n+${science}\n`;
  const filename = `diagnostic-${localRun}.json`;
  const transcript = `{"type":"tool_result","content":${JSON.stringify(JSON.stringify({error:diagnostic,scientific_md5:scientificMD5,sha256:scientificSHA,job_id:41,return_id:1569}))},"scientific_anchor":${anchor},"negative_zero":-0,"exponent":1.25e+30}\n`;
  const hashes = {scientific_output:scientificSHA,scientific_control:scientificMD5};
  const legacy = await one(`INSERT INTO returns(problem_id,type,user_id,model,provider,report_md,recipe_md,transcript,status,hashes,patch) VALUES($1,'explore',$2,$3,'anthropic',$4,$5,$6,'recorded',$7,$8) RETURNING id`, [pid,uid,model,report,recipe,transcript,JSON.stringify(hashes),patch]);
  await q(`INSERT INTO files(sha256,user_id,model,name,ext,bytes) VALUES($1,$2,$3,$4,'json',$5)`,[scientificSHA,uid,model,filename,Buffer.byteLength(scientificContent)]);
  const blobDir = join(process.env.FILES_DIR,scientificSHA.slice(0,2)); const blob = join(blobDir,scientificSHA);
  mkdirSync(blobDir,{recursive:true}); writeFileSync(blob,scientificContent);
  await q(`INSERT INTO file_refs(file_sha,ref_type,ref_id) VALUES($1,'return',$2)`,[scientificSHA,legacy.id]);
  const originalFile = await one(`SELECT sha256,name,bytes FROM files WHERE sha256=$1`,[scientificSHA]);
  const review = await one(`INSERT INTO reviews(return_id,user_id,model,provider,verdict,rung,notes_md) VALUES($1,$2,$3,'anthropic','accept','measured',$4) RETURNING id`,[legacy.id,uid,model,report]);
  const original = await one(`SELECT report_md,recipe_md,transcript,hashes,patch,verification_fingerprint FROM returns WHERE id=$1`,[legacy.id]);
  const json = await call(`/return/${legacy.id}`); assert.equal(json.status,200);
  const text = await json.text(); noOwnershipValues(text,[ids.old,ids.current,localRun]);
  const view = JSON.parse(text); assert.match(view.report_md,/\[REDACTED\]/); assert.deepEqual(view.hashes,hashes);
  assert.equal(Number(view.id),Number(legacy.id)); assert.ok(view.report_md.includes('public return #1569 and job #41'));
  assert.match(view.patch,/\[REDACTED\]/); assert.ok(view.patch.includes(scientificSHA));
  assert.equal(view.files.length,1); assert.equal(view.files[0].sha256,scientificSHA); assert.match(view.files[0].name,/\[REDACTED\]/);
  for (const value of [scientificMD5,scientificSHA,anchor]) assert.ok(view.report_md.includes(value),'scientific evidence must survive presentation');
  const page = await call(`/return/${legacy.id}`,{accept:'text/html'}); assert.equal(page.status,200);
  const html = await page.text(); noOwnershipValues(html,[ids.old,ids.current,localRun]);
  for (const value of [scientificMD5,scientificSHA,anchor]) assert.ok(html.includes(value),'the rendered report preserves scientific evidence');
  assert.ok(html.includes(`/files/${scientificSHA}`),'privacy edits retain the content-addressed evidence link');
  assert.ok(html.includes('diagnostic-[REDACTED].json'),'legacy attachment labels are sanitized before HTML escape');
  const reviewResponse = await call(`/review/${review.id}`); assert.equal(reviewResponse.status,200);
  const reviewText = await reviewResponse.text(); noOwnershipValues(reviewText,[ids.old,ids.current,localRun]);
  const reviewView = JSON.parse(reviewText); assert.equal(Number(reviewView.return_id),Number(legacy.id)); assert.ok(reviewView.notes_md.includes(scientificSHA));
  const fileMetaResponse = await fetch(new URL(`/files/${scientificSHA}/meta`,base),{headers:{accept:'application/json'}}); assert.equal(fileMetaResponse.status,200);
  const fileMetaText = await fileMetaResponse.text(); noOwnershipValues(fileMetaText,[ids.old,ids.current,localRun]);
  const fileMeta = JSON.parse(fileMetaText); assert.equal(fileMeta.sha256,scientificSHA); assert.equal(fileMeta.name,'diagnostic-[REDACTED].json'); assert.equal(Number(fileMeta.bytes),Buffer.byteLength(scientificContent));
  const rawFile = await fetch(new URL(`/files/${scientificSHA}`,base),{headers:{accept:'text/plain'}}); assert.equal(rawFile.status,200);
  const disposition = rawFile.headers.get('content-disposition') ?? ''; noOwnershipValues(disposition,[ids.old,ids.current,localRun]);
  assert.equal(disposition,'inline; filename="diagnostic-[REDACTED].json"'); assert.equal(rawFile.headers.get('x-content-sha256'),scientificSHA);
  const rawBytes = Buffer.from(await rawFile.arrayBuffer()); assert.deepEqual(rawBytes,Buffer.from(scientificContent)); assert.equal(createHash('sha256').update(rawBytes).digest('hex'),scientificSHA);
  const filePage = await fetch(new URL(`/files/${scientificSHA}`,base),{headers:{accept:'text/html'}}); assert.equal(filePage.status,200);
  const fileHtml = await filePage.text(); noOwnershipValues(fileHtml,[ids.old,ids.current,localRun]); assert.ok(fileHtml.includes('diagnostic-[REDACTED].json')); assert.ok(fileHtml.includes(anchor)); assert.ok(fileHtml.includes(scientificSHA));
  const download = await call(`/return/${legacy.id}/transcript`); assert.equal(download.status,200); assert.match(download.headers.get('content-type'),/text\/plain/);
  const safeTranscript = await download.text(); noOwnershipValues(safeTranscript,[ids.old,ids.current,localRun]);
  assert.ok(safeTranscript.includes(`"scientific_anchor":${anchor}`)); assert.ok(safeTranscript.includes('"negative_zero":-0')); assert.ok(safeTranscript.includes('"exponent":1.25e+30'));
  const decoded = JSON.parse(JSON.parse(safeTranscript).content); assert.equal(decoded.job_id,41); assert.equal(decoded.return_id,1569); assert.equal(decoded.scientific_md5,scientificMD5); assert.equal(decoded.sha256,scientificSHA);
  assert.deepEqual(await one(`SELECT report_md,recipe_md,transcript,hashes,patch,verification_fingerprint FROM returns WHERE id=$1`,[legacy.id]),original,'presentation leaves original scientific bytes, patch and fingerprint untouched');
  assert.deepEqual(await one(`SELECT sha256,name,bytes FROM files WHERE sha256=$1`,[scientificSHA]),originalFile,'presentation preserves the original attachment name and scientific SHA');
  assert.deepEqual(readFileSync(blob),Buffer.from(scientificContent),'metadata and raw presentation leave scientific blob bytes unchanged');
  assert.equal((await one(`SELECT notes_md FROM reviews WHERE id=$1`,[review.id])).notes_md,report,'review presentation preserves the original notes');
});

test('an exact protected request-ID retry preserves its original historical receipt',async()=>{
  const attempt = syntheticId('receipt'); const jid = await assignedJob(sessions[2],attempt);
  const body = resultBody(jid); const requestId = `historical_privacy_${randomUUID().replaceAll('-','')}`;
  const response = await call('/result',{method:'POST',session:sessions[2],attempt,body,requestId}); const result = await response.json(); assert.equal(response.status,200);
  const historical = {...result,warnings:[diagnostic,science]};
  await q(`UPDATE mutation_receipts SET receipt=$2 WHERE user_id=$1 AND request_id=$3`,[uid,JSON.stringify(historical),requestId]);
  const original = await one('SELECT receipt,request_hash,status FROM assignment_attempts WHERE id=$1',[attempt]);
  const replay = await call('/result',{method:'POST',session:sessions[2],attempt,body,requestId}); assert.equal(replay.status,200); assert.deepEqual(await replay.json(),historical,'authenticated retry replays the stored receipt, not a newly generated presentation');
  assert.deepEqual(await one('SELECT receipt,request_hash,status FROM assignment_attempts WHERE id=$1',[attempt]),original);
  assert.equal((await one('SELECT count(*) AS n FROM returns WHERE job_id=$1',[jid])).n,'1');
});
