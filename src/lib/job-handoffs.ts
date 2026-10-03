import {q} from '../db/index.js';
import {findSecret, findHarnessId, findHomePath} from './files.js';

/** A handoff holds ordinary scheduling, never a scientific verdict or assignment ownership. */
export const HANDOFF_ELIGIBILITY_SQL = `NOT EXISTS (SELECT 1 FROM job_handoffs h WHERE h.job_id=j.id AND h.status='waiting')`;

export function handoffText(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 4000) throw new Error(`${field} requires 1–4000 characters`);
  if (findSecret(raw) || findHarnessId(raw) || findHomePath(raw)) throw new Error(`${field} must contain no credentials, private bindings or personal paths`);
  return raw.trim();
}

export async function handoffHistory(jobId: number) {
  return q(`SELECT h.id,h.recipient_kind,u.handle AS recipient_handle,h.recipient_contact,
    h.reason_md,h.required_access_md,h.resume_when,h.status,h.created_at,h.closed_at,h.resolution_md,
    maker.handle AS created_by,closer.handle AS closed_by
    FROM job_handoffs h JOIN users u ON u.id=h.recipient_user_id JOIN users maker ON maker.id=h.created_by
    LEFT JOIN users closer ON closer.id=h.closed_by WHERE h.job_id=$1 ORDER BY h.id`,[jobId]);
}

export function handoffBrief(rows: any[]): string {
  if (!rows.length) return '';
  const waiting=rows.filter(h=>h.status==='waiting'),closed=rows.filter(h=>h.status!=='waiting');
  const recipient=(h:any)=>`@${h.recipient_handle}${h.recipient_kind==='agent' ? `, research contact ${h.recipient_contact}` : ' (person)'}`;
  const active=waiting.length ? `\n\n## Specific person or agent needed\n\n${waiting.map(h=>`Handoff #${h.id}: waiting. Needs ${recipient(h)}.\n\n${h.reason_md}\n\nRequired access or expertise: ${h.required_access_md}\n\nResume when: ${h.resume_when}`).join('\n\n')}` : '';
  const history=closed.length ? `\n\n## Closed handoff history\n\nThese are historical prerequisites, not current instructions to wait or contact the recipient.\n\n${closed.map(h=>`Handoff #${h.id}: ${h.status}; previously addressed to ${recipient(h)}.\n\nResolution: ${h.resolution_md}`).join('\n\n')}` : '';
  return active+history+'\n\nA handoff does not transfer an existing attempt or resolve scientific findings. Human-directed revisits retain tier, trust and consent requirements.';
}

export async function pendingHandoffs(problemId: number, userId: number, contact: string | null) {
  return q(`SELECT h.id,h.job_id,h.recipient_kind,h.reason_md,h.required_access_md,h.resume_when
    FROM job_handoffs h JOIN jobs j ON j.id=h.job_id WHERE j.problem_id=$1 AND h.status='waiting'
    AND h.recipient_user_id=$2 AND (h.recipient_kind='person' OR h.recipient_contact=$3)
    ORDER BY h.id LIMIT 50`,[problemId,userId,contact]);
}
