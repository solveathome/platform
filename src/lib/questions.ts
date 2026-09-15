/** The project's open questions, read from the mirror's research/QUESTIONS.md (a table with `Q-id` question | status | ...). Human-curated work the server can hand out when the typed queue is empty. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.js";

const REPOS = process.env.DOCS_DIR ?? join(ROOT, "data", "repos");
export type Question = { id: string; text: string; status: string; verdict: string; item: string };
let cache: { key: string; at: number; list: Question[] } | null = null;

/**
 * The cells of a Markdown table row. A bar with a backslash in front of it is content, not a separator: the questions in this
 * table are mathematics, and `\|K\|/mass` and `sum \|G_L G_R\|=O(x)` are absolute values (platform issue #68). Splitting on
 * every bar dropped three questions from the table outright and cut seven verdicts short of the 300 characters they are
 * allowed, which took an open question out of the lead schedule and gave agents an estimate without its caveat.
 */
export function cells(line: string): string[] {
  const out: string[] = []; let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && line[i + 1] === "|") { cur += "|"; i++; continue; }   // an escaped bar is one character of content
    if (c === "|") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

export function questions(slug: string): Question[] {
  const file = join(REPOS, slug, "research", "QUESTIONS.md");
  if (!existsSync(file)) return [];
  const key = `${slug}:${statSync(file).mtimeMs}`;
  if (cache && cache.key === key) return cache.list;
  const seen = new Set<string>(); const list: Question[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const c = cells(line);
    if (c.length < 6) continue;                                   // item, question, status, verdict, and the bars around them
    const m = /^`(Q-[A-Za-z0-9_-]+)`\s*([\s\S]*)$/.exec(c[2].trim());
    const status = c[3].trim();
    if (!m || !/^[A-Z][A-Z -]*$/.test(status) || seen.has(m[1])) continue; seen.add(m[1]);
    list.push({ item: c[1].trim(), id: m[1], text: m[2].trim(), status, verdict: c[4].trim().slice(0, 300) });
  }
  const rank = (s: string) => s === "OPEN" ? 0 : s === "PARTIAL" ? 1 : 2;
  list.sort((a, b) => rank(a.status) - rank(b.status));
  cache = { key, at: Date.now(), list };
  return list;
}
export function openQuestions(slug: string, n = 5): Question[] { return questions(slug).filter((q) => q.status === "OPEN" || q.status === "PARTIAL").slice(0, n); }

/**
 * The slice of the open-and-partial list a registry sweep asks for. The cursor wraps, the window does not run past the end
 * (platform issue #61: three sweeps advanced 23-37, 38-52, then asked for 53-67 of a list with 53 rows, and every lane's
 * template carries the same counter, so an exhausted backlog kept dispatching empty sweeps).
 */
export function sweepWindow(index: number, rows: number, size = 15): { from: number; take: number } {
  if (!(rows > 0) || !(size > 0)) return { from: 1, take: 0 };
  const from = ((Math.max(0, Math.floor(index)) * size) % rows) + 1;
  return { from, take: Math.min(size, rows - from + 1) };
}
