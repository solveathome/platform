// Synthetic authenticated-assignment records only. This fixture runs no Lean and asserts no mathematical result.
import {randomUUID} from 'node:crypto';
import {q,one} from '../../src/db/index.ts';
import {saveCheckReceipt} from '../../src/lib/verification.ts';
import {leanStatementBinding} from '../../src/lib/lean-verification.ts';
import {leanEvidence,digest} from './lean.mjs';

export async function leanExecutionFixture(subject,user,model=subject.model,effort='high') {
  const session=randomUUID(), attempt=randomUUID(), pid=subject.problem_id;
  await q(`INSERT INTO sessions(id,problem_id,user_id,model,effort) VALUES($1,$2,$3,$4,$5)`,[session,pid,user,model,effort]);
  const job=await one(`INSERT INTO jobs(problem_id,type,title,brief_md,min_tier,budget_hours,evidence_return_id,status,assigned_to,assigned_session)
    VALUES($1,'check','Synthetic check','No execution.',99,0.5,$2,'assigned',$3,$4) RETURNING *`,[pid,subject.id,user,session]);
  await q(`INSERT INTO assignment_attempts(id,job_id,problem_id,session_id,user_id,model,tier,budget_hours) VALUES($1,$2,$3,$4,$5,$6,1,0.5)`,[attempt,job.id,pid,session,user,model]);
  await q(`UPDATE jobs SET attempt_id=$2 WHERE id=$1`,[job.id,attempt]);
  const ret=await one(`INSERT INTO returns(job_id,problem_id,type,user_id,model,provider,report_md,transcript,status,session,effort)
    VALUES($1,$2,'check',$3,$4,'fixture','Synthetic observation','t','recorded',$5,$6) RETURNING *`,[job.id,pid,user,model,session,effort]);
  await q(`UPDATE jobs SET status='returned' WHERE id=$1`,[job.id]);
  const lean=leanEvidence(subject.verification_plan.lean,leanStatementBinding(subject.verification_plan.lean));
  const stdout=digest('fixture stdout');
  for(const hash of [stdout,lean.audit_sha256,lean.axioms_sha256,...lean.claims.map(c=>c.proof_sha256)])
    await q(`INSERT INTO files(sha256,user_id,model,name,ext,bytes) VALUES($1,$2,$3,'fixture.txt','txt',1) ON CONFLICT DO NOTHING`,[hash,user,model]);
  const raw={fingerprint:subject.verification_fingerprint,execution_policy:'authenticated-contributor-v1',outcome:'pass',observed:'Synthetic successful observation',elapsed_seconds:1,
    attestation_md:'Synthetic test attestation describing personally observed execution, actual artifacts, negative controls and limits.',
    stdout_sha256:stdout,exit_code:0,environment:'Synthetic fixture',coverage_md:'One mapped claim',method:'rerun',shared_components_md:'Shared fixture only',controls_md:'Synthetic detections',
    controls:['forbidden axiom','modified statement','missing target'].map(name=>({name,detected:true,note:'Synthetic rejection'})),limits_md:'Synthetic records only; no Lean run.',lean};
  const authenticated={userId:Number(user),sessionId:session};
  const submit=async()=>{await saveCheckReceipt(ret,job,raw,authenticated);return one(`SELECT * FROM verification_runs WHERE result_return_id=$1`,[ret.id]);};
  return {ret,job,raw,authenticated,submit};
}
