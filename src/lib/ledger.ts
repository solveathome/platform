/**
 * Ledger blocks (issue #48, Chris, Sep 11 2026). In a project whose notes carry a generated-registry block (twin-primes: a `<!-- ledger … -->`
 * comment at the top of a note feeds its research/QUESTIONS.md row), a patch that sharpens a result but leaves the block alone leaves the
 * registry stale on integration. The rule comes from projects/<slug>/project.json `ledger`; the server reads text and line ranges, runs nothing.
 */
import { currentText } from "./revisions.js";
import { readProjectConfig } from "./projects.js";

export type LedgerRule = { start: string; end: string; registry?: string };

/** 1-based line range of the first block opened by `rule.start` and closed by `rule.end`, or null. */
export function ledgerRange(text: string, rule: LedgerRule): { start: number; end: number } | null {
  const lines = String(text ?? "").split("\n"); let s = -1;
  for (let i = 0; i < lines.length; i++) {
    if (s < 0) { if (lines[i].trimStart().startsWith(rule.start)) s = i; }
    else if (lines[i].trim().startsWith(rule.end)) return { start: s + 1, end: i + 1 };
  }
  return null;
}

/** The files a unified diff touches and, per file, the old-side line ranges of its hunks. */
export function parsePatch(patch: string): Map<string, Array<{ start: number; end: number }>> {
  const out = new Map<string, Array<{ start: number; end: number }>>(); let cur: string | null = null;
  for (const line of String(patch ?? "").split("\n")) {
    const f = /^\+\+\+ (?:[ab]\/)?(\S+)/.exec(line);
    if (f) { cur = f[1] === "/dev/null" ? null : f[1]; if (cur && !out.has(cur)) out.set(cur, []); continue; }
    const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (h && cur) { const a = Number(h[1]), n = h[2] === undefined ? 1 : Number(h[2]); out.get(cur)!.push({ start: a, end: a + Math.max(n, 1) - 1 }); }
  }
  return out;
}

/** Warnings for a patch, or an audit revision, that changes a ledger-bearing document without touching its block. Empty when the project has no rule. */
export async function ledgerWarnings(slug: string, patch: string | null, revision: { path: string; text: string } | null): Promise<string[]> {
  const rule = readProjectConfig(slug)?.ledger; if (!rule?.start || !rule?.end) return [];
  const registry = rule.registry ?? "registry"; const out: string[] = [];
  const served = async (rel: string) => { try { return (await currentText(slug, rel))?.text ?? null; } catch { return null; } };
  if (patch) for (const [path, hunks] of parsePatch(patch)) {
    const text = await served(path); if (!text) continue;
    const range = ledgerRange(text, rule); if (!range) continue;
    if (!hunks.some((h) => h.end >= range.start && h.start <= range.end))
      out.push(`${path}: its ledger block (lines ${range.start}–${range.end}) is the source of its ${registry} row, and the patch does not change it. If the result changes the verdict, status or todo, the patch should.`);
  }
  if (revision?.path && revision.text) {
    const text = await served(revision.path);
    if (text && text !== revision.text) {
      const r1 = ledgerRange(text, rule), r2 = ledgerRange(revision.text, rule);
      if (r1 && r2 && text.split("\n").slice(r1.start - 1, r1.end).join("\n") === revision.text.split("\n").slice(r2.start - 1, r2.end).join("\n"))
        out.push(`${revision.path}: the revision leaves its ledger block (lines ${r1.start}–${r1.end}) unchanged; that block is the source of its ${registry} row. If the revision changes the verdict, status or todo, the block should say so.`);
    }
  }
  return out;
}
