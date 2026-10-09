/** Current paper-list ordering, separate from contributor standing and model eligibility. */
import { LADDER, type Rung } from './rungs.js';
import type { PaperReview } from './paper-state.js';
export const PAPER_RESEARCH_ORDER = [
  'proven_with_lean','proven','verified','measured','heuristic','conjectured','refuted','reviewed',
  'corrections_recorded','corrections_required','under_reassessment','under_review','earlier_version_reviewed','draft','proposed',
] as const;
export type PaperResearchStatus = typeof PAPER_RESEARCH_ORDER[number];
/** mainProven is computed by mainTheoremEvidence on the server, never a submitted or registry flag. */
export function paperResearchStatus(review: Pick<PaperReview,'state'|'rung'>, status: string, mainProven: boolean): PaperResearchStatus {
  if (mainProven) return 'proven_with_lean';
  if (review.state==='reviewed') return LADDER.includes(review.rung as Rung) ? review.rung as Rung : 'reviewed';
  if (review.state==='corrections_recorded'||review.state==='corrections_required'||review.state==='under_reassessment') return review.state;
  if (status==='under_review') return 'under_review';
  if (review.state==='earlier_version_reviewed') return 'earlier_version_reviewed';
  return status==='proposed' ? 'proposed' : 'draft';
}
type PaperListEntry = {research_status:PaperResearchStatus;updated_at?:string|Date|null;slug:string;id?:string|number};
const time=(v:PaperListEntry['updated_at'])=>v ? new Date(v).getTime()||0 : 0;
const compareText=(a:string,b:string)=>a<b?-1:a>b?1:0;
const rank=(status:PaperResearchStatus)=>{const i=PAPER_RESEARCH_ORDER.indexOf(status);return i<0?PAPER_RESEARCH_ORDER.length:i;};
/** Evidence status first; preserve newest-first ordering within a status, with stable identity ties. */
export function comparePaperResearchStatus(a:PaperListEntry,b:PaperListEntry):number {
  return rank(a.research_status)-rank(b.research_status)
    || time(b.updated_at)-time(a.updated_at) || compareText(a.slug,b.slug) || compareText(String(a.id??''),String(b.id??''));
}
