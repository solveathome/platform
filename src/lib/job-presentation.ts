import { plainDescription } from './seo.js';
import { redactHarnessIds } from './files.js';
import { jobKind, withoutKindPrefix } from './research-format.js';

// Reader context is derived at display time. Issued briefs, titles, receipts and scientific grades stay unchanged.
export const JOB_CONTEXT_JOINS = `
  LEFT JOIN returns subject ON subject.id = coalesce(j.parent_return_id, j.evidence_return_id, j.follow_up_of, j.research_source_return_id) AND subject.problem_id = j.problem_id
  LEFT JOIN jobs source_job ON source_job.id = subject.job_id AND source_job.problem_id = j.problem_id`;
export const JOB_CONTEXT_COLUMNS = `source_job.title AS source_title, subject.id AS subject_return_id,
  left(subject.report_md, 8192) AS source_report_md, left(j.brief_md, 8192) AS summary_brief_md`;

// Keep in-word subscripts and path names: a reader excerpt must not turn L_F into LF.
const text = (s: unknown, max = 280) => plainDescription(redactHarnessIds(String(s ?? '')).text.replace(/(?<=[\p{L}\p{N}])_(?=[\p{L}\p{N}{])/gu, '\u0002'), max).replace(/\u0002/g, '_');
// SQL excerpts may end inside a private diagnostic or a Markdown link. Discard the incomplete last token before redaction.
const bounded = (s: unknown) => { const v = String(s ?? ''); return v.length === 8192 ? v.replace(/\S+$/, '') : v; };
function reportHeading(s: string): string {
  const first = s.replace(/<!--[\s\S]*?-->/g, '').trim().split('\n')[0].replace(/^#+\s*/, '');
  return withoutKindPrefix(first.replace(/^(?:Job\s*#\d+|Return\s*#\d+)(?:\s*\([^\n]*?\))?\s*[:—–-]\s*/i, ''));
}
function issuedStep(brief: string): any {
  const m = /(?:The step:|Next experiment:)\s*\n?\s*\{/i.exec(brief);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  // Parse only the issued object, never a route's later replacement experiment.
  for (let end = brief.indexOf('}', start); end >= 0; end = brief.indexOf('}', end + 1)) {
    try { const x = JSON.parse(brief.slice(start, end + 1)); return typeof x.question === 'string' ? x : null; } catch { /* nested object */ }
  }
  return null;
}

export function jobPresentation(job: any) {
  const kind = jobKind(job), brief = bounded(job.summary_brief_md ?? job.brief_md);
  const heading = reportHeading(bounded(job.source_report_md));
  const pointer = (s: unknown) => /^(?:Review|Triage|Check|Verify|Verification)(?:\s+(?:return|result|package))?\s*#\d+\b/i.test(String(s ?? ''));
  const subjectTitle = job.source_title && !pointer(job.source_title) ? job.source_title : heading;
  const title = text(pointer(job.title) ? subjectTitle || job.title : job.title, 180);
  const claim = text(heading || job.source_title, 300);
  const step = issuedStep(brief);
  let what = text(step?.question || title), why = 'Adds a checkable contribution to the shared research record, with its scope and uncertainty preserved.';
  if (kind === 'review') {
    what = claim ? `Checking the author's claim: ${claim}` : 'Checking the submitted claim and its supplied evidence.';
    why = 'Determine what the evidence supports and whether it can enter the trusted research record.';
  } else if (kind === 'triage') {
    what = claim ? `Assessing the submitted claim: ${claim}` : 'Reading the submitted claim and its evidence.';
    why = 'Identify work worth independent review and avoid spending that effort on known or duplicate claims.';
  } else if (kind === 'check') {
    what = claim ? `Independently checking the evidence for: ${claim}` : 'Independently checking the supplied verification package.';
    why = 'Establish what was actually reproduced and expose any missing execution or conflicting evidence.';
  } else if (job.step_check_of != null) {
    why = 'Compare existing evidence before spending compute on an experiment that may already be answered.';
  } else if (kind === 'follow_up') {
    why = 'Supply the missing evidence or explanation needed to make earlier work checkable.';
  } else if (kind === 'audit') {
    why = job.requires_trust ? 'Correct required review findings so the document can move toward circulation.' : 'Find concrete defects in the document and its evidence before others build on it.';
  } else if (kind === 'source') {
    why = 'Establish the sources and attribution needed to build on this work reliably.';
  } else if (kind === 'formalize') {
    why = 'Make the precise claim and its remaining proof obligations independently checkable.';
  } else if (kind === 'first_look') {
    why = 'Find out whether this research direction has an uncovered, feasible next step.';
  } else if (kind === 'pursuit' || kind === 'rescue') {
    why = step?.success ? `The experiment aims to establish: ${text(step.success, 280)}` : kind === 'rescue' ? 'Test whether a different approach can resolve the recorded obstacle.' : 'Resolve an open question with a discriminating experiment and retain the evidence either way.';
  }
  return { title, what, why, subject_return_id: job.subject_return_id ?? null };
}
