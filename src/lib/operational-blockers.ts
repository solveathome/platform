import {q} from '../db/index.js';
import {findSecret, findHarnessId} from './files.js';

// These fingerprints describe assignment fit, never the truth of a research claim.
export const JOB_FIT_SQL = `md5(jsonb_build_array(j.brief_md,j.compute_hint,j.required_tools,j.required_sources,j.research_route_id,j.research_source_return_id,j.step_checked_through,j.agent_direction_revision)::text)`;
export const SOURCE_EPOCH_SQL = `jsonb_build_array((SELECT max(id) FROM document_publications WHERE problem_id=j.problem_id),(SELECT max(created_at) FROM document_versions WHERE problem_id=j.problem_id))`;
export const SESSION_FIT = (s: string) => `jsonb_build_array(${s}.compute,${s}.capabilities->'tools',${s}.capabilities->'sources',${s}.capabilities->'execution',${s}.ai->'subagents',${s}.ai->'max_hours_per_assignment')`;
// Scope is explicit, never inferred from scientific prose. Keep the original full
// snapshot even for scoped comparisons, so old checkpoints and receipts survive.
const runtimeFit = (fit: string) => `jsonb_set(${fit},'{3}',CASE WHEN jsonb_typeof(${fit}->3)='object'
  THEN coalesce(nullif((${fit}->3)-'publication_context_privacy','{}'::jsonb),'null'::jsonb)
  ELSE coalesce(${fit}->3,'null'::jsonb) END)`;

export function parseDeferral(raw: any) {
  if (raw === undefined) return null;
  if (!raw || !['execution','source'].includes(raw.kind)) throw new Error('deferral.kind must be execution or source; mathematical obstacles belong in research evidence');
  const fitScope = raw.fit_scope ?? 'legacy';
  if (!['legacy','runtime','publication'].includes(fitScope) || (raw.kind==='source' && fitScope!=='legacy'))
    throw new Error('deferral.fit_scope must be legacy, runtime or publication; source deferrals use legacy');
  for (const key of ['evidence_md','reopen_when']) {
    if (typeof raw[key] !== 'string' || !raw[key].trim() || raw[key].length > 2000) throw new Error(`deferral.${key} requires 1–2000 characters`);
    if (findSecret(raw[key]) || findHarnessId(raw[key])) throw new Error('deferral must contain no credentials or private harness identifiers');
  }
  return {kind:raw.kind, fit_scope:fitScope, evidence_md:raw.evidence_md, reopen_when:raw.reopen_when};
}

/** Called only after the original assignment's ownership checks, in its release transaction. */
export async function recordDeferral(job: any, deferral: ReturnType<typeof parseDeferral>) {
  if (!deferral) return;
  await q(`INSERT INTO assignment_deferrals(job_id,attempt_id,user_id,department_id,model,kind,job_fingerprint,session_fit,source_epoch,evidence_md,reopen_when,fit_scope)
    SELECT j.id,j.attempt_id,s.user_id,s.department_id,s.model,$2,${JOB_FIT_SQL},${SESSION_FIT('s')},${SOURCE_EPOCH_SQL},$3,$4,$5
    FROM jobs j JOIN sessions s ON s.id=j.assigned_session WHERE j.id=$1 AND j.status='assigned'
    ON CONFLICT (attempt_id) DO NOTHING`, [job.id,deferral.kind,deferral.evidence_md,deferral.reopen_when,deferral.fit_scope]);
}

/** A new session in the same department reuses the checkpoint until sources, task or actual controls change.
 * Explicit human job/direction choices bypass this investment policy, never ownership/trust checks. */
export function deferralEligibility(sid: string) {
  return `NOT EXISTS (SELECT 1 FROM assignment_deferrals d JOIN sessions current ON current.id=${sid}
    WHERE d.job_id=j.id AND d.user_id=current.user_id AND d.department_id IS NOT DISTINCT FROM current.department_id
    AND d.job_fingerprint=${JOB_FIT_SQL}
    AND (CASE d.fit_scope
      WHEN 'runtime' THEN ${runtimeFit('d.session_fit')}=${runtimeFit(SESSION_FIT('current'))}
      WHEN 'publication' THEN (d.session_fit->3->'publication_context_privacy') IS NOT DISTINCT FROM (current.capabilities->'execution'->'publication_context_privacy')
      ELSE d.session_fit=${SESSION_FIT('current')} END)
    AND d.source_epoch=${SOURCE_EPOCH_SQL})`;
}

/** The generated questions index must follow its source repairs, not compete with them.
 * Only exact co-origin trusted findings establish this dependency; no prose heuristic changes scientific status. */
export const INDEX_PREREQUISITES_SQL = `NOT EXISTS (SELECT 1 FROM job_correction_prerequisites dep JOIN findings f ON f.id=dep.finding_id WHERE dep.job_id=j.id AND f.status='open') AND NOT (j.type='audit' AND j.title='Fix research/QUESTIONS.md' AND EXISTS (
  SELECT 1 FROM findings target JOIN findings source ON source.problem_id=target.problem_id
    AND source.path<>target.path AND source.path<>'research/OUTCOMES.md' AND source.scope<>'advisory' AND source.status='open'
    AND ((source.review_id IS NOT NULL AND source.review_id=target.review_id)
      OR (source.review_id IS NULL AND target.review_id IS NULL AND source.return_id=target.return_id))
  WHERE target.job_id=j.id AND target.status='open' AND target.scope<>'advisory'))`;

export async function deferralHistory(jobId: number) {
  return q(`SELECT kind,fit_scope,evidence_md,reopen_when,created_at FROM assignment_deferrals WHERE job_id=$1 ORDER BY id`,[jobId]);
}
