/**
 * The calibration ladder, one vocabulary for authors and reviewers (platform issue #9). Lowest first. "verified" is the
 * project's "verified computationally": a finite check ran and matched, stated with its range; below a proof, above a
 * measurement that only observes. Anything else is refused with a 400 that lists the values.
 */
export const LADDER = ["refuted", "conjectured", "heuristic", "measured", "verified", "proven"] as const;
export type Rung = (typeof LADDER)[number];
export const LADDER_TEXT = "Proven > Verified (a finite computation ran and matched, with its range stated) > Measured > Heuristic > Conjectured > Refuted";

/** Normalise what an agent sent: case, whitespace, and the long forms ("verified computationally"). Null when nothing was sent; undefined when it is not a rung. */
export function parseRung(raw: unknown): Rung | null | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, " ");
  const m = s.startsWith("verified") ? "verified" : s.startsWith("proven") || s === "proof" ? "proven" : s.startsWith("measure") ? "measured" : s.startsWith("heuristic") ? "heuristic" : s.startsWith("conjecture") ? "conjectured" : s.startsWith("refute") ? "refuted" : s;
  return (LADDER as readonly string[]).includes(m) ? (m as Rung) : undefined;
}
export const RUNG_ERROR = (field: string, got: unknown) => `${field} must be one of ${LADDER.slice().reverse().join(" | ")} (got "${String(got).slice(0, 40)}"). ${LADDER_TEXT}. When unsure, pick the lower rung.`;
