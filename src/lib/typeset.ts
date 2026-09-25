/**
 * Typesetting jobs for manuscripts whose math is plain text (Chris, Sep 22 2026, on beta2-note: "if this is an issue of writing, let's make it
 * an agent job to clean those up"). Only $…$, $$…$$, \(…\) and \[…\] are typeset; bare ^{…}/_{…} shows as text. One 'paper' job per paper,
 * keyed typeset:<slug>; none while a paper or audit job on the paper is open or a typesetting return is under review. Run by import-papers.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { q, one } from "../db/index.js";
import { plainMathLines } from "./math.js";
import * as files from "./files.js";
import { REPOS, OVERLAY } from "./revisions.js";

export const typesetBrief = (slug: string, pslug: string, t: string, lines: number[]): string => `paper.slug: ${pslug}\n\nTypeset the mathematics of "${t}" in TeX. Take the current manuscript from \`GET /projects/${slug}/papers/${pslug}\` (JSON, \`manuscript_md\`). It writes math as plain text, with bare ^{…} and _{…} on line${lines.length > 1 ? "s" : ""} ${lines.slice(0, 20).join(", ")}${lines.length > 20 ? " and " + (lines.length - 20) + " more" : ""}. The site typesets only $…$, $$…$$, \\(…\\) and \\[…\\], so those formulas show as raw text.

Change the notation and nothing else: put each inline formula in $…$ and each formula set apart on its own indented lines in a $$…$$ block; write sub- and superscripts, Greek letters and operators inside a formula in TeX (\`p_n^{\\beta_2+\\varepsilon}\`, \`\\sum_{m \\mid P(z)}\`, \`\\ll_\\varepsilon\`). Leave every word, number, claim, citation, heading, link, code span and file path as it is, and write a literal dollar as \`\\$\`. A defect you notice in the content goes in your report, not into this revision. If another revision of this paper is under review, start from the current version all the same and name that return in your report.

Return the complete manuscript as one uploaded Markdown file with \`"paper": { "slug": "${pslug}", "file": "<sha256 of the manuscript>" }\`, and upload a diff against the version you started from (name its sha256 in the report), so a reviewer can check that only notation changed and that the page at /projects/${slug}/papers/${pslug} renders every formula.`;

/** The manuscript a paper page shows: the accepted file, else the overlay's integrated edition, else the mirror's. */
function currentManuscript(slug: string, r: { path: string | null; current_file_sha: string | null }): string | null {
  if (r.current_file_sha) return files.read(r.current_file_sha);
  for (const root of [OVERLAY, REPOS]) { const abs = r.path ? join(root, slug, r.path) : null; if (abs && existsSync(abs)) return readFileSync(abs, "utf8"); }
  return null;
}

export async function queueTypesetJobs(problemId: number, slug: string): Promise<number> {
  let n = 0;
  for (const r of await q<{ slug: string; title: string; path: string | null; current_file_sha: string | null }>(`SELECT slug, title, path, current_file_sha FROM papers WHERE problem_id = $1 ORDER BY id`, [problemId])) {
    const text = currentManuscript(slug, r);
    const lines = text === null ? [] : plainMathLines(text);
    if (!lines.length) continue;
    const key = `typeset:${r.slug}`;
    const busy = await one(`SELECT 1 FROM jobs j WHERE j.problem_id = $1 AND ((j.type IN ('paper','audit') AND j.status IN ('queued','assigned') AND j.brief_md LIKE 'paper.slug: ' || $2 || '%')
      OR (j.origin_key = $3 AND EXISTS (SELECT 1 FROM returns x WHERE x.job_id = j.id AND x.status = 'pending')))`, [problemId, r.slug, key]);
    if (busy) continue;
    await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, origin_key) VALUES ($1,NULL,'paper',$2,$3,'main','{}',1,2,1,$4)`,
      [problemId, `Typeset the math of "${r.title}"`.slice(0, 200), typesetBrief(slug, r.slug, r.title, lines), key]);
    n++;
  }
  return n;
}
