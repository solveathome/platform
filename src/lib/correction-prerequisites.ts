import {q,one} from '../db/index.js';
import {findHarnessId,findSecret,findHomePath,redactHarnessIds} from './files.js';
import {needsSourceReview,SOURCE_REVIEW_MESSAGE} from './document-publication.js';

/** Source obligations are explicit metadata; never infer a dependency or a verdict from prose. */
export async function correctionPrerequisites(jobId: number) {
  const rows=await q(`SELECT f.id AS finding_id,f.path,f.status,f.job_id AS source_job_id,j.status AS source_job_status,
    f.note,p.reason_md,u.handle AS recorded_by,p.created_at
    FROM job_correction_prerequisites p JOIN findings f ON f.id=p.finding_id
    LEFT JOIN jobs j ON j.id=f.job_id LEFT JOIN users u ON u.id=p.created_by
    WHERE p.job_id=$1 ORDER BY f.id`,[jobId]);
  return rows.map(r=>({...r,note:redactHarnessIds(r.note).text,reason_md:r.reason_md ? redactHarnessIds(r.reason_md).text : null}));
}

/** Called inside the project's mutation transaction by an owner or granted trusted member. */
export async function recordCorrectionPrerequisites(jobId: number,problemId: number,userId: number,ids: unknown,reason: unknown) {
  if (!Array.isArray(ids) || !ids.length || ids.length>20 || ids.some(id=>!Number.isSafeInteger(id) || id<=0))
    throw new Error('finding_ids must contain 1–20 positive integer finding IDs');
  if (typeof reason!=='string' || !reason.trim() || reason.length>2000 || findSecret(reason) || findHarnessId(reason) || findHomePath(reason))
    throw new Error('reason_md requires 1–2000 characters of source dependency evidence without private identifiers');
  if (needsSourceReview(reason)) throw new Error(SOURCE_REVIEW_MESSAGE);
  const job=await one('SELECT id,type,requires_trust,status FROM jobs WHERE id=$1 AND problem_id=$2',[jobId,problemId]);
  if (!job || job.type!=='audit' || !job.requires_trust || job.status!=='queued')
    throw new Error('only a queued required correction can receive prerequisites; held and terminal attempts stay unchanged');
  const unique=[...new Set(ids)];
  const found=await q(`SELECT id,job_id FROM findings WHERE id=ANY($1::bigint[]) AND problem_id=$2
    AND status='open' AND scope<>'advisory'`,[unique,problemId]);
  if (found.length!==unique.length) throw new Error('prerequisites must be open required findings in this project');
  const cycle=await one(`WITH RECURSIVE dependency(job_id) AS (
    SELECT job_id FROM findings WHERE id=ANY($1::bigint[]) AND job_id IS NOT NULL
    UNION SELECT f.job_id FROM dependency d JOIN job_correction_prerequisites p ON p.job_id=d.job_id
      JOIN findings f ON f.id=p.finding_id WHERE f.job_id IS NOT NULL AND f.status='open')
    SELECT 1 FROM dependency WHERE job_id=$2`,[unique,jobId]);
  if (cycle) throw new Error('a correction cannot depend on itself or form a source repair cycle');
  await q(`INSERT INTO job_correction_prerequisites(job_id,finding_id,created_by,reason_md)
    SELECT $1,id,$3,$4 FROM unnest($2::bigint[]) ids(id) ON CONFLICT DO NOTHING`,[jobId,unique,userId,reason]);
  return correctionPrerequisites(jobId);
}

export function correctionPrerequisiteBrief(rows: any[]): string {
  const open=rows.filter(r=>r.status==='open');
  if (!open.length) return '';
  return `\n\n## Source corrections needed first\n\n${open.map(r=>`- Finding #${r.finding_id} in \`${r.path}\`${r.source_job_id ? `; source repair job #${r.source_job_id} (${r.source_job_status})` : '; no source repair job linked yet'}. ${r.reason_md ?? r.note}`).join('\n')}\n\nThe source repair must be accepted and integrated before its finding closes and this correction becomes automatically eligible. Check the current source and finding status; a submitted or accepted-but-unintegrated revision is insufficient. Do not hand-author generated registry rows. Other research can proceed. Human-directed revisits remain available with normal ownership, tier and trust.\n`;
}
