/**
 * Docs browser (scope Q43): render the research repo's documents on the site. Read-only, from a filtered copy of the
 * repo under data/repos/<slug> (rsynced by the mirror script; pulled from the public repo after launch).
 * Markdown is rendered with raw HTML escaped; everything else is served as inert text or as a download.
 */
import { Router } from "express";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, extname, dirname, posix } from "node:path";
import { marked } from "marked";
import { one } from "../db/index.js";
import { ROOT } from "../lib/paths.js";

export const docs = Router({ mergeParams: true });
const REPOS = process.env.DOCS_DIR ?? join(ROOT, "data", "repos");
const TEXT_EXT = new Set([".js", ".ts", ".py", ".sh", ".txt", ".json", ".jsonl", ".csv", ".tsv", ".lean", ".tex", ".bib", ".log", ".yaml", ".yml", ".toml", ".sha256", ".ots.txt", ""]);
const IMG: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp" };
const MAX_TEXT = 3 * 1024 * 1024;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function safePath(root: string, rel: string): string | null {
  const n = normalize("/" + rel).replace(/^\/+/, "");
  if (n.split("/").some((seg) => seg === ".." || seg === ".git" || seg.startsWith(".git"))) return null;
  const abs = join(root, n);
  if (!abs.startsWith(root)) return null;
  return abs;
}

function chrome(slug: string, title: string, crumbs: string, body: string, extra = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · ${esc(slug)} · solveathome</title>
<style>
:root{--bg:#fbfaf7;--fg:#1a1a1a;--mut:#6b6b66;--line:#e4e2dc;--card:#fff;--acc:#1f5fbf;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#ececec;--mut:#9a9a94;--line:#2a2a2a;--card:#181818;--acc:#7fb0ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
header{display:flex;gap:1rem;align-items:baseline;padding:1rem 1.25rem;border-bottom:1px solid var(--line);flex-wrap:wrap}header a{color:inherit;text-decoration:none;font-weight:600}.muted{color:var(--mut)}
main{max-width:56rem;margin:0 auto;padding:1rem 1.25rem 4rem}article{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1.25rem 1.5rem;overflow-wrap:anywhere}
article h1{font-size:1.6rem;margin:.2rem 0 .8rem}article h2{font-size:1.2rem;margin:1.6rem 0 .5rem}article h3{font-size:1.05rem}article a{color:var(--acc)}
pre{background:rgba(127,127,127,.12);padding:.8rem 1rem;border-radius:8px;overflow-x:auto;font-size:.88rem;line-height:1.45}code{background:rgba(127,127,127,.12);padding:.05em .3em;border-radius:4px;font-size:.92em}pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;font-size:.92rem;display:block;overflow-x:auto}th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mut)}
blockquote{border-left:3px solid var(--line);margin:0;padding:.1rem 1rem;color:var(--mut)}
.ledger{border:1px solid var(--line);border-radius:8px;padding:.6rem .9rem;margin:0 0 1rem;font-size:.9rem;background:rgba(127,127,127,.06)}.ledger b{margin-right:.4rem}.ledger div{margin:.15rem 0}
.status{display:inline-block;padding:.05em .5em;border-radius:99px;font-size:.8rem;font-weight:600;border:1px solid var(--line)}
ul.tree{list-style:none;padding:0;margin:0}ul.tree li{padding:.25rem 0;border-bottom:1px solid var(--line)}ul.tree a{color:var(--acc);text-decoration:none}ul.tree small{color:var(--mut);margin-left:.5rem}
</style></head><body><header><a href="/projects/${esc(slug)}">solveathome / ${esc(slug)}</a><span class="muted">/ docs / ${crumbs}</span>${extra}</header><main><article>${body}</article></main></body></html>`;
}

function crumbsFor(slug: string, rel: string): string {
  const parts = rel.split("/").filter(Boolean); const out: string[] = [`<a href="/projects/${esc(slug)}/docs" style="font-weight:400">root</a>`];
  let acc = "";
  parts.forEach((p, i) => { acc += (acc ? "/" : "") + p; out.push(i === parts.length - 1 ? esc(p) : `<a href="/projects/${esc(slug)}/docs/${esc(acc)}" style="font-weight:400">${esc(p)}</a>`); });
  return out.join(" / ");
}

function renderMarkdown(src: string, slug: string, rel: string): { html: string; ledger: Record<string, string> | null; title: string } {
  const ledger: Record<string, string> = {};
  const m = /<!--\s*ledger\n([\s\S]*?)-->\s*/.exec(src);
  if (m) { for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) ledger[line.slice(0, i).trim()] = line.slice(i + 1).trim(); } src = src.replace(m[0], ""); }
  const title = (/^#\s+(.+)$/m.exec(src)?.[1] ?? rel.split("/").pop() ?? rel).trim();
  const safe = src.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const base = `/projects/${slug}/docs/`;
  const dir = posix.dirname(rel);
  const renderer = new marked.Renderer();
  const linkFn = renderer.link.bind(renderer);
  renderer.link = ({ href, title, tokens }: any) => {
    let h = String(href ?? "");
    if (!/^(?:[a-z]+:|\/|#)/i.test(h)) h = base + posix.normalize(posix.join(dir === "." ? "" : dir, h)).replace(/^\/+/, "");
    return linkFn({ href: h, title, tokens } as any);
  };
  const imgFn = renderer.image.bind(renderer);
  renderer.image = ({ href, title, text }: any) => {
    let h = String(href ?? "");
    if (!/^(?:[a-z]+:|\/)/i.test(h)) h = base + posix.normalize(posix.join(dir === "." ? "" : dir, h)).replace(/^\/+/, "");
    return imgFn({ href: h, title, text } as any);
  };
  const html = marked.parse(safe, { gfm: true, breaks: false, renderer }) as string;
  return { html, ledger: m ? ledger : null, title };
}

docs.get("/docs{/*path}", async (req: any, res) => {
  const slug = String(req.params.slug);
  const rel = Array.isArray(req.params.path) ? req.params.path.join("/") : String(req.params.path ?? "");
  const root = join(REPOS, slug);
  if (!existsSync(root)) { res.status(404).type("text/plain").send("no documents for this project yet\n"); return; }
  const abs = safePath(root, rel);
  if (!abs || !existsSync(abs)) { res.status(404).type("text/plain").send("not found\n"); return; }
  const st = statSync(abs);
  if (st.isDirectory()) {
    const entries = readdirSync(abs).filter((n) => !n.startsWith(".")).sort((a, b) => { const da = statSync(join(abs, a)).isDirectory(), db = statSync(join(abs, b)).isDirectory(); return da === db ? a.localeCompare(b) : da ? -1 : 1; });
    const readme = entries.find((n) => /^readme\.md$/i.test(n));
    let intro = "";
    if (readme) { const r = renderMarkdown(readFileSync(join(abs, readme), "utf8"), slug, posix.join(rel, readme)); intro = `${ledgerHtml(r.ledger)}${r.html}<hr>`; }
    const list = entries.map((n) => { const s = statSync(join(abs, n)); const href = `/projects/${esc(slug)}/docs/${esc(posix.join(rel, n))}`; return `<li><a href="${href}">${esc(n)}${s.isDirectory() ? "/" : ""}</a>${s.isDirectory() ? "" : `<small>${s.size} B</small>`}</li>`; }).join("");
    res.type("text/html").send(chrome(slug, rel || "root", crumbsFor(slug, rel), `${intro}<ul class="tree">${list}</ul>`));
    return;
  }
  const ext = extname(abs).toLowerCase();
  if (ext === ".md") {
    const r = renderMarkdown(readFileSync(abs, "utf8"), slug, rel);
    const claim = await one(`SELECT c.status, c.origin_handle FROM claims c JOIN problems p ON p.id = c.problem_id WHERE p.slug = $1 AND c.path = $2`, [slug, rel]);
    const extra = claim ? `<span class="muted">claim status <span class="status">${esc(String(claim.status).toLowerCase())}</span> · origin <a href="/@${esc(claim.origin_handle)}" style="font-weight:400">@${esc(claim.origin_handle)}</a></span>` : "";
    res.type("text/html").send(chrome(slug, r.title, crumbsFor(slug, rel), `${ledgerHtml(r.ledger)}${r.html}`, extra));
    return;
  }
  if (IMG[ext]) { res.type(IMG[ext]).set("X-Content-Type-Options", "nosniff").send(readFileSync(abs)); return; }
  if (TEXT_EXT.has(ext) && st.size <= MAX_TEXT) {
    res.set({ "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" }).send(readFileSync(abs, "utf8"));
    return;
  }
  res.set({ "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${posix.basename(rel)}"`, "X-Content-Type-Options": "nosniff" }).send(readFileSync(abs));
});

function ledgerHtml(l: Record<string, string> | null): string {
  if (!l) return "";
  const rows = ["id", "status", "question", "verdict", "todo", "parity"].filter((k) => l[k]).map((k) => `<div><b>${k}</b>${k === "status" ? `<span class="status">${esc(l[k].toLowerCase())}</span>` : esc(l[k])}</div>`).join("");
  return `<div class="ledger">${rows}</div>`;
}
