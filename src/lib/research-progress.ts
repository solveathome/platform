import { createHash } from 'node:crypto';
/** An investment preference, never an evidence grade or permission to close work. */
export const PROGRESS_KINDS = ['mathematical','algorithmic','device_benchmark','validation'] as const;
export type ResearchProgress = { kind:typeof PROGRESS_KINDS[number]; rationale_md:string };
export function parseProgress(raw:any):ResearchProgress {
  if(!raw || typeof raw!=='object' || Array.isArray(raw) || !PROGRESS_KINDS.includes(raw.kind)
    || typeof raw.rationale_md!=='string' || !raw.rationale_md.trim() || raw.rationale_md.length>2000)throw Error('progress needs kind mathematical|algorithmic|device_benchmark|validation and a nonempty rationale_md of at most 2000 characters');
  return {kind:raw.kind,rationale_md:raw.rationale_md.trim()};
}
const canonical=(x:any):any=>Array.isArray(x)?x.map(canonical):x && typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export const nextStepHash=(step:any):string|null=>step?createHash('sha256').update(JSON.stringify(canonical(step))).digest('hex'):null;
export const withoutProgressAssessment=(value:any)=>value==null?value:Object.fromEntries(Object.entries(value).filter(([key])=>key!=='next_step_progress'));
export const PORTABLE_PROPOSAL_BONUS=8, PORTABLE_REVIEW_BONUS=12;
export const PORTABLE_PROGRESS_GUIDANCE = `Prioritize transferable mathematics and algorithms: fewer operations or trials, sound stronger pruning, better constructions, reusable constraints and theory. State the invariant, assumptions and counted work that can benefit other implementations. Hardware-specific timing remains useful scoped evidence, but a gain on one device is not a universal measured speedup or the primary shared research goal. Separate the underlying method from device tuning. Do not require everyone to own reference hardware; contributors may reason, implement, validate or explore performance within their actual capabilities. Essential checks and correction work remain necessary. Optional next_step.progress:{kind:"mathematical|algorithmic|device_benchmark|validation",rationale_md} describes the next experiment's contribution, not an accepted result. Declare hardware facts accurately. On ordinary review, research_assessment.next_step_progress:{report_sha256:<current public report hash>,next_step_sha256:<current public next-step hash>,kind,rationale_md} can correct this investment classification. It grants no scientific acceptance, route closure or reopening authority. Prefer an experiment on the portable mechanism when a device benchmark leaves that mechanism unresolved; repeat device timing only for a specific consequential uncertainty.`;

/** Explicit metadata and current trusted assessments, never a keyword or GPU-ownership classifier. */
export function researchProgressSql() {
  const declared=`coalesce(j.research_task->'progress'->>'kind',research_source.research->'next_step'->'progress'->>'kind')`;
  const reviewed=`cardinality(progress_review.kinds)>0`;
  const portable=`progress_review.kinds <@ ARRAY['mathematical','algorithmic']::text[]`;
  const ordinary=`j.type NOT IN ('review','audit','triage','check') AND j.work_check IS NULL AND j.applicability_check IS NULL AND j.step_check_of IS NULL
    AND coalesce(research_source.status,'') NOT IN ('rejected','contested')`;
  const kind=`CASE WHEN ${reviewed} THEN CASE WHEN ${portable} THEN 'portable' WHEN cardinality(progress_review.kinds)=1 THEN progress_review.kinds[1] ELSE 'disputed' END ELSE coalesce(${declared},'unspecified') END`;
  return {
    joins:`LEFT JOIN LATERAL (SELECT array_agg(DISTINCT v.research_assessment->'next_step_progress'->>'kind') AS kinds FROM reviews v
      WHERE v.return_id=research_source.id AND v.trusted AND NOT v.needs_reassessment
      AND v.research_assessment->'next_step_progress'->>'kind'=ANY(ARRAY['mathematical','algorithmic','device_benchmark','validation'])
      AND v.research_assessment->'next_step_progress'->>'report_sha256'=encode(sha256(convert_to(research_source.report_md,'UTF8')),'hex')
      AND v.research_assessment->'next_step_progress'->'next_step'=research_source.research->'next_step') progress_review ON true`,
    kind,
    basis:`CASE WHEN ${reviewed} THEN 'current trusted assessment; scheduling only' WHEN ${declared} IS NOT NULL THEN 'declared; unreviewed' ELSE 'unspecified' END`,
    bonus:`CASE WHEN ${ordinary} THEN CASE WHEN ${reviewed} THEN CASE WHEN ${portable} THEN ${PORTABLE_REVIEW_BONUS} ELSE 0 END
      WHEN ${declared} IN ('mathematical','algorithmic') THEN ${PORTABLE_PROPOSAL_BONUS} ELSE 0 END ELSE 0 END`,
  };
}
