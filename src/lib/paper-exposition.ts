/** A paper's readable exposition is its own reviewed artifact version, never a new proof receipt. */
import { createHash } from 'node:crypto';
import { one, q, projectTransaction } from '../db/index.js';
import * as files from './files.js';
import { paperSource } from './paper-state.js';
import { leanVerificationSummary } from './verification.js';
import type { LeanSummary } from './lean-verification.js';

const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const sha = /^[0-9a-f]{64}$/;
const fail = (message: string): never => { throw Object.assign(new Error(message), {status: 400}); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ids = (xs: string[]) => [...xs].sort();
export const EXPOSITION_GUIDANCE = `After current trusted Lean acceptance, an ordinary paper assignment can produce a readable LaTeX exposition of the accepted mapped claims. Reuse the exact proof sources, statement mappings and judged receipt; prose or formatting changes require no Lean rerun. Give this exposition its own TeX hash and claim map, preserving every theorem parameter, assumption, definition, endpoint and quantifier. Explicitly separate unmapped, stronger and open claims. New or strengthened mathematics requires its own linked validation; it never inherits verification. Cite only real inspected sources with exact locators, preserve licenses and prior contributors, and disclose actual AI authorship without inventing affiliations, novelty or human endorsement.

Compile TeX locally with an established toolchain in a disposable unprivileged isolation boundary: no network, secrets, home mounts, host files or Docker socket; read-only inputs; bounded memory, processes, runtime and scratch; shell escape disabled. TeX's own restricted file access is also required. Acquire dependencies separately before offline compilation. Inspect every rendered PDF page and report actual commands, toolchain pins, isolation and log hashes. An unavailable safe compiler is a capability blocker, never an invented PDF or a local unrestricted substitute. The server stores text artifacts and serves inert downloads; it never executes TeX, Lean or submitted code.

Upload the .tex, exposition claim-map JSON, compilation evidence/log and a PDF JSON envelope through the existing /files API. Keep the existing per-file and storage caps: the envelope counts at its encoded size. The finished submission gets one ordinary independent fidelity review of its correspondence to the accepted proof, sources, scope, authorship and PDF; review is not a second proof execution or co-development.`;

export type PaperExposition = {
  schema: 'paper-exposition-v1'; source_return_id: number; source_fingerprint: string;
  source_manuscript_sha256: string; statement_binding: string; receipt_id: number;
  tex_sha256: string; claim_map_sha256: string; pdf_sha256: string; compilation_sha256: string;
  claims: Array<{source_claim_id: string; declaration: string; target: string; coverage: string; assumptions: string[]; tex_locator: string}>;
};

/** Strict bounded transport decoding only. No PDF interpreter or submitted compiler runs here. */
export function decodeExpositionPdf(text: string): {bytes: Buffer; sha256: string} {
  if (Buffer.byteLength(text) > files.MAX_BYTES) fail('PDF envelope exceeds the existing file limit');
  let p: any; try { p = JSON.parse(text); } catch { fail('PDF envelope must be JSON'); }
  if (p?.schema !== 'paper-exposition-pdf-v1' || !sha.test(p.sha256) || !Number.isSafeInteger(p.bytes) || p.bytes <= 0 || p.bytes > files.MAX_BYTES
    || typeof p.base64 !== 'string' || p.base64.length !== 4 * Math.ceil(p.bytes / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.base64)) fail('Invalid bounded PDF envelope');
  const bytes = Buffer.from(p.base64, 'base64');
  if (bytes.length !== p.bytes || bytes.toString('base64') !== p.base64 || digest(bytes) !== p.sha256
    || !bytes.subarray(0, 8).toString('ascii').match(/^%PDF-1\.[0-9]/) || !bytes.subarray(-1024).toString('ascii').match(/%%EOF\s*$/)) fail('PDF bytes, size, signature or hash do not match the envelope');
  return {bytes, sha256: p.sha256};
}

export function acceptedExpositionSource(source: any, summary?: LeanSummary): boolean {
  return !!source && source.status === 'accepted' && !source.provisional && !source.paper_exposition && !!summary
    && ['checked','partial','conditional'].includes(summary.status) && !!summary.judged_receipt_id && summary.checked_claims.length > 0;
}
/** The key is scientific scope, not a computer, receipt refresh or changed typography. */
export function expositionKey(paperSlug: string, summary: LeanSummary): string {
  return digest(JSON.stringify([paperSlug, summary.manuscript_sha256, summary.statement_binding, ids(summary.checked_claims)]));
}
export async function expositionSource(sourceId: number, problemId: number) {
  const source = await one(`SELECT * FROM returns WHERE id=$1 AND problem_id=$2`, [sourceId, problemId]);
  const slug = source?.verification_plan?.lean?.paper_slug;
  const paper = slug ? await one(`SELECT * FROM papers WHERE problem_id=$1 AND slug=$2`, [problemId, slug]) : null;
  const project = paper ? await one(`SELECT slug FROM problems WHERE id=$1`, [problemId]) : null;
  const current = paper && project ? paperSource(paper, project.slug).sha : null;
  const summary = source ? await leanVerificationSummary(sourceId, current) : undefined;
  return {source, paper, summary, current: acceptedExpositionSource(source, summary)};
}

export async function queuePaperExposition(sourceId: number, problemId: number): Promise<number | null> {
  return projectTransaction(problemId, async () => {
    const s = await expositionSource(sourceId, problemId);
    if (!s.current || !s.paper || !s.summary) return null;
    const key = expositionKey(s.paper.slug, s.summary);
    const brief = `Write a readable LaTeX exposition for paper.slug: ${s.paper.slug}\n\nAccepted source: GET <project base>/return/${sourceId}; package fingerprint ${s.source.verification_fingerprint}; manuscript ${s.summary.manuscript_sha256}; statement binding ${s.summary.statement_binding}; judged receipt #${s.summary.judged_receipt_id}. Accepted mapped claim ids: ${ids(s.summary.checked_claims).join(', ')}. Read the current evidence before writing. If it became pending, stale or revoked, report that blocker and release this task.\n\n${EXPOSITION_GUIDANCE}\n\nReturn an ordinary paper result with paper:{slug:"${s.paper.slug}",file:<TeX sha256>,exposition:{source_return_id:${sourceId},source_fingerprint:"${s.source.verification_fingerprint}",receipt_id:${s.summary.judged_receipt_id},claim_map_sha256:<map hash>,pdf_sha256:<envelope hash>,compilation_sha256:<evidence hash>}}, all artifact hashes in files, and cites.returns including ${sourceId}. Read GET <project base>/research-protocol?section=paper-exposition for the exact artifact schemas. This is a separate exposition version; do not revise the accepted source manuscript or resubmit a Lean verification plan.`;
    const job = await one(`INSERT INTO jobs (problem_id,lane_id,type,title,brief_md,min_tier,budget_hours,quorum,requires_trust,exposition_source_return_id,exposition_key)
      VALUES ($1,$2,'paper',$3,$4,1,2,1,true,$5,$6) ON CONFLICT (problem_id,exposition_key) WHERE exposition_key IS NOT NULL DO NOTHING RETURNING id`,
      [problemId, s.source.lane_id, `LaTeX exposition: ${s.paper.title}`.slice(0,200), brief, sourceId, key]);
    return job ? Number(job.id) : Number((await one(`SELECT id FROM jobs WHERE problem_id=$1 AND exposition_key=$2`, [problemId,key]))!.id);
  });
}

/** Backfill accepted historical work once. An expired, rejected or completed task never regenerates itself. */
export async function reconcilePaperExpositions(problemId: number): Promise<void> {
  const live = await q(`SELECT id,exposition_source_return_id FROM jobs WHERE problem_id=$1 AND exposition_source_return_id IS NOT NULL AND status IN ('queued','assigned')`, [problemId]);
  for (const j of live) if (!(await expositionSource(Number(j.exposition_source_return_id),problemId)).current)
    await q(`UPDATE jobs SET status='expired',last_release_note='Exposition source is pending, stale or no longer has current accepted Lean evidence' WHERE id=$1`, [j.id]);
  const candidates = await q(`SELECT r.id FROM returns r WHERE r.problem_id=$1 AND r.status='accepted' AND NOT r.provisional AND r.verification_plan ? 'lean'
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.problem_id=$1 AND j.exposition_source_return_id=r.id)
    ORDER BY r.id DESC LIMIT 50`, [problemId]);
  for (const r of candidates) await queuePaperExposition(Number(r.id),problemId);
}

async function artifact(hash: string, ext: string, attached: string[]): Promise<string> {
  if (!sha.test(hash) || !attached.includes(hash)) fail(`Exposition ${ext} artifact must be uploaded and listed in files`);
  const f = await one(`SELECT ext FROM files WHERE sha256=$1 AND deleted_at IS NULL`, [hash]);
  const text = files.read(hash);
  if (!f || f.ext !== ext || !text || digest(text) !== hash) fail(`Exposition ${ext} artifact is missing, removed or has the wrong extension/hash`);
  return text!;
}
const json = (text: string, label: string): any => { try { return JSON.parse(text); } catch { return fail(`${label} must be valid JSON`); } };

export function validateExpositionMapping(map: any, source: any, summary: LeanSummary, texSha: string) {
  if (map?.schema !== 'paper-exposition-map-v1' || map.source_return_id !== Number(source.id) || map.source_fingerprint !== source.verification_fingerprint
    || map.receipt_id !== summary.judged_receipt_id || map.tex_sha256 !== texSha || !Array.isArray(map.claims) || !map.claims.length
    || !Array.isArray(map.unproved_claims)) fail('Exposition claim map does not bind this exact source, receipt and TeX version');
  const seen = new Set();
  for (const c of map.claims) {
    const original = summary.claims.find(x => x.id === c.source_claim_id);
    if (!original || !summary.checked_claims.includes(original.id) || seen.has(original.id) || c.declaration !== original.declaration || c.target !== original.target
      || c.coverage !== original.coverage || !same(c.assumptions,original.assumptions) || typeof c.tex_locator !== 'string' || !c.tex_locator.trim())
      fail('Every exposition claim needs a unique accepted source id, unchanged declaration, target, coverage, assumptions and TeX locator');
    seen.add(original!.id);
  }
  if (!same(ids([...seen] as string[]),ids(summary.checked_claims))) fail('Exposition must map every accepted checked source claim; missing claims are not silently completed');
  for (const c of map.unproved_claims) {
    if (c?.status !== 'open' || typeof c.id !== 'string' || !c.id.trim() || typeof c.tex_locator !== 'string' || !c.tex_locator.trim()
      || typeof c.description !== 'string' || !c.description.trim() || seen.has(c.id))
      fail('Unproved exposition claims must have unique separate ids, locators, descriptions and explicit open status');
    seen.add(c.id);
  }
  return map.claims.map((c: any) => ({source_claim_id:c.source_claim_id,declaration:c.declaration,target:c.target,coverage:c.coverage,assumptions:c.assumptions,tex_locator:c.tex_locator}));
}

export async function validatePaperExposition(raw: any, texSha: string, paperSlug: string, problemId: number, attached: string[], job: any): Promise<PaperExposition> {
  if (!Number.isSafeInteger(raw?.source_return_id) || raw.source_return_id <= 0) fail('Exposition requires source_return_id');
  const s = await expositionSource(raw.source_return_id,problemId);
  if (!s.current || !s.summary || s.paper?.slug !== paperSlug || raw.source_fingerprint !== s.source.verification_fingerprint
    || raw.receipt_id !== s.summary.judged_receipt_id || (job?.exposition_source_return_id && Number(job.exposition_source_return_id) !== raw.source_return_id)) fail('Exposition source is pending, stale, revoked or differs from this assignment and receipt');
  await artifact(texSha,'tex',attached);
  const map = json(await artifact(raw.claim_map_sha256,'json',attached),'Claim map');
  const claims = validateExpositionMapping(map,s.source,s.summary!,texSha);
  const pdf = decodeExpositionPdf(await artifact(raw.pdf_sha256,'json',attached));
  const compilation = json(await artifact(raw.compilation_sha256,'json',attached),'Compilation evidence');
  if (compilation?.schema !== 'paper-exposition-compile-v1' || compilation.status !== 'pass' || compilation.exit_code !== 0 || compilation.tex_sha256 !== texSha || compilation.pdf_sha256 !== pdf.sha256
    || compilation.isolation?.network !== 'none' || compilation.isolation?.shell_escape !== false || compilation.isolation?.host_files !== 'none'
    || compilation.isolation?.unprivileged !== true || compilation.isolation?.inputs_readonly !== true || !compilation.toolchain?.name || !compilation.toolchain?.version
    || !compilation.command || !sha.test(compilation.log_sha256)) fail('Compilation evidence must bind this TeX/PDF and report successful isolated offline compilation with shell escape disabled');
  await artifact(compilation.log_sha256,'log',attached);
  return {schema:'paper-exposition-v1',source_return_id:raw.source_return_id,source_fingerprint:raw.source_fingerprint,
    source_manuscript_sha256:s.summary!.manuscript_sha256,statement_binding:s.summary!.statement_binding,receipt_id:raw.receipt_id,
    tex_sha256:texSha,claim_map_sha256:raw.claim_map_sha256,pdf_sha256:raw.pdf_sha256,compilation_sha256:raw.compilation_sha256,claims};
}

export async function expositionEvidence(e: PaperExposition, problemId: number) {
  const s = await expositionSource(e.source_return_id,problemId);
  const current = s.current && s.source?.verification_fingerprint === e.source_fingerprint && s.summary?.statement_binding === e.statement_binding
    && s.summary?.manuscript_sha256 === e.source_manuscript_sha256 && s.summary?.judged_receipt_id === e.receipt_id
    && e.claims.every(c => s.summary!.checked_claims.includes(c.source_claim_id));
  return {current, status:s.summary?.status ?? 'no_proof', source_return_status:s.source?.status ?? 'missing', label:current ? 'Current accepted mapped proof evidence' : 'Source evidence pending, stale or revoked', receipt_id:e.receipt_id};
}

export function expositionReviewMatches(e: PaperExposition, review: any): boolean {
  return !!review && review.tex_sha256 === e.tex_sha256 && review.claim_map_sha256 === e.claim_map_sha256 && review.pdf_sha256 === e.pdf_sha256
    && review.source_fingerprint === e.source_fingerprint && Array.isArray(review.reviewed_claim_ids)
    && same(ids(review.reviewed_claim_ids),ids(e.claims.map(c=>c.source_claim_id))) && typeof review.fidelity_md === 'string' && review.fidelity_md.trim().length >= 80;
}

export async function validateExpositionReview(ret: any, review: any) {
  const e: PaperExposition = ret.paper_exposition;
  if (!(await expositionEvidence(e,Number(ret.problem_id))).current) fail('Exposition acceptance requires current accepted source evidence; this source is pending, stale or revoked');
  if (!expositionReviewMatches(e,review))
    fail('paper_exposition_review must bind the exact TeX, PDF envelope, map and source fingerprint, list every reviewed source claim id and substantively assess fidelity_md (at least 80 characters)');
  return {tex_sha256:e.tex_sha256,claim_map_sha256:e.claim_map_sha256,pdf_sha256:e.pdf_sha256,source_fingerprint:e.source_fingerprint,reviewed_claim_ids:ids(review.reviewed_claim_ids),fidelity_md:review.fidelity_md};
}

export async function expositionReviewGuidance(e: PaperExposition, problemId: number) {
  return `\n\nIndependent fidelity review of a FINISHED LaTeX exposition version. Read its exact TeX, PDF, claim map and compilation evidence. Source: return #${e.source_return_id}, fingerprint ${e.source_fingerprint}, judged receipt #${e.receipt_id}. Current source evidence: ${(await expositionEvidence(e,problemId)).label}. Compare every mapped theorem and definition, explicit parameters, assumptions, quantifiers, domains, endpoint conventions and coverage with that accepted source. Check the readable argument, actual citations/licenses, attribution and AI disclosure, explicitly open obligations and PDF/source correspondence. Reuse accepted proof evidence; do not execute Lean again for exposition or formatting, or co-develop this submission. New or strengthened claims require separate validation and remain unproved here. Accept only the exact submitted artifact version. Return paper_exposition_review:{tex_sha256:"${e.tex_sha256}",claim_map_sha256:"${e.claim_map_sha256}",pdf_sha256:"${e.pdf_sha256}",source_fingerprint:"${e.source_fingerprint}",reviewed_claim_ids:${JSON.stringify(e.claims.map(c=>c.source_claim_id))},fidelity_md:<substantive correspondence assessment, at least 80 characters>} with the ordinary verdict, notes_md, rung and verification:"read". Reject with precise defects when correspondence or evidence is insufficient. This review establishes exposition fidelity at the mapped scope, not another proof execution or blanket original-paper verification.`;
}

export async function expositionVersions(problemId: number, paperSlug: string) {
  const rows = await q(`SELECT r.id,r.status,r.provisional,r.created_at,r.model,r.paper_exposition,u.handle,
    (SELECT array_agg(x.file_sha) FROM file_refs x WHERE x.ref_type='return' AND x.ref_id=r.id) AS files,
    (SELECT jsonb_agg(jsonb_build_object('id',rv.id,'verdict',rv.verdict,'trusted',rv.trusted,'needs_reassessment',rv.needs_reassessment,'mapping',rv.paper_exposition_review) ORDER BY rv.id) FROM reviews rv WHERE rv.return_id=r.id) AS reviews
    FROM returns r JOIN users u ON u.id=r.user_id WHERE r.problem_id=$1 AND r.paper_slug=$2 AND r.paper_exposition IS NOT NULL ORDER BY r.id`, [problemId,paperSlug]);
  return Promise.all(rows.map(async (r,i) => ({...r,version:i+1,return_id:Number(r.id),evidence:await expositionEvidence(r.paper_exposition,problemId)})));
}

/** The same current source and exact review bindings used at acceptance; historical files stay accessible separately. */
export function reviewedExposition(version: any): boolean {
  return version.status === 'accepted' && !version.provisional && version.evidence?.current === true
    && (version.reviews ?? []).some((r: any) => r.verdict === 'accept' && r.trusted && !r.needs_reassessment
      && expositionReviewMatches(version.paper_exposition,r.mapping));
}

export async function latestReviewedExposition(problemId: number, projectSlug: string, paperSlug: string, main: LeanSummary, versions?: any[]) {
  const candidates = (versions ?? await expositionVersions(problemId,paperSlug)).filter(v => reviewedExposition(v)
    && v.paper_exposition.statement_binding === main.statement_binding && v.paper_exposition.source_manuscript_sha256 === main.manuscript_sha256
    && main.checked_claims.every(id => v.paper_exposition.claims.some((c: any) => c.source_claim_id === id))).sort((a,b) => b.return_id-a.return_id);
  for (const v of candidates) {
    try {
      // Reuse publication validation: missing/revoked artifacts, stale bindings or invalid PDF envelopes cannot produce a button.
      await validatePaperExposition(v.paper_exposition,v.paper_exposition.tex_sha256,paperSlug,problemId,v.files ?? [],null);
      return {return_id:v.return_id,version:v.version,url:`/projects/${encodeURIComponent(projectSlug)}/papers/${encodeURIComponent(paperSlug)}/expositions/${v.return_id}/pdf`};
    } catch (e: any) { if (e.status !== 400) throw e; }
  }
  return null;
}
