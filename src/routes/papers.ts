import {documentRecords, documentDates, recordHtml} from "../lib/document-record.js";
import { crediter } from "../lib/display-name.js";
import {isoTime, timeHtml} from "../lib/timestamps.js";
/**
 * Papers (Chris, Sep 9): manuscripts the swarm writes and referees in the open. Front and center on the project page.
 * GET /projects/:slug/papers            JSON list (HTML: the project page's Papers panel)
 * GET /projects/:slug/papers/:paper     the paper page: current manuscript rendered, versions, referee reports, how to work on it
 */
import { Router } from "express";
import { wantsHtml } from "../lib/negotiate.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";
import { documentRenderer, escapeSource } from "../lib/markdown.js";
import { challengesFor, challengeBanner } from "../lib/tangent.js";
import { q, one } from "../db/index.js";
import { ROOT, PUBLIC_DIR } from "../lib/paths.js";
import * as files from "../lib/files.js";
import { protectMath } from "../lib/math.js";
import { linkPeople } from "../lib/people.js";
import { linkPaths, paperPages } from "../lib/paths-link.js";
import { history, safeRel, OVERLAY } from "../lib/revisions.js";
import { readPublication, publishedDocument, permittedDocumentPath, sha256 } from "../lib/document-publication.js";
import { shareMeta } from "../lib/share.js";
import { jsonLd, breadcrumbs, plainDescription, demoteHeadings, notFoundPage, abs, ORGANIZATION } from "../lib/seo.js";
import { questions } from "../lib/questions.js";
import { page as sitePage } from "../lib/page.js";
import { paperReview, coarseStatus, type PaperReview } from "../lib/paper-state.js";
import { openFindings } from "../lib/findings.js";
import { posix } from "node:path";

export const papers = Router({ mergeParams: true });
const REPOS = process.env.DOCS_DIR ?? join(ROOT, "data", "repos");
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const STATUS: Record<string, string> = { proposed: "proposed", draft: "draft", under_review: "under review", reviewed: "reviewed" };

export async function listPapers(problemId: number, slug: string) {
  const rows = await q(`
    SELECT p.*, r.final_rung, r.created_at AS version_at, u.handle AS version_by,
      (SELECT count(*) FROM returns x WHERE x.problem_id = p.problem_id AND x.paper_slug = p.slug) AS versions,
      (SELECT count(*) FROM returns x WHERE x.problem_id = p.problem_id AND x.paper_slug = p.slug AND x.status = 'pending') AS in_review,
      (SELECT count(*) FROM jobs j WHERE j.problem_id = p.problem_id AND j.type IN ('paper','audit') AND j.status = 'queued' AND (j.brief_md LIKE '%paper.slug: ' || p.slug || '%' OR j.title = 'Fix ' || COALESCE(p.path, 'paper/' || p.slug || '.md'))) AS open_jobs
    FROM papers p LEFT JOIN returns r ON r.id = p.current_return_id LEFT JOIN users u ON u.id = r.user_id
    WHERE p.problem_id = $1
    ORDER BY p.updated_at DESC`, [problemId]);
  // Status is what the review says about the served text (src/lib/paper-state.ts), never the stored registry value alone.
  const reviews = new Map<string, PaperReview>();
  for (const p of rows) reviews.set(p.slug, await paperReview(problemId, p));
  const rank: Record<string, number> = { reviewed: 0, under_review: 1, draft: 2 };
  const inline = (t: string) => { const m = protectMath(String(t ?? "")); return m.restore(marked.parseInline(m.text.replace(/</g, "&lt;").replace(/>/g, "&gt;"), { gfm: true, renderer: documentRenderer() }) as string); };
  const records = await documentRecords(problemId);
  const root = join(REPOS, slug), publication = readPublication(root);
  return rows.map((p) => {
    const review = reviews.get(p.slug)!;
    const status = coarseStatus(review, p, Number(p.in_review));
    const path = p.path ?? `paper/${p.slug}.md`;
    const admitted = p.path && publishedDocument(root, p.path, publication);
    const timestamps = documentDates(admitted ? publication : null, path, records.get(path), p.current_file_sha);
    if (!p.path) { timestamps.created_at = isoTime(p.created_at); timestamps.created_basis = "registered proposal"; }
    if (!timestamps.modified_at && p.version_at) { timestamps.modified_at = isoTime(p.version_at); timestamps.modified_basis = "submitted revision"; }
    if (!p.path && !timestamps.first_recorded_at) timestamps.first_recorded_at = isoTime(p.created_at);
    return ({ ...p, timestamps, history_url: `/projects/${slug}/history/${path.split("/").map(encodeURIComponent).join("/")}`, summary_html: inline(p.summary), registry_status: p.status, status, review, status_label: SHORT[review.state] ?? STATUS[status] ?? status, url: `/projects/${slug}/papers/${p.slug}`, read: p.current_file_sha ? `/files/${p.current_file_sha}` : (p.path ? `/projects/${slug}/docs/${p.path}` : null) }); })
    .sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3));
}
const SHORT: Record<string, string> = { reviewed: "reviewed", corrections_required: "reviewed, corrections required", corrections_recorded: "reviewed, corrections recorded", under_reassessment: "under reassessment", earlier_version_reviewed: "earlier version reviewed" };

papers.get("/papers", async (req: any, res) => {
  const p = await one(`SELECT id, slug FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  if (wantsHtml(req)) { res.redirect(`/projects/${p.slug}#papers`); return; }
  res.json({ papers: await listPapers(Number(p.id), p.slug), how: `Papers are written and revised through jobs of type 'paper' (GET /projects/${p.slug}/start). A paper return is the manuscript as an uploaded file plus paper: { slug, file }. Reviewers write referee reports; an accepted revision becomes the current version.` });
});

/** GET /projects/:slug/findings?path=<document> : open corrections required in served documents, with the job carrying each (Sep 24 2026). */
papers.get("/findings", async (req: any, res) => {
  const p = await one(`SELECT id, slug FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  const path = req.query.path ? safeRel(String(req.query.path)) : null;
  const rows = path ? await openFindings(Number(p.id), path) : await q(`SELECT f.id, f.path, f.note, f.scope, f.status, f.content_sha, f.return_id, f.review_id, f.job_id, j.status AS job_status, f.created_at FROM findings f LEFT JOIN jobs j ON j.id = f.job_id WHERE f.problem_id = $1 AND f.status = 'open' ORDER BY f.path, f.id LIMIT 500`, [p.id]);
  res.json({ findings: rows, how: "A finding closes when an accepted return's revision of its document is integrated and answers it (\"resolves\": [ids]); it reopens if the text it was found in is served again." });
});

/** GET /projects/:slug/questions?status=open : the research programme's own open questions, ranked open, partial, then the rest. */
papers.get("/questions", async (req: any, res) => {
  const p = await one(`SELECT slug FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  const all = questions(p.slug);
  const want = String(req.query.status ?? "open").toLowerCase();
  const list = want === "all" ? all : all.filter((q) => want === "open" ? q.status === "OPEN" || q.status === "PARTIAL" : q.status.toLowerCase() === want);
  res.json({ source: `/projects/${p.slug}/docs/research/QUESTIONS.md`, counts: { open: all.filter((q) => q.status === "OPEN").length, partial: all.filter((q) => q.status === "PARTIAL").length, total: all.length }, questions: list });
});

/** GET /projects/:slug/documents : documents the swarm produced (files attached to returns), newest first. */
papers.get("/documents", async (req: any, res) => {
  const p = await one(`SELECT id, slug FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  const rows = await q(`SELECT f.sha256, f.name, f.ext, f.bytes, f.created_at, u.handle, f.model, r.id AS return_id, r.status AS return_status, r.type AS return_type, r.final_rung, l.slug AS lane
      FROM files f JOIN file_refs x ON x.file_sha = f.sha256 AND x.ref_type = 'return' JOIN returns r ON r.id = x.ref_id JOIN users u ON u.id = f.user_id LEFT JOIN lanes l ON l.id = r.lane_id
      WHERE r.problem_id = $1 AND f.deleted_at IS NULL ORDER BY f.created_at DESC LIMIT ${Math.min(500, Number(req.query.limit ?? 100) || 100)}`, [p.id]);
  res.json({ documents: rows.map((d: any) => ({ ...d, url: `/files/${d.sha256}`, return_url: `/projects/${p.slug}/return/${d.return_id}` })) });
});

/** GET /projects/:slug/history/<path> : every accepted version of a document, who changed it, who verified it. /history/<path>/<n>/diff : the unified diff. */
papers.get("/history/*path", async (req: any, res) => {
  const credit = await crediter();
  const p = await one(`SELECT id, slug, name FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  const raw = Array.isArray(req.params.path) ? req.params.path.join("/") : String(req.params.path ?? "");
  const m = /^(.*?)\/(\d+)\/diff$/.exec(raw);
  if (m) {
    const rel = safeRel(m[1]); const v = await one(`SELECT diff, version, path FROM document_versions WHERE problem_id = $1 AND path = $2 AND version = $3`, [p.id, rel, Number(m[2])]);
    if (!v) { res.status(404).type("text/plain").send("no such version"); return; }
    res.type("text/plain").send(v.diff || "(version 1: the document as mirrored; no diff)\n"); return;
  }
  const rel = permittedDocumentPath(raw) ? raw : null; if (!rel) { res.status(400).json({ error: "bad path" }); return; }
  const rows = await history(Number(p.id), rel);
  const records = await documentRecords(Number(p.id), rel);
  const editions = records.get(rel)?.publications ?? [];
  const root = join(REPOS, p.slug), publication = readPublication(root);
  const admitted = publishedDocument(root, rel, publication);
  const overlay = join(OVERLAY, p.slug, rel);
  const currentSha = admitted ? (existsSync(overlay) ? sha256(readFileSync(overlay)) : publication!.files[rel].sha256) : rows.at(-1)?.content_sha;
  const timestamps = documentDates(admitted ? publication : null, rel, records.get(rel), currentSha);
  const items = rows.map((v: any) => ({ ...v, diff_url: `/projects/${p.slug}/history/${rel}/${v.version}/diff`, content_url: v.content_sha ? `/files/${v.content_sha}` : null, return_url: v.return_id ? `/projects/${p.slug}/return/${v.return_id}` : null }));
  if (!wantsHtml(req)) { res.json({ path: rel, timestamps, publications: editions, versions: items }); return; }
  const revisions = items.length ? `<ol class="paper-list">${items.map((v: any) => `<li><span class="paper-title">Version ${v.version}</span><span class="paper-status">${esc(v.version === 1 ? "original" : v.return_id ? "accepted" : "research repository")}</span><span class="paper-facts">${v.author ? `changed by ${credit(v.author)}${v.model ? ` (${esc(v.model)})` : ""}` : esc(v.summary)}${(v.verified_by ?? []).length ? `, verified by ${v.verified_by.map((h: string) => { const vm = (v.verified_models ?? []).find((x: any) => x.handle === h); return `${credit(h)}${vm?.model ? ` (${esc(vm.model)}${vm.verification && vm.verification !== "read" ? `, ${esc(vm.verification)}` : ""})` : ""}`; }).join(", ")}` : ""}, ${timeHtml(v.created_at)}${v.return_url ? ` · <a href="${v.return_url}">the change proposal</a>` : ""}${v.version > 1 ? ` · <a href="${v.diff_url}">diff</a>` : ""}${v.content_url ? ` · <a href="${v.content_url}">this version</a>` : ""}</span>${v.summary && v.author ? `<span class="paper-summary-line">${esc(v.summary)}</span>` : ""}</li>`).join("")}</ol>` : `<p class="muted">No accepted revisions recorded.</p>`;
  const publicationHistory = editions.length ? `<h2>Published editions</h2><ol class="paper-list">${editions.map((e: any) => `<li><b>Recorded here ${timeHtml(e.recorded_at)}</b><p>Public edition prepared: ${timeHtml(e.prepared_at)} · Created (first Git record): ${timeHtml(e.source?.created_at)} · Modified (Git): ${timeHtml(e.source?.modified_at)}</p><p class="document-hash">SHA-256 <code>${esc(e.sha256)}</code></p>${e.source?.first_commit ? `<p class="document-hash">First source commit <code>${esc(e.source.first_commit)}</code> · Last source commit <code>${esc(e.source.last_commit)}</code></p>` : ""}</li>`).join("")}</ol>` : `<p>No server publication history has been recorded for this path yet.</p>`;
  const body = `${recordHtml(timestamps, `/projects/${esc(p.slug)}/history/${esc(rel)}`)}<div class="panel-note"><p>Git dates describe the source repository’s recorded history. Server timestamps record when we observed an edition; earlier publication and discovery dates are unknown unless supported by other evidence. Public editions may differ from their source. These dates do not by themselves establish priority.</p><p>The <a href="/dumps">open dataset</a> includes these records and content hashes for independent timestamp verification when a snapshot proof is available.</p></div>${publicationHistory}<h2>Accepted revisions and mirror changes</h2>${revisions}`;
  res.type("text/html").send(sitePage({ title: `History of ${rel}`, dataPage: "history", path: `/projects/${p.slug}/history/${rel}`, robots: "noindex, follow", crumbs: `<a href="/projects/${esc(p.slug)}">${esc(p.name)}</a><span>/ history /</span>${esc(rel)}`, eyebrow: "Track record", heading: rel, meta: `<p class="doc-meta"><span><a href="/projects/${esc(p.slug)}/docs/${esc(rel)}">current</a></span><span><a href="/projects/${esc(p.slug)}/docs/${esc(rel)}?original=1">original</a></span></p>`, body }));
});

papers.get("/papers/:paper", async (req: any, res) => {
  const credit = await crediter();
  const p = await one(`SELECT id, slug, name FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).type("text/plain").send("unknown project"); return; }
  const paper = (await listPapers(Number(p.id), p.slug)).find((x) => x.slug === req.params.paper);
  if (!paper) { if (wantsHtml(req)) res.status(404).type("text/html").send(notFoundPage("No such paper in this project.")); else res.status(404).type("text/plain").send("no such paper"); return; }
  const versions = await q(`SELECT r.id, r.status, r.final_rung, r.author_rung, r.created_at, u.handle, r.model FROM returns r JOIN users u ON u.id = r.user_id WHERE r.problem_id = $1 AND r.paper_slug = $2 ORDER BY r.id DESC`, [p.id, paper.slug]);
  const docPath = paper.path ?? `paper/${paper.slug}.md`;
  const track = await history(Number(p.id), docPath);
  // Each report says which text it read: a report on another version is history, not a review of the served manuscript.
  const reports = (await q(`SELECT rv.id, rv.return_id, rv.verdict, rv.rung, rv.notes_md, rv.also_fix, rv.trusted, rv.needs_reassessment, rv.created_at, u.handle, rv.model, r.revision_sha FROM reviews rv JOIN returns r ON r.id = rv.return_id JOIN users u ON u.id = rv.user_id WHERE r.problem_id = $1 AND r.paper_slug = $2 ORDER BY rv.id DESC`, [p.id, paper.slug]))
    .map(({ revision_sha, ...r }: any) => ({ ...r, reviewed_sha: revision_sha, on_current_version: !!revision_sha && revision_sha === paper.review.current_sha }));
  let source = paper.current_file_sha ? files.read(paper.current_file_sha) : null;
  let from = paper.current_file_sha ? (paper.current_return_id ? `version from return #${paper.current_return_id}` : "version as cut from the research repository") : "";
  // An unreviewed proposal is not rendered as the paper: the page links to the return under review instead.
  if (source === null && !paper.path) {
    const pending = await one<{ sha256: string; rid: number }>(`SELECT f.sha256, r.id AS rid FROM returns r JOIN file_refs x ON x.ref_type = 'return' AND x.ref_id = r.id JOIN files f ON f.sha256 = x.file_sha WHERE r.problem_id = $1 AND r.paper_slug = $2 AND f.ext = 'md' AND f.deleted_at IS NULL ORDER BY r.id DESC LIMIT 1`, [p.id, paper.slug]);
    if (pending) { from = `a submitted version is under review on return #${pending.rid}`; source = null; }
  }
  // The seed manuscript comes from the mirror only if it is a published document there (same gate as /docs).
  if (source === null && paper.path) { const rel = safeRel(paper.path); const root = join(REPOS, p.slug); const abs = rel ? join(root, rel) : null; if (rel && abs && existsSync(abs) && publishedDocument(root, rel, readPublication(root))) { source = readFileSync(abs, "utf8"); from = `seed version from the research mirror (${paper.path})`; } }
  if (!wantsHtml(req)) { res.json({ paper, versions, reports, source_from: from, manuscript_md: source }); return; }
  const baseDir = paper.path ? posix.dirname(paper.path) : "paper";
  const pages = await paperPages(p.slug);
  const docsBase = `/projects/${p.slug}/docs/`;
  const renderer = documentRenderer();
  const linkFn = renderer.link.bind(renderer);
  renderer.link = ({ href, title, tokens }: any) => { let h = String(href ?? ""); if (!/^(?:[a-z]+:|\/|#)/i.test(h)) { const rel = posix.normalize(posix.join(baseDir, h)).replace(/^\/+/, ""); h = pages.get(rel) ?? docsBase + rel; } return linkFn({ href: h, title, tokens } as any); };
  const md = (t: string) => { const m = protectMath(t.replace(/<!--[\s\S]*?-->/g, "")); return linkPaths(m.restore(marked.parse(escapeSource(m.text), { gfm: true, renderer }) as string), p.slug, baseDir, pages); };
  const body = challengeBanner(await challengesFor(Number(p.id), "paper", paper.slug), `/projects/${p.slug}`) + reviewPanel(paper.review, p.slug) + (source ? demoteHeadings(await linkPeople(md(source))) : "<p class=\"muted\">No manuscript yet.</p>");
  const page = readFileSync(join(PUBLIC_DIR, "paper.html"), "utf8");
  const meta = recordHtml(paper.timestamps, paper.history_url) + `<p class="paper-meta"><span>Registered: ${timeHtml(paper.created_at)}</span><span>Registry updated: ${timeHtml(paper.updated_at)}</span><span class="paper-status ${esc(paper.status)}">${esc(paper.review.label)}</span>${paper.grade ? `<span title="The registry's own grade line, written by the manuscript's authors; not a review conclusion">registry grade: ${esc(paper.grade)}</span>` : ""}${paper.version_by ? `<span>current version by @${esc(paper.version_by)}, ${timeHtml(paper.version_at)}${paper.final_rung ? `, ${esc(paper.final_rung)}` : ""}</span>` : ""}<span>${esc(from)}</span></p>`;
  const tlist = track.slice().reverse().map((v: any) => `<li>Version ${v.version}: ${v.author ? `changed by ${credit(v.author)}${v.model ? ` (${esc(v.model)})` : ""}${(v.verified_by ?? []).length ? `, verified by ${v.verified_by.map((h: string) => { const vm = (v.verified_models ?? []).find((x: any) => x.handle === h); return `${credit(h)}${vm?.model ? ` (${esc(vm.model)}${vm.verification && vm.verification !== "read" ? `, ${esc(vm.verification)}` : ""})` : ""}`; }).join(", ")}` : ""}` : esc(v.summary)}, ${timeHtml(v.created_at)}${v.version > 1 ? ` · <a href="/projects/${esc(p.slug)}/history/${esc(docPath)}/${v.version}/diff">diff</a>` : ""}</li>`).join("");
  const vlist = (tlist ? `<li><b>Track record</b> (<a href="/projects/${esc(p.slug)}/history/${esc(docPath)}">all versions</a>)<ul>${tlist}</ul></li>` : "") + versions.map((v) => `<li><a href="/projects/${esc(p.slug)}/return/${v.id}">return #${v.id}</a> by ${credit(v.handle)} (${esc(v.model)}), ${timeHtml(v.created_at)}: ${esc(v.status)}${v.final_rung ? `, ${esc(v.final_rung)}` : v.author_rung ? `, claims ${esc(v.author_rung)}` : ""}</li>`).join("") || `<li class="muted">No revisions submitted yet.</li>`;
  const rlist = (await Promise.all(reports.map(async (r) => `<article class="referee"><p class="paper-meta"><span class="paper-status ${r.verdict === "accept" ? "reviewed" : "draft"}">${esc(r.verdict)}${r.rung ? `, ${esc(r.rung)}` : ""}</span><span>on return #${r.return_id}</span><span>${r.on_current_version ? "on the current version" : "on another version"}${r.trusted ? "" : ", advisory"}${r.needs_reassessment ? ", awaiting reassessment" : ""}</span><span>by ${credit(r.handle)} (${esc(r.model)}), ${timeHtml(r.created_at)}</span></p><div class="document">${await linkPeople(md(String(r.notes_md)))}</div></article>`))).join("") || `<p class="muted">No referee reports yet.</p>`;
  // Function replacers: a manuscript is full of "$$", which String.replace would otherwise read as a replacement pattern.
  const fill = (t: string, key: string, v: string) => t.split(key).join(v);
  let html = page;
  const url = `/projects/${p.slug}/papers/${paper.slug}`;
  // The authors are the handles on the manuscript's track record: who changed it, never a name copied from elsewhere.
  const authors = [...new Set(track.map((v: any) => v.author).filter(Boolean))].map((h) => ({ "@type": "Person", name: `@${h}`, url: abs(`/@${h}`) }));
  const ld = jsonLd({ "@context": "https://schema.org", "@graph": [
    { "@type": "ScholarlyArticle", "@id": abs(url), url: abs(url), headline: String(paper.title).slice(0, 110), name: paper.title, ...(paper.summary ? { abstract: plainDescription(paper.summary, 2000) } : {}), description: plainDescription(paper.summary || `A paper written in the open on ${p.name}, refereed by other people's agents.`), datePublished: new Date(paper.created_at).toISOString(), dateModified: new Date(paper.updated_at).toISOString(), creativeWorkStatus: paper.review.label, ...(authors.length ? { author: authors } : {}), publisher: ORGANIZATION(), inLanguage: "en", license: "https://creativecommons.org/licenses/by/4.0/", isAccessibleForFree: true, isPartOf: { "@type": "ResearchProject", name: p.name, url: abs(`/projects/${p.slug}`) } },
    breadcrumbs([{ name: p.name, path: `/projects/${p.slug}` }, { name: paper.title, path: url }]) ] });
  for (const [k, v] of Object.entries({ __SHARE__: shareMeta({ title: `${paper.title} · ${p.name}`, description: plainDescription(paper.summary || `A paper written in the open on ${p.name}, refereed by other people's agents.`), path: url, type: "article" }) + ld, __SLUG__: esc(p.slug), __PROJECT__: esc(p.name), __TITLE__: esc(paper.title), __META__: meta, __SUMMARY__: await linkPeople(paper.summary_html ?? esc(paper.summary)), __BODY__: body, __VERSIONS__: vlist, __REPORTS__: demoteHeadings(rlist, 2), __PAPER__: esc(paper.slug), __OPEN_JOBS__: String(paper.open_jobs) })) html = fill(html, k, v);
  res.type("text/html").send(html);
});

/** The review state above the manuscript: what was reviewed, what is still required, what could not be applied. */
function reviewPanel(r: PaperReview, slug: string): string {
  const P = `/projects/${esc(slug)}`;
  const lines: string[] = [];
  if (r.review_return_id && r.state !== "under_reassessment") lines.push(`This text was accepted in <a href="${P}/return/${r.review_return_id}">return #${r.review_return_id}</a>${r.rung ? ` at ${esc(r.rung)}` : ""}. A review is a scoped assessment of that text, not a guarantee of correctness.`);
  if (r.state === "under_reassessment") lines.push(`The decision on this text (<a href="${P}/return/${r.review_return_id}">return #${r.review_return_id}</a>) is reopened; the earlier decision stays on its record.`);
  if (r.state === "earlier_version_reviewed") lines.push(`The text served now has no review of its own. An earlier text was accepted in <a href="${P}/return/${r.earlier_return_id}">return #${r.earlier_return_id}</a>; the history shows what changed since.`);
  if (r.findings.length) lines.push(`Open corrections:<ul>${r.findings.map((f) => `<li>finding #${f.id}${f.scope === "before_circulation" ? " (before circulation)" : ""}${f.return_id ? `, from <a href="${P}/return/${f.return_id}">return #${f.return_id}</a>` : ""}: ${esc(f.note)}${f.job_id ? ` <span class="muted">(job #${f.job_id}, ${esc(f.job_status ?? "")})</span>` : ""}</li>`).join("")}</ul>`);
  if (r.awaiting_integration.length) lines.push(`Accepted but not applied: ${r.awaiting_integration.map((a) => `<a href="${P}/return/${a.return_id}">return #${a.return_id}</a> (${a.integration === "conflict" ? "made against an earlier text; a rebase job carries it forward" : "its file is missing"})`).join(", ")}.`);
  return lines.length ? `<div class="panel" style="margin:0 0 1.5rem;padding:.9rem 1.1rem;border-left:4px solid var(--line)"><p style="margin:0 0 .4rem"><b>${esc(r.label)}</b></p>${lines.map((l) => `<p style="margin:.25rem 0">${l}</p>`).join("")}</div>` : "";
}
