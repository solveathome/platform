/**
 * Seed and refresh the papers registry from the mirror's paper/ directory, and queue one 'paper' job per paper
 * that has no open job: write it (proposal) or bring it to referee-ready (draft). Idempotent.
 * Run: node dist/scripts/import-papers.js [slug]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate, q, one } from "../src/db/index.js";
import { ROOT } from "../src/lib/paths.js";

const slug = process.argv[2] ?? "twin-primes";
const REPOS = process.env.DOCS_DIR ?? join(ROOT, "data", "repos");
await migrate();
const p = await one<{ id: number }>(`SELECT id FROM problems WHERE slug = $1`, [slug]);
if (!p) throw new Error(`unknown project ${slug}`);
const root = join(REPOS, slug, "paper");
if (!existsSync(root)) throw new Error(`no paper/ directory in the mirror at ${root}`);

const SKIP = new Set(["PAPERS.md", "writing-style-math.md", "PROPOSALS.md"]);
const title = (t: string) => (/^#\s+(.+)$/m.exec(t)?.[1] ?? "").replace(/\s*\(draft note\)\s*$/i, "").trim();
const summary = (t: string) => {
  const abs = /##\s*Abstract\s*\n+([\s\S]*?)(?:\n##|\n\*\*|$)/i.exec(t)?.[1];
  const para = (abs ?? t.replace(/^#\s+.+$/m, "").replace(/^\*[^\n]*\*\s*$/m, "")).split(/\n\s*\n/).map((x) => x.replace(/\s+/g, " ").trim()).find((x) => x.length > 80 && !/^status:/i.test(x) && !/^\*\*status/i.test(x)) ?? "";
  return para.slice(0, 700);
};
const grade = (t: string) => { const m = /^\*\*Status:\s*([^*]+)\*\*/im.exec(t) ?? /^status:\s*(.+)$/im.exec(t); if (!m) return null; const g = m[1].replace(/\s+/g, " ").trim(); const first = /^(.+?[.;])\s/.exec(g)?.[1] ?? g; return (first.length > 160 ? first.slice(0, 157).replace(/\s+\S*$/, "") + "…" : first); };
const registryGrades: Record<string, string> = {};
const reg = existsSync(join(root, "proposals", "PROPOSALS.md")) ? readFileSync(join(root, "proposals", "PROPOSALS.md"), "utf8") : "";
for (const m of reg.matchAll(/\|\s*\[([^\]]+\.md)\]\([^)]+\)\s*\|\s*([^|]+?)\s*\|/g)) registryGrades[m[1]] = m[2].replace(/\s+/g, " ").trim().slice(0, 200);

let seeded = 0, jobs = 0;
// Proposals first, drafts last: a draft is the document of record and overwrites the wrapper proposal with the same slug.
const entries: Array<{ file: string; path: string; kind: "draft" | "proposal" }> = [];
const pdir = join(root, "proposals");
if (existsSync(pdir)) for (const f of readdirSync(pdir).sort()) if (f.endsWith(".md") && !SKIP.has(f) && f.startsWith("prop-")) entries.push({ file: f, path: `paper/proposals/${f}`, kind: "proposal" });
for (const f of readdirSync(root).sort()) if (f.endsWith(".md") && !SKIP.has(f)) entries.push({ file: f, path: `paper/${f}`, kind: "draft" });

for (const e of entries) {
  const text = readFileSync(join(REPOS, slug, e.path), "utf8");
  const t = title(text); if (!t) continue;
  const pslug = e.file.replace(/\.md$/, "").replace(/^prop-/, "");
  const g = e.kind === "proposal" ? (registryGrades[e.file] ?? grade(text)) : grade(text);
  const existing = await one(`SELECT id, status FROM papers WHERE problem_id = $1 AND slug = $2`, [p.id, pslug]);
  if (existing) await q(`UPDATE papers SET title = $3, path = $4, kind = $5, grade = $6, summary = $7, status = CASE WHEN status = 'proposed' AND $5 = 'draft' THEN 'draft' ELSE status END WHERE problem_id = $1 AND slug = $2`, [p.id, pslug, t, e.path, e.kind, g, summary(text)]);
  else { await q(`INSERT INTO papers (problem_id, slug, title, path, kind, status, grade, summary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [p.id, pslug, t, e.path, e.kind, e.kind === "proposal" ? "proposed" : "draft", g, summary(text)]); seeded++; }
  const open = await one(`SELECT 1 FROM jobs WHERE problem_id = $1 AND type = 'paper' AND status IN ('queued','assigned') AND brief_md LIKE '%paper.slug: ' || $2 || '%'`, [p.id, pslug]);
  if (open) continue;
  const write = e.kind === "proposal";
  const brief = `paper.slug: ${pslug}\n\n${write
    ? `Write the paper this proposal describes. Read \`${e.path}\` (the proposal, with its grade, records and triggers), then \`paper/PAPERS.md\` (positioning, authorship and AI-disclosure block) and \`paper/writing-style-math.md\` (the house style: claim exactly what is proven, calibration is grammar). Every result the paper states must point at the research note or script that carries it, at the calibration that note states; the prior-art position must be the registry's, not a hopeful one.`
    : `Bring this draft to referee-ready. Read \`${e.path}\` in full, then \`paper/PAPERS.md\` and \`paper/writing-style-math.md\`. Check every theorem, lemma and measured claim against the research note or script it cites, at the calibration that source states; verify every citation at the page or mark it unverified; make the abstract claim nothing the body does not carry; keep the authorship and AI-disclosure block. Fix what you can fix; where a claim cannot be supported at its stated calibration, lower the calibration in the text and say why in your report.`}

Return the complete manuscript as one uploaded Markdown file (LaTeX math allowed), plus your report: what changed, what you verified and how, what you could not verify, and the calibration of every headline claim. In the return set \`"paper": { "slug": "${pslug}", "file": "<sha256 of the manuscript>" }\`. Reviewers will write referee reports; an accepted revision becomes the paper's current version at /projects/${slug}/papers/${pslug}.`;
  await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum) VALUES ($1,NULL,'paper',$2,$3,'main','{}',4,1,1)`,
    [p.id, `${write ? "Paper: write" : "Paper: referee-ready revision of"} "${t}"`.slice(0, 200), brief]);
  jobs++;
}
console.log(JSON.stringify({ slug, papers: entries.length, seeded, jobs_queued: jobs }));
process.exit(0);
