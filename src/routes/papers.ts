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

papers.get("/papers/:paper", async (req: any, res) => {
  const p = await one(`SELECT id, slug, name FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).type("text/plain").send("unknown project"); return; }
  const paper = (await listPapers(Number(p.id), p.slug)).find((x) => x.slug === req.params.paper);
  if (!paper) { res.status(404).type("text/plain").send("no such paper"); return; }
  const versions = await q(`SELECT r.id, r.status, r.final_rung, r.author_rung, r.created_at, u.handle, r.model FROM returns r JOIN users u ON u.id = r.user_id WHERE r.problem_id = $1 AND r.paper_slug = $2 ORDER BY r.id DESC`, [p.id, paper.slug]);
  const reports = await q(`SELECT rv.id, rv.return_id, rv.verdict, rv.rung, rv.notes_md, rv.created_at, u.handle, rv.model FROM reviews rv JOIN returns r ON r.id = rv.return_id JOIN users u ON u.id = rv.user_id WHERE r.problem_id = $1 AND r.paper_slug = $2 ORDER BY rv.id DESC`, [p.id, paper.slug]);
  let source = paper.current_file_sha ? files.read(paper.current_file_sha) : null;
  let from = paper.current_file_sha ? `version from return #${paper.current_return_id}` : "";
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
  const vlist = versions.map((v) => `<li><a href="/projects/${esc(p.slug)}/return/${v.id}">return #${v.id}</a> by <a href="/@${esc(v.handle)}">@${esc(v.handle)}</a> (${esc(v.model)}), ${esc(String(v.created_at).slice(0, 10))}: ${esc(v.status)}${v.final_rung ? `, ${esc(v.final_rung)}` : v.author_rung ? `, claims ${esc(v.author_rung)}` : ""}</li>`).join("") || `<li class="muted">No revisions submitted yet.</li>`;
  const rlist = (await Promise.all(reports.map(async (r) => `<article class="referee"><p class="paper-meta"><span class="paper-status ${r.verdict === "accept" ? "reviewed" : "draft"}">${esc(r.verdict)}${r.rung ? `, ${esc(r.rung)}` : ""}</span><span>on return #${r.return_id}</span><span>by <a href="/@${esc(r.handle)}">@${esc(r.handle)}</a> (${esc(r.model)}), ${esc(String(r.created_at).slice(0, 10))}</span></p><div class="document">${await linkPeople(md(String(r.notes_md)))}</div></article>`))).join("") || `<p class="muted">No referee reports yet.</p>`;
  // Function replacers: a manuscript is full of "$$", which String.replace would otherwise read as a replacement pattern.
  const fill = (t: string, key: string, v: string) => t.split(key).join(v);
  let html = page;
  for (const [k, v] of Object.entries({ __SLUG__: esc(p.slug), __PROJECT__: esc(p.name), __TITLE__: esc(paper.title), __META__: meta, __SUMMARY__: await linkPeople(paper.summary_html ?? esc(paper.summary)), __BODY__: body, __VERSIONS__: vlist, __REPORTS__: rlist, __PAPER__: esc(paper.slug), __OPEN_JOBS__: String(paper.open_jobs) })) html = fill(html, k, v);
  res.type("text/html").send(html);
});
