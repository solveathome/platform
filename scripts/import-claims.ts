/**
 * Provenance import (scope Q41). Reads a research repo checkout, parses <!-- ledger --> headers in research/*.md and
 * title lines in research/*.js, takes first/last commit dates and authorship from git, and upserts claims via the
 * owner endpoint. Origin is credited by handle and never scored.
 *
 * Usage: SAH_TOKEN=... SAH_BASE=https://dev.solveathome.org tsx scripts/import-claims.ts <path-to-research-repo> twin-primes Benjaminsen
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [repo, slug = "twin-primes", origin = "Benjaminsen"] = process.argv.slice(2);
import { existsSync } from "node:fs";
const provPath = join(process.cwd(), "projects", slug, "provenance.json");
const prov = existsSync(provPath) ? JSON.parse(readFileSync(provPath, "utf8")) : { models: {}, recorded_submissions: {} };
const astraHashes = new Set(Object.keys(prov.models?.["gpt-6-astra"]?.commits ?? {}));
const submissionHashes = new Set(Object.keys(prov.recorded_submissions ?? {}));
if (!repo) throw new Error("repo path required");
const base = process.env.SAH_BASE ?? "http://localhost:8600";
const token = process.env.SAH_TOKEN;
if (!token) throw new Error("SAH_TOKEN required (owner token)");

const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const rootCommit = git(["rev-list", "--max-parents=0", "HEAD"]).split("\n")[0];
/** Per file: dates, commit count, whether it was born in the root commit (pre-repo corpus), and how many commits carry an agent session marker. */
const history = (p: string) => {
  const lines = git(["log", "--follow", "--format=%H|%ad|%(trailers:key=Claude-Session,valueonly)|%B%x00", "--date=short", "--", p]).split("\0").map((l) => l.trim()).filter(Boolean);
  const dates = lines.map((l) => l.split("|")[1]).filter(Boolean);
  const hashes = lines.map((l) => l.split("|")[0]);
  // claude = marker or Chris's statement; claude-marked = the subset with a session marker (evidence in the log itself)
  const model_commits: Record<string, number> = { "claude": 0, "claude-marked": 0, "gpt-6-astra": 0, "claude-dispatched": 0 };
  for (const l of lines) {
    const h = l.split("|")[0];
    if ([...astraHashes].some((a) => h.startsWith(a))) model_commits["gpt-6-astra"]++;
    else if ([...submissionHashes].some((a) => h.startsWith(a))) { model_commits["claude-dispatched"]++; model_commits["claude"]++; }
    else { model_commits["claude"]++; if (/claude-session|generated with claude|co-authored-by: claude/i.test(l)) model_commits["claude-marked"]++; }
  }
  return { first: dates.at(-1) ?? null, last: dates[0] ?? null, commits: lines.length, corpus: hashes.includes(rootCommit), session_commits: model_commits["claude"], model_commits };
};
const dates = history;

const claims: any[] = [];
const dir = join(repo, "research");
for (const f of readdirSync(dir).sort()) {
  const p = `research/${f}`;
  if (f.endsWith(".md")) {
    const src = readFileSync(join(dir, f), "utf8");
    const m = /<!--\s*ledger\n([\s\S]*?)-->/.exec(src);
    if (!m) continue;
    const meta: Record<string, string> = {};
    for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    if (!meta.id) continue;
    claims.push({ ledger_id: meta.id, path: p, kind: "note", status: (meta.status ?? "UNKNOWN").toUpperCase(), question: meta.question ?? "", verdict: (meta.verdict ?? "").slice(0, 2000), ...dates(p) });
  } else if (f.endsWith(".js")) {
    const head = readFileSync(join(dir, f), "utf8").split("\n").slice(0, 6);
    const title = head.map((l) => l.replace(/^\/\/\s?/, "").trim()).find((l) => l && !/^=+$/.test(l)) ?? f;
    claims.push({ ledger_id: f, path: p, kind: "script", status: "SCRIPT", question: title.slice(0, 300), verdict: "", ...dates(p) });
  }
}
const r = await fetch(`${base}/projects/${slug}/claims`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({
    origin_handle: origin,
    origin_role: "direction, review, prior corpus (2020-2026 independent experiments)",
    origin_model: "claude (Fable or Opus) and gpt-6-astra; per commit, see projects/<slug>/provenance.json",
    origin_model_role: "writing, computation, validators, dispatch rounds",
    origin_note: `All ${git(["rev-list", "--count", "HEAD"])} commits were made through agent sessions (Claude Code and Codex) directed by @${origin}; ${git(["log", "--format=%B"]).split("\n").filter((l) => /claude-session/i.test(l)).length} carry a Claude session marker; none carry a co-author trailer and no commit names a model. ${astraHashes.size} commits are GPT-6 Astra's, from a Codex transcript. Everything else is Claude (Fable or Opus): 38 commits by their session marker, the rest by @${origin}'s statement of 2026-09-09. The human/agent split is by role, not by line. Credited, not scored.`,
    claims }) });
console.log(r.status, (await r.text()).slice(0, 300));
