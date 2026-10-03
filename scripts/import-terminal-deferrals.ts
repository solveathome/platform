/** Import reviewed release checkpoints from an already closed batch. Never registers,
 * assigns, releases, submits science or changes another attempt. Dry-run by default.
 * Input is a protected JSON array of {attempt_id, job_id, kind, evidence_md, reopen_when}.
 */
import {readFileSync} from 'node:fs';
import {one,q,pool,projectTransaction} from '../src/db/index.js';
import {JOB_FIT_SQL,SOURCE_EPOCH_SQL,SESSION_FIT,parseHistoricalDeferral} from '../src/lib/operational-blockers.js';
const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
const apply=process.argv.includes('--apply');
if (!Array.isArray(input) || input.length>10) throw new Error('Expected a bounded terminal batch');
try {
  // Validate all scope declarations before looking up or applying any checkpoint.
  const prepared=input.map(item=>({item,d:parseHistoricalDeferral(item)}));
  for (const {item,d} of prepared) {
    const attempt=await one(`SELECT a.*,s.department_id FROM assignment_attempts a JOIN sessions s ON s.id=a.session_id
      WHERE a.id=$1 AND a.job_id=$2 AND a.user_id=s.user_id`,[item.attempt_id,item.job_id]);
    if (!attempt || attempt.status!=='released' || !attempt.ended_at) throw new Error('Original released attempt not verified');
    const report=await projectTransaction(attempt.problem_id,async()=>{
      const inserted=apply ? await q(`INSERT INTO assignment_deferrals(job_id,attempt_id,user_id,department_id,model,kind,job_fingerprint,session_fit,source_epoch,evidence_md,reopen_when)
        SELECT j.id,a.id,a.user_id,s.department_id,a.model,$2,${JOB_FIT_SQL},${SESSION_FIT('s')},${SOURCE_EPOCH_SQL},$3,$4
        FROM assignment_attempts a JOIN jobs j ON j.id=a.job_id JOIN sessions s ON s.id=a.session_id
        WHERE a.id=$1 AND a.status='released' AND a.ended_at IS NOT NULL ON CONFLICT (attempt_id) DO NOTHING RETURNING id`,[attempt.id,d.kind,d.evidence_md,d.reopen_when]) : [];
      const existing=inserted.length ? null : await one(`SELECT kind,fit_scope,source_scope FROM assignment_deferrals WHERE attempt_id=$1`,[attempt.id]);
      if (apply && !inserted.length && !existing) throw new Error('Checkpoint was not inserted or found; no application claimed');
      return {job_id:Number(attempt.job_id),kind:d.kind,requested_fit_scope:d.fit_scope,requested_source_scope:d.source_scope,original_terminal_verified:true,applied:inserted.length===1,already_recorded:!!existing,...(existing?{checkpoint_scope:existing}:{})};
    });
    console.log(JSON.stringify(report));
  }
} finally {await pool.end();}
