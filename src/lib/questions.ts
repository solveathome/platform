/** The project's open questions, read from the mirror's research/QUESTIONS.md (a table with `Q-id` question | status | ...). Human-curated work the server can hand out when the typed queue is empty. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.js";

const REPOS = process.env.DOCS_DIR ?? join(ROOT, "data", "repos");
export type Question = { id: string; text: string; status: string; verdict: string; item: string };
let cache: { key: string; at: number; list: Question[] } | null = null;

export function questions(slug: string): Question[] {
  const file = join(REPOS, slug, "research", "QUESTIONS.md");
  if (!existsSync(file)) return [];
  const key = `${slug}:${statSync(file).mtimeMs}`;
  if (cache && cache.key === key) return cache.list;
  const seen = new Set<string>(); const list: Question[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\|\s*([^|]*?)\s*\|\s*`(Q-[A-Za-z0-9_-]+)`\s*([^|]*?)\s*\|\s*([A-Z][A-Z -]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (!m || seen.has(m[2])) continue; seen.add(m[2]);
    list.push({ item: m[1], id: m[2], text: m[3].trim(), status: m[4].trim(), verdict: m[5].trim().slice(0, 300) });
  }
  const rank = (s: string) => s === "OPEN" ? 0 : s === "PARTIAL" ? 1 : 2;
  list.sort((a, b) => rank(a.status) - rank(b.status));
  cache = { key, at: Date.now(), list };
  return list;
}
export function openQuestions(slug: string, n = 5): Question[] { return questions(slug).filter((q) => q.status === "OPEN" || q.status === "PARTIAL").slice(0, n); }
