/**
 * The two source checks on a paper (Oct 16 2026, Sakana lessons #3 and #4): the claim-to-source map (claim-sources.ts) and the
 * reference lookup (citations.ts). One function computes both for a manuscript, so intake, the referee brief, the paper page, its
 * JSON at /papers/<paper>/checks and the integrity inventory say the same thing. Both are findings for a person to act on; neither
 * refuses, holds or decides anything.
 */
import { checkClaimSources, dbSourceContext, type ClaimCheck } from "./claim-sources.js";
import { citationReport, queueReferenceLookup, type CitationReport } from "./citations.js";

export type PaperChecks = { claims: ClaimCheck; references: CitationReport };

export async function paperChecks(problemId: number, slug: string, md: string, opts: { lookup?: boolean } = {}): Promise<PaperChecks> {
  const claims = await checkClaimSources(md, dbSourceContext(problemId, slug));
  const references = await citationReport(md);
  if (opts.lookup !== false && references.counts.pending) queueReferenceLookup(md);
  return { claims, references };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function checkCounts(c: PaperChecks) {
  const r = c.references.counts;
  return { claims: c.claims.counts.claims, claims_mapped: c.claims.counts.mapped, claims_unmapped: c.claims.counts.unmapped, has_map: c.claims.has_map,
    references: r.references, references_resolved: r.resolved + r.found, references_found_by_search: r.found, references_unresolved: r.unresolved, references_mismatch: r.mismatch, references_skipped: r.skipped, references_pending: r.pending };
}
export function checksLine(c: PaperChecks): string {
  const n = checkCounts(c);
  return `Claim sources: ${n.claims_mapped} of ${n.claims} claims name a source${n.has_map ? "" : " (no Claim sources table)"}. References: ${n.references_resolved} of ${n.references} resolve${n.references_unresolved ? `, ${n.references_unresolved} do not` : ""}${n.references_mismatch ? `, ${n.references_mismatch} point to another work` : ""}${n.references_skipped ? `, ${n.references_skipped} web pages not looked up` : ""}${n.references_pending ? `, ${n.references_pending} not looked up yet` : ""}.`;
}

/** The referee's part: the flags, and that a claim without a source fails. */
export function refereeNote(c: PaperChecks, url: string, max = 25): string {
  const flags = [...c.claims.flags, ...c.references.flags];
  const list = flags.slice(0, max).map((f) => `- ${f}`).join("\n");
  return `\n\n## Source checks (automatic)\n\n${checksLine(c)} Full list: GET ${url}\n\nEvery theorem, table and result number must name the return, receipt, Lean package, file or reference it comes from, in the manuscript's "Claim sources" table. A claim the check lists below as having no source fails this review: record each as a required correction (or reject if the manuscript has no map at all), unless you find its source named in the text, in which case say where. For each flagged reference, check it yourself: an unresolved one may be a real book with no DOI; a wrong identifier or an invented work is a required correction.${flags.length ? `\n\n${list}${flags.length > max ? `\n- … and ${flags.length - max} more at the link above.` : ""}` : "\n\nNo flags."}`;
}

/** The panel above the manuscript on the paper page. */
export function checksPanel(c: PaperChecks, url: string): string {
  const flags = [...c.claims.flags, ...c.references.flags];
  const list = flags.length ? `<details><summary>${flags.length} flag${flags.length === 1 ? "" : "s"}</summary><ul>${flags.slice(0, 200).map((f) => `<li>${esc(f)}</li>`).join("")}</ul></details>` : "";
  return `<div class="panel" style="margin:0 0 1.5rem;padding:.9rem 1.1rem;border-left:4px solid var(--line)"><p style="margin:0 0 .4rem"><b>Source checks</b> <span class="muted">(automatic; <a href="${esc(url)}">details</a>)</span></p><p style="margin:.25rem 0">${esc(checksLine(c))}</p>${list}</div>`;
}
