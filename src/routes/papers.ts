/**
 * Papers (Chris, Sep 9): manuscripts the swarm writes and referees in the open. Front and center on the project page.
 * GET /projects/:slug/papers            JSON list (HTML: the project page's Papers panel)
 * GET /projects/:slug/papers/:paper     the paper page: current manuscript rendered, versions, referee reports, how to work on it
 */
import { Router } from "express";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";
import { q, one } from "../db/index.js";
import { ROOT, PUBLIC_DIR } from "../lib/paths.js";
import * as files from "../lib/files.js";
import { protectMath } from "../lib/math.js";
import { linkPeople } from "../lib/people.js";
import { linkPaths, paperPages } from "../lib/paths-link.js";
import { history, safeRel } from "../lib/revisions.js";
import { questions } from "../lib/questions.js";
import { page as sitePage } from "../lib/page.js";
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
      (SELECT count(*) FROM jobs j WHERE j.problem_id = p.problem_id AND j.type = 'paper' AND j.status = 'queued' AND j.brief_md LIKE '%paper.slug: ' || p.slug || '%') AS open_jobs
    FROM papers p LEFT JOIN returns r ON r.id = p.current_return_id LEFT JOIN users u ON u.id = r.user_id
    WHERE p.problem_id = $1
    ORDER BY CASE p.status WHEN 'reviewed' THEN 0 WHEN 'under_review' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, p.updated_at DESC`, [problemId]);
  const inline = (t: string) => { const m = protectMath(String(t ?? "")); return m.restore(marked.parseInline(m.text.replace(/</g, "&lt;").replace(/>/g, "&gt;"), { gfm: true }) as string); };
  return rows.map((p) => ({ ...p, summary_html: inline(p.summary), status_label: STATUS[p.status] ?? p.status, url: `/projects/${slug}/papers/${p.slug}`, read: p.current_file_sha ? `/files/${p.current_file_sha}` : (p.path ? `/projects/${slug}/docs/${p.path}` : null) }));
}

papers.get("/papers", async (req: any, res) => {
  const p = await one(`SELECT id, slug FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  if ((req.header("accept") ?? "").includes("text/html")) { res.redirect(`/projects/${p.slug}#papers`); return; }
  res.json({ papers: await listPapers(Number(p.id), p.slug), how: `Papers are written and revised through jobs of type 'paper' (GET /projects/${p.slug}/start). A paper return is the manuscript as an uploaded file plus paper: { slug, file }. Reviewers write referee reports; an accepted revision becomes the current version.` });
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
  const p = await one(`SELECT id, slug, name FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  const raw = Array.isArray(req.params.path) ? req.params.path.join("/") : String(req.params.path ?? "");
  const m = /^(.*?)\/(\d+)\/diff$/.exec(raw);
  if (m) {
    const rel = safeRel(m[1]); const v = await one(`SELECT diff, version, path FROM document_versions WHERE problem_id = $1 AND path = $2 AND version = $3`, [p.id, rel, Number(m[2])]);
    if (!v) { res.status(404).type("text/plain").send("no such version"); return; }
    res.type("text/plain").send(v.diff || "(version 1: the document as mirrored; no diff)\n"); return;
  }
  const rel = safeRel(raw); if (!rel) { res.status(400).json({ error: "bad path" }); return; }
  const rows = await history(Number(p.id), rel);
  const items = rows.map((v: any) => ({ ...v, diff_url: `/projects/${p.slug}/history/${rel}/${v.version}/diff`, content_url: v.content_sha ? `/files/${v.content_sha}` : null, return_url: v.return_id ? `/projects/${p.slug}/return/${v.return_id}` : null }));
  if (!(req.header("accept") ?? "").includes("text/html")) { res.json({ path: rel, versions: items }); return; }
  const body = items.length ? `<ol class="paper-list">${items.map((v: any) => `<li><span class="paper-title">Version ${v.version}</span><span class="paper-status">${esc(v.version === 1 ? "original" : "accepted")}</span><span class="paper-facts">${v.author ? `changed by <a href="/@${esc(v.author)}">${esc(v.author_name || "@" + v.author)}</a>${v.model ? ` (${esc(v.model)})` : ""}` : esc(v.summary)}${(v.verified_by ?? []).length ? `, verified by ${v.verified_by.map((h: string) => `<a href="/@${esc(h)}">@${esc(h)}</a>`).join(", ")}` : ""}, ${esc(String(v.created_at).slice(0, 10))}${v.return_url ? ` · <a href="${v.return_url}">the change proposal</a>` : ""}${v.version > 1 ? ` · <a href="${v.diff_url}">diff</a>` : ""}${v.content_url ? ` · <a href="${v.content_url}">this version</a>` : ""}</span>${v.summary && v.author ? `<span class="paper-summary-line">${esc(v.summary)}</span>` : ""}</li>`).join("")}</ol>` : `<p class="muted">The swarm has not changed this document yet. It is served as mirrored.</p>`;
  res.type("text/html").send(sitePage({ title: `History of ${rel}`, dataPage: "history", crumbs: `<a href="/projects/${esc(p.slug)}">${esc(p.name)}</a><span>/ history /</span>${esc(rel)}`, eyebrow: "Track record", heading: rel, meta: `<p class="doc-meta"><span><a href="/projects/${esc(p.slug)}/docs/${esc(rel)}">current</a></span><span><a href="/projects/${esc(p.slug)}/docs/${esc(rel)}?original=1">original</a></span></p>`, body }));
});

papers.get("/papers/:paper", async (req: any, res) => {
  const p = await one(`SELECT id, slug, name FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).type("text/plain").send("unknown project"); return; }
  const paper = (await listPapers(Number(p.id), p.slug)).find((x) => x.slug === req.params.paper);
  if (!paper) { res.status(404).type("text/plain").send("no such paper"); return; }
  const versions = await q(`SELECT r.id, r.status, r.final_rung, r.author_rung, r.created_at, u.handle, r.model FROM returns r JOIN users u ON u.id = r.user_id WHERE r.problem_id = $1 AND r.paper_slug = $2 ORDER BY r.id DESC`, [p.id, paper.slug]);
  const docPath = paper.path ?? `paper/${paper.slug}.md`;
  const track = await history(Number(p.id), docPath);
  const reports = await q(`SELECT rv.id, rv.return_id, rv.verdict, rv.rung, rv.notes_md, rv.created_at, u.handle, rv.model FROM reviews rv JOIN returns r ON r.id = rv.return_id JOIN users u ON u.id = rv.user_id WHERE r.problem_id = $1 AND r.paper_slug = $2 ORDER BY rv.id DESC`, [p.id, paper.slug]);
  let source = paper.current_file_sha ? files.read(paper.current_file_sha) : null;
  let from = paper.current_file_sha ? `version from return #${paper.current_return_id}` : "";
  if (source === null && !paper.path) {
    const pending = await one<{ sha256: string; rid: number }>(`SELECT f.sha256, r.id AS rid FROM returns r JOIN file_refs x ON x.ref_type = 'return' AND x.ref_id = r.id JOIN files f ON f.sha256 = x.file_sha WHERE r.problem_id = $1 AND r.paper_slug = $2 AND f.ext = 'md' AND f.deleted_at IS NULL ORDER BY r.id DESC LIMIT 1`, [p.id, paper.slug]);
    if (pending) { source = files.read(pending.sha256); from = `submitted version from return #${pending.rid}, not yet reviewed`; }
  }
  if (source === null && paper.path) { const abs = join(REPOS, p.slug, paper.path); if (existsSync(abs)) { source = readFileSync(abs, "utf8"); from = `seed version from the research mirror (${paper.path})`; } }
  if (!(req.header("accept") ?? "").includes("text/html")) { res.json({ paper, versions, reports, source_from: from, manuscript_md: source }); return; }
  const baseDir = paper.path ? posix.dirname(paper.path) : "paper";
  const pages = await paperPages(p.slug);
  const docsBase = `/projects/${p.slug}/docs/`;
  const renderer = new marked.Renderer();
  const linkFn = renderer.link.bind(renderer);
  renderer.link = ({ href, title, tokens }: any) => { let h = String(href ?? ""); if (!/^(?:[a-z]+:|\/|#)/i.test(h)) { const rel = posix.normalize(posix.join(baseDir, h)).replace(/^\/+/, ""); h = pages.get(rel) ?? docsBase + rel; } return linkFn({ href: h, title, tokens } as any); };
  const md = (t: string) => { const m = protectMath(t.replace(/<!--[\s\S]*?-->/g, "")); return linkPaths(m.restore(marked.parse(m.text.replace(/</g, "&lt;").replace(/>/g, "&gt;"), { gfm: true, renderer }) as string), p.slug, baseDir, pages); };
  const body = source ? await linkPeople(md(source)) : "<p class=\"muted\">No manuscript yet.</p>";
  const page = readFileSync(join(PUBLIC_DIR, "paper.html"), "utf8");
  const meta = `<p class="paper-meta"><span class="paper-status ${esc(paper.status)}">${esc(paper.status_label)}</span>${paper.grade ? `<span>${esc(paper.grade)}</span>` : ""}${paper.version_by ? `<span>current version by @${esc(paper.version_by)}, ${esc(String(paper.version_at).slice(0, 10))}${paper.final_rung ? `, ${esc(paper.final_rung)}` : ""}</span>` : ""}<span>${esc(from)}</span></p>`;
  const tlist = track.slice().reverse().map((v: any) => `<li>Version ${v.version}: ${v.author ? `changed by <a href="/@${esc(v.author)}">${esc(v.author_name || "@" + v.author)}</a>${v.model ? ` (${esc(v.model)})` : ""}${(v.verified_by ?? []).length ? `, verified by ${v.verified_by.map((h: string) => `<a href="/@${esc(h)}">@${esc(h)}</a>`).join(", ")}` : ""}` : esc(v.summary)}, ${esc(String(v.created_at).slice(0, 10))}${v.version > 1 ? ` · <a href="/projects/${esc(p.slug)}/history/${esc(docPath)}/${v.version}/diff">diff</a>` : ""}</li>`).join("");
  const vlist = (tlist ? `<li><b>Track record</b> (<a href="/projects/${esc(p.slug)}/history/${esc(docPath)}">all versions</a>)<ul>${tlist}</ul></li>` : "") + versions.map((v) => `<li><a href="/projects/${esc(p.slug)}/return/${v.id}">return #${v.id}</a> by <a href="/@${esc(v.handle)}">@${esc(v.handle)}</a> (${esc(v.model)}), ${esc(String(v.created_at).slice(0, 10))}: ${esc(v.status)}${v.final_rung ? `, ${esc(v.final_rung)}` : v.author_rung ? `, claims ${esc(v.author_rung)}` : ""}</li>`).join("") || `<li class="muted">No revisions submitted yet.</li>`;
  const rlist = (await Promise.all(reports.map(async (r) => `<article class="referee"><p class="paper-meta"><span class="paper-status ${r.verdict === "accept" ? "reviewed" : "draft"}">${esc(r.verdict)}${r.rung ? `, ${esc(r.rung)}` : ""}</span><span>on return #${r.return_id}</span><span>by <a href="/@${esc(r.handle)}">@${esc(r.handle)}</a> (${esc(r.model)}), ${esc(String(r.created_at).slice(0, 10))}</span></p><div class="document">${await linkPeople(md(String(r.notes_md)))}</div></article>`))).join("") || `<p class="muted">No referee reports yet.</p>`;
  // Function replacers: a manuscript is full of "$$", which String.replace would otherwise read as a replacement pattern.
  const fill = (t: string, key: string, v: string) => t.split(key).join(v);
  let html = page;
  for (const [k, v] of Object.entries({ __SLUG__: esc(p.slug), __PROJECT__: esc(p.name), __TITLE__: esc(paper.title), __META__: meta, __SUMMARY__: await linkPeople(paper.summary_html ?? esc(paper.summary)), __BODY__: body, __VERSIONS__: vlist, __REPORTS__: rlist, __PAPER__: esc(paper.slug), __OPEN_JOBS__: String(paper.open_jobs) })) html = fill(html, k, v);
  res.type("text/html").send(html);
});
