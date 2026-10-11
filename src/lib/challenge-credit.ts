/** Numerical achievements pay the person, independently of research acceptance or the submitting model. */
import { POINTS } from './credit.js';

export const RECORD_POINTS = POINTS.record;
export const RECORD_POLICY = 'record-credit-v1';
export type RecordReceipt = { id: number; userId: number; value: number; target: number | null;
  withdrawn?: boolean; duplicate?: boolean; known?: boolean; demo?: boolean };

/** Receipt order determines priority. Each person's highest qualifying tier on a track caps their total. */
export function recordAwards(better: 'higher' | 'lower', receipts: RecordReceipt[]): Map<number, number> {
  const awards = new Map<number, number>(), earned = new Map<number, number>();
  const beats = (a: number, b: number) => better === 'higher' ? a > b : a < b;
  let best: number | null = null;
  for (const r of [...receipts].sort((a, b) => a.id - b.id)) {
    if (r.demo || r.withdrawn) continue;
    if (!Number.isFinite(r.value) || (best !== null && !beats(r.value, best))) continue;
    // Imports and copies establish the public baseline, but never earn new discovery credit.
    best = r.value;
    if (r.duplicate || r.known || (better === 'higher' && r.value <= 0)) continue;
    const tier = r.target !== null && beats(r.value, r.target) ? RECORD_POINTS.exceeded
      : r.value === r.target ? RECORD_POINTS.matched : RECORD_POINTS.site;
    const paid = earned.get(r.userId) ?? 0;
    if (tier > paid) { awards.set(r.id, tier - paid); earned.set(r.userId, tier); }
  }
  return awards;
}
