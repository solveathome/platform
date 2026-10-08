/** Read-only presentation of current Lean evidence. Designations come only from deployed project config. */
import type { LeanSummary } from './lean-verification.js';
import { esc } from './page.js';

export type MainTheoremDesignation = {
  paper_slug: string; manuscript_sha256: string; statement_binding: string;
  required_claim_ids: string[]; unproved_claims: { id: string; locator: string }[];
};
export type LeanDisplayRecord = LeanSummary & { return_id: number; fingerprint: string };
const hash = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= 1000;

/** No return flag, approval boolean or claimed reviewer identity can designate a main theorem. */
export function mainTheoremDesignation(raw: unknown, paperSlug: string, manuscriptSha: string | null): MainTheoremDesignation | null {
  if (!Array.isArray(raw) || raw.length > 100 || !hash(manuscriptSha)) return null;
  const matches = raw.filter(x => x && typeof x === 'object' && x.paper_slug === paperSlug && x.manuscript_sha256 === manuscriptSha);
  if (matches.length !== 1) return null;
  const x = matches[0];
  const keys = ['paper_slug','manuscript_sha256','statement_binding','required_claim_ids','unproved_claims'];
  if (Object.keys(x).some(k => !keys.includes(k)) || !hash(x.statement_binding) ||
      !Array.isArray(x.required_claim_ids) || !x.required_claim_ids.length || x.required_claim_ids.length > 100 ||
      !x.required_claim_ids.every(text) || new Set(x.required_claim_ids).size !== x.required_claim_ids.length ||
      !Array.isArray(x.unproved_claims) || x.unproved_claims.length > 100 ||
      !x.unproved_claims.every((c: any) => c && text(c.id) && text(c.locator) && Object.keys(c).every(k => ['id','locator'].includes(k))) ||
      new Set(x.unproved_claims.map((c: any) => c.id)).size !== x.unproved_claims.length ||
      x.unproved_claims.some((c: any) => x.required_claim_ids.includes(c.id))) return null;
  return x as MainTheoremDesignation;
}

export function mainTheoremEvidence(records: LeanDisplayRecord[], designation: MainTheoremDesignation | null): LeanDisplayRecord | null {
  if (!designation) return null;
  return records.find(r => r.status === 'checked' && r.return_status === 'accepted' && r.current_evidence &&
    r.judged_receipt_id === r.current_evidence.receipt_id &&
    [r.current_evidence.receipt_id, r.current_evidence.execution_return_id, r.current_evidence.statement_review_id].every(id => Number.isSafeInteger(id) && id > 0) &&
    Array.isArray(r.current_evidence.semantic_review_ids) && r.current_evidence.semantic_review_ids.length > 0 &&
    r.current_evidence.semantic_review_ids.every(id => Number.isSafeInteger(id) && id > 0) &&
    r.manuscript_sha256 === designation.manuscript_sha256 && r.statement_binding === designation.statement_binding &&
    designation.required_claim_ids.every(id => r.checked_claims.includes(id) &&
      r.claims.some(c => c.id === id && c.coverage === 'full' && c.assumptions.length === 0))) ?? null;
}

export function mainTheoremCallout(record: LeanDisplayRecord | null, designation: MainTheoremDesignation | null, slug: string, paperSlug: string, title: string): string {
  if (!record || !designation || mainTheoremEvidence([record], designation) !== record) return '';
  const url = `/projects/${encodeURIComponent(slug)}/papers/${encodeURIComponent(paperSlug)}#lean-evidence`;
  return `<section class="panel" aria-label="Lean milestone"><p><span class="paper-status reviewed">Main theorem verified in Lean</span> · <a href="${esc(url)}">${esc(title)}</a></p><p>The designated main claims are checked for this manuscript. Other claims remain outside this badge’s coverage; this is not a proof of the project’s overall conjecture.</p>${unproved(designation)}</section>`;
}

function unproved(designation: MainTheoremDesignation | null): string {
  return designation?.unproved_claims.length ? `<p><b>Other claims remain unproved:</b></p><ul>${designation.unproved_claims.map(c => `<li>${esc(c.id)}: ${esc(c.locator)}</li>`).join('')}</ul>` : '<p>Claims outside this package are not verified by its Lean evidence. Read the manuscript for remaining obligations.</p>';
}

export function leanEvidencePanel(records: LeanDisplayRecord[], slug: string, designation: MainTheoremDesignation | null): string {
  if (!records.length) return '<section id="lean-evidence"><p class="muted">No Lean proof evidence recorded for this paper.</p></section>';
  const P = `/projects/${encodeURIComponent(slug)}`;
  const main = mainTheoremEvidence(records, designation);
  return `<section class="panel" id="lean-evidence"><h2>Lean evidence</h2>${main ? '<p><span class="paper-status reviewed">Main theorem verified in Lean</span></p>' : '<p>No current verification of a designated main theorem is recorded.</p>'}<p>Worker-reported validation of exact mapped claims, assessed by trusted reviewers. A checked helper claim is not verification of the main theorem or the entire paper. The project’s overall conjecture and ordinary review grade remain separate.</p>${unproved(designation)}${records.map(r => {
    const current = r.current_evidence;
    const counted = current && ['checked','partial','conditional'].includes(r.status);
    return `<article><p><b>${esc(r.label)}</b> — <a href="${P}/return/${Number(r.return_id)}">package return #${Number(r.return_id)}</a>${r.superseded_by ? ` (replaced by <a href="${P}/return/${Number(r.superseded_by)}">return #${Number(r.superseded_by)}</a>)` : ''}</p><p>Manuscript SHA-256: <code>${esc(r.manuscript_sha256)}</code><br>Statement binding: <code>${esc(r.statement_binding)}</code><br>Package fingerprint: <code>${esc(r.fingerprint)}</code></p>${current ? `<p><a href="${P}/return/${current.execution_return_id}">Trusted execution receipt #${current.receipt_id}</a> · <a href="${P}/review/${current.statement_review_id}">Statement and claim-mapping review #${current.statement_review_id}</a> · ${current.semantic_review_ids.map(id => `<a href="${P}/review/${id}">Mathematical correctness and execution judgment #${id}</a>`).join(' · ')}</p><p>The server authenticates account/session attestation and current eligibility; it does not authenticate physical computation or model reasoning.</p>` : '<p>No current accepted trusted execution and independent semantic judgment count for this package. Historical observations remain on its return.</p>'}<ul>${r.claims.map(c => `<li>${esc(c.id)} (${esc(c.locator)}): <code>${esc(c.declaration)}</code>; ${counted && r.checked_claims.includes(c.id) ? 'currently checked' : 'not currently verified'}; ${esc(c.coverage)} coverage; assumptions: ${esc(c.assumptions.join('; ') || 'none declared')}.</li>`).join('')}</ul>${r.issues.length ? `<ul>${r.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}</article>`;
  }).join('')}</section>`;
}
