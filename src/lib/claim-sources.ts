/**
 * Claim-to-source map (Oct 16 2026, Sakana lesson #3): every theorem, number and table in a paper names the return, receipt, Lean
 * package, file or reference it comes from. The author writes the map as a "Claim sources" table in the manuscript itself, so a reader
 * sees it too; this module finds the claims in the text, reads the map, and says which claims have no source and which named sources do
 * not exist. It never refuses a manuscript: intake warns the author, the referee brief carries the list, the paper page shows it, and
 * the integrity inventory counts it. A missing source is a correction someone can make later, never a hold.
 *
 * What counts as a claim, kept narrow so a flag is worth reading:
 *   - a labelled result: a bold or heading Theorem / Lemma / Proposition / Corollary (one per label);
 *   - a table with a number in it, outside the map and the references;
 *   - a prose number with three or more decimals, or seven or more digits (results, not section numbers or years).
 * A number inside a mapped theorem's block or a mapped table is covered by that row. Fenced code is output, not prose, and is skipped.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { q } from "../db/index.js";
import { mirrorPath, overlayPath, safeRel, docsRoot, OVERLAY } from "./revisions.js";
import { referenceKeys } from "./citations.js";

export type ClaimKind = "theorem" | "table" | "number";
export type SourceRef = { kind: "return" | "receipt" | "job" | "lean" | "file" | "reference" | "internal"; id: string };
export type Claim = { kind: ClaimKind; label: string; line: number; mapped: boolean; source?: string; flag?: string };
export type MapRow = { claim: string; source: string; line: number; refs: SourceRef[] };
export type ClaimCheck = { has_map: boolean; map_line: number | null; claims: Claim[]; rows: MapRow[]; counts: { claims: number; mapped: number; unmapped: number; bad_source: number }; flags: string[] };
export type SourceContext = {
  returnStatus: (id: number) => Promise<string | null>;   // 'accepted' | 'pending' | 'rejected' | … ; null when no such return in the project
  receiptExists: (id: number) => Promise<boolean>;
  jobExists: (id: number) => Promise<boolean>;
  fileExists: (path: string) => Promise<boolean>;
};

export const MAP_HEADING = /^#{1,6}\s+(?:[A-Z0-9]+[.)]\s+)*(?:appendix\s+[a-z0-9]+[.:]?\s+)?(claim[- ]?(?:to[- ]?)?sources?(?: map)?|claim map|source map|provenance of (?:every|each) (?:number|claim|result))\b/i;
const REF_HEADING = /^#{1,6}\s+.*\b(references?|bibliography)\b/i;
const LABEL = /(?:^#{1,6}\s+(?:[\d.]+\s+)?|\*\*|\\textbf\{)\s*(Theorem|Lemma|Proposition|Corollary)\s*([A-Z]?\d+(?:\.\d+)*[a-z]?|[A-Z]\b|[A-Z]′?)/;
const LABEL_TEXT = /^\s*(Theorem|Lemma|Proposition|Corollary)\s*\S+/;
const ABBR: Record<string, string> = { thm: "Theorem", lem: "Lemma", prop: "Proposition", cor: "Corollary" };
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const digits = (s: string) => s.replace(/[,\s ]/g, "");
/** Text with the parts that are identifiers, not results, taken out: code, links' targets, DOIs, arXiv ids, hashes, return numbers. */
function prose(line: string): string {
  return line.replace(/`[^`]*`/g, " ").replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, " ").replace(/\b10\.\d{4,9}\/\S+/g, " ")
    .replace(/arXiv[:\s]*\d{4}\.\d{4,5}(v\d+)?/gi, " ").replace(/\b\d{4}\.\d{4,5}(v\d+)\b/g, " ").replace(/\b[0-9a-f]{12,}\b/gi, " ").replace(/#\d+/g, " ").replace(/\b(?:19|20)\d\d-\d\d-\d\d\b/g, " ");
}
const TOKEN = /(?<![\w.,])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\w]|\.\d)/g;
/** The same value, one of them written to fewer decimals (at least two). */
export function sameNumber(a: string, b: string): boolean {
  if (a === b) return true;
  const da = (a.split(".")[1] ?? "").length, db = (b.split(".")[1] ?? "").length, d = Math.min(da, db);
  if (d < 2 || da === db) return false;
  const [lo, hi] = da < db ? [a, b] : [b, a];
  return Math.abs(Number(hi) - Number(lo)) <= 0.5 * 10 ** -d + 1e-12;
}
const NUMBER = /(?<![\w.,])(\d{1,3}(?:,\d{3}){2,}(?:\.\d+)?|\d+\.\d{3,}|\d{7,})(?![\w]|\.\d)/g;

/** The sources a map cell names. Plain words ("elementary", "§3", "proved here") point inside the paper itself. */
export function parseSources(cell: string): SourceRef[] {
  const out: SourceRef[] = [], seen = new Set<string>();
  const add = (kind: SourceRef["kind"], id: string) => { const k = `${kind}:${id}`; if (!seen.has(k)) { seen.add(k); out.push({ kind, id }); } };
  for (const m of cell.matchAll(/\b(returns?|receipts?|jobs?)\s*#?\s*(\d+(?:\s*(?:,|and|&)\s*#?\s*\d+)*)/gi)) {
    const kind = m[1].toLowerCase().replace(/s$/, "") as "return" | "receipt" | "job";
    for (const n of m[2].match(/\d+/g) ?? []) add(kind, n);
  }
  for (const m of cell.matchAll(/\/(return|job)\/(\d+)\b/g)) add(m[1] as "return" | "job", m[2]);
  for (const m of cell.matchAll(/[\w./-]+\.lean\b/g)) add("lean", m[0]);
  for (const m of cell.matchAll(/\bLean (?:package|proof|theorem|module)\s+`?([\w.'-]+)`?/gi)) add("lean", m[1]);
  for (const m of cell.matchAll(/`?((?:[\w.-]+\/)*[\w.-]+\.(?:md|py|js|mjs|ts|txt|json|csv|tsv|c|cc|cpp|h|rs|jl|sage|gp|out|log|html|tex|sh|go|hs|m|wl|ipynb))`?/g)) add("file", m[1]);
  for (const m of cell.matchAll(/\[([A-Z][A-Za-z0-9+–-]{0,15})(?:[,;\s][^\]]*)?\]/g)) if (!/^(RECORD|MEMORY)$/.test(m[1])) add("reference", m[1]);
  if (/§\s*\d|\bsections?\s+\d|\bprov(?:ed|en) (?:here|above|below|in)\b|\bthis (?:paper|note|manuscript)\b|\belementary\b|\bby definition\b|\b(?:see )?(?:theorem|lemma|proposition|corollary|equation|eq\.)\s*\(?\d/i.test(cell.replace(/\[[^\]]*\]/g, " "))) add("internal", "this paper");
  return out;
}

type Block = { kind: "theorem"; label: string; header: string; start: number; end: number } | { kind: "table"; label: string; ordinal: number; caption: number | null; start: number; end: number; sourceColumn: boolean; numeric: boolean; nums: string[] };

/** Claims, map rows and the line ranges they span. Pure: tests and the report read it without a database. */
export function parseClaims(md: string): { claims: Claim[]; rows: MapRow[]; blocks: Block[]; mapLine: number | null; numbers: Array<{ value: string; line: number }> } {
  const lines = md.split("\n");
  const blocks: Block[] = [], rows: MapRow[] = [], numbers: Array<{ value: string; line: number }> = [];
  let fence = false, section: "body" | "map" | "refs" = "body", mapLine: number | null = null, mapLevel = 0, refLevel = 0, ordinal = 0;
  const labels = new Set<string>();
  let open: Extract<Block, { kind: "theorem" }> | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], n = i + 1;
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^(#{1,6})\s/.exec(line);
    if (h) {
      const level = h[1].length;
      if (open) { open.end = n - 1; open = null; }
      if (MAP_HEADING.test(line)) { section = "map"; mapLine ??= n; mapLevel = level; }
      else if (REF_HEADING.test(line)) { section = "refs"; refLevel = level; }
      else if ((section === "map" && level <= mapLevel) || (section === "refs" && level <= refLevel)) section = "body";
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && !(i > 0 && TABLE_ROW.test(lines[i - 1]))) {
      let end = i + 2; while (end < lines.length && TABLE_ROW.test(lines[end])) end++;
      const header = cells(line).map((c) => c.toLowerCase().replace(/[*_`]/g, ""));
      if (section === "map") {
        // The claim is the first column; the source is the column so named, else every other column.
        const named = header.findIndex((c, k) => k > 0 && /source|provenance|evidence|from|carried by/.test(c));
        for (let r = i + 2; r < end; r++) { const c = cells(lines[r]); const source = named > 0 ? (c[named] ?? "") : c.slice(1).join(" | "); rows.push({ claim: c[0] ?? "", source, line: r + 1, refs: parseSources(source) }); }
      } else if (section === "body") {
        ordinal++;
        const around = [lines[i - 2], lines[i - 1], lines[end], lines[end + 1]].filter(Boolean).join(" ");
        const cap = /\*{0,2}Table\s+(\d+)/i.exec(around);
        // A label (Theorem 2, §3, (2.1), [KK]) is not a number the table claims.
        const data = lines.slice(i + 2, end).map((r) => prose(r).replace(/\b(?:Theorem|Lemma|Proposition|Corollary|Table|Section|Appendix|Step|Q)\s*[A-Z]?\d+(?:\.\d+)*|§\s*[\d.]+|\(\d+(?:\.\d+)*[a-z]?\)|\[[^\]]*\]/gi, " ")).join(" ");
        const nums = [...new Set([...data.matchAll(TOKEN)].map((m) => m[1]).filter((v) => digits(v).replace(".", "").length >= 2))];
        const sourceColumn = header.some((c) => /^(source|provenance|evidence|from|receipt|return)s?$/.test(c)) && lines.slice(i + 2, end).every((r) => { const c = cells(r); const k = header.findIndex((x) => /^(source|provenance|evidence|from|receipt|return)s?$/.test(x)); return parseSources(c[k] ?? "").some((s) => s.kind !== "internal"); });
        blocks.push({ kind: "table", label: cap ? `Table ${cap[1]}` : `The table on line ${n}`, ordinal, caption: cap ? Number(cap[1]) : null, start: n, end, sourceColumn, numeric: nums.length > 0, nums });
      }
      i = end - 1; continue;
    }
    if (section !== "body") continue;
    const lm = LABEL.exec(line);
    if (lm && !/^\s*>?\s*\*\*(?:Theorem|Lemma|Proposition|Corollary)\s*[^*]*\*\*\s*(?:is|was|in|of|from|gives|shows|above|below)\b/i.test(line)) {
      const label = `${lm[1]} ${lm[2]}`;
      if (!labels.has(label)) { labels.add(label); if (open) open.end = n - 1; open = { kind: "theorem", label, header: (/\*\*([^*]+)\*\*/.exec(line)?.[1] ?? line.replace(/^#+\s*/, "")).replace(LABEL_TEXT, ""), start: n, end: lines.length }; blocks.push(open); }
      else if (open) { open.end = n - 1; open = null; }
    }
    for (const m of prose(line).matchAll(NUMBER)) { const v = m[1]; if (/^(19|20)\d\d$/.test(v)) continue; numbers.push({ value: v, line: n }); }
  }
  if (open) open.end = lines.length;
  return { claims: [], rows, blocks, mapLine, numbers };
}

const labelIn = (label: string, text: string) => {
  const [kind, num] = label.split(" ");
  const t = text.replace(/\b(Thm|Lem|Prop|Cor)\b\.?(?=\s*[A-Z\d])/gi, (a) => ABBR[a.replace(".", "").toLowerCase()] ?? a);
  return new RegExp(`\\b${kind}s?\\s*${num.replace(/[.′]/g, (c) => `\\${c}`)}(?![\\d.]*\\d)`, "i").test(t);
};

/** The map check on one manuscript. Sources are looked up through ctx, so the same check runs against the database or a test fixture. */
export async function checkClaimSources(md: string, ctx: SourceContext): Promise<ClaimCheck> {
  const { rows, blocks, mapLine, numbers } = parseClaims(md);
  const keys = new Set(referenceKeys(md));
  const bad = new Map<number, string>();   // map row line -> what is wrong with its source
  const statusCache = new Map<number, string | null>();
  const judge = async (row: MapRow) => {
    const real = row.refs.filter((r) => r.kind !== "internal");
    if (!row.refs.length) { bad.set(row.line, "row names no return, receipt, Lean package, file or reference"); return; }
    const problems: string[] = [];
    for (const r of real) {
      if (r.kind === "return") { const id = Number(r.id); if (!statusCache.has(id)) statusCache.set(id, await ctx.returnStatus(id)); const s = statusCache.get(id); if (s === null) problems.push(`return #${id} does not exist in this project`); else if (s === "rejected") problems.push(`return #${id} was rejected, so it cannot carry a claim`); }
      else if (r.kind === "receipt" && !(await ctx.receiptExists(Number(r.id)))) problems.push(`receipt #${r.id} does not exist`);
      else if (r.kind === "job" && !(await ctx.jobExists(Number(r.id)))) problems.push(`job #${r.id} does not exist in this project`);
      else if (r.kind === "reference" && keys.size && !keys.has(r.id)) problems.push(`[${r.id}] is not in the reference list`);
      else if (r.kind === "file" && !real.some((x) => x.kind === "return" || x.kind === "receipt") && !(await ctx.fileExists(r.id))) problems.push(`the file \`${r.id}\` is not among the project's files (name the return that uploaded it)`);
    }
    if (problems.length && problems.length === real.length) bad.set(row.line, problems.join("; "));
  };
  for (const row of rows) if (row.claim) await judge(row);
  const rowFor = (b: Block) => rows.find((r) => b.kind === "theorem" ? labelIn(b.label, r.claim) : (/\btables?\b/i.test(r.claim) && (b.caption !== null ? labelIn(`Table ${b.caption}`, r.claim) : labelIn(`Table ${b.ordinal}`, r.claim))) || (b.kind === "table" && r.claim.includes(`line ${b.start}`)));
  // Every number a map row's claim cell names; a value matches the same number written to fewer decimals (1.9816 for 1.98156).
  const mapNums: Array<{ v: string; row: MapRow }> = [];
  for (const r of rows) for (const m of prose(r.claim).matchAll(TOKEN)) mapNums.push({ v: digits(m[1]), row: r });
  const findRow = (value: string) => { const v = digits(value); return (mapNums.find((x) => x.v === v) ?? mapNums.find((x) => sameNumber(x.v, v)))?.row; };
  const claims: Claim[] = [];
  const covered: Array<[number, number]> = [];
  for (const b of blocks) {
    if (b.kind === "table" && !b.numeric) continue;
    if (b.kind === "table" && b.sourceColumn) { claims.push({ kind: "table", label: b.label, line: b.start, mapped: true, source: "its own source column" }); covered.push([b.start, b.end]); continue; }
    let row = rowFor(b);
    let partial: string | undefined;
    // A result may name its source in its own heading, "**Theorem 2 (proven; `research/x.md` §4).**": that is its row.
    if (!row && b.kind === "theorem") { const refs = parseSources(b.header); if (refs.length) { row = { claim: b.label, source: b.header.trim(), line: b.start, refs }; await judge(row); } }
    if (!row && b.kind === "table") {
      // No row names the table, but its numbers may each have one: the table is mapped when all of them do.
      const missing = b.nums.filter((v) => !findRow(v));
      if (!missing.length) row = findRow(b.nums[0]);
      else if (missing.length < b.nums.length) partial = `${b.nums.length - missing.length} of its ${b.nums.length} numbers are in the Claim sources table; ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ` and ${missing.length - 6} more` : ""} ${missing.length === 1 ? "is" : "are"} not`;
    }
    const internalOnly = row && row.refs.length > 0 && row.refs.every((r) => r.kind === "internal");
    const at = b.label.includes(" on line ") ? b.label : `${b.label} (line ${b.start})`;
    const flag = !row ? (partial ? `${at}: ${partial}.` : `${at} has no row in the Claim sources table.`)
      : bad.has(row.line) ? `${at}: its ${bad.get(row.line)!.startsWith("row ") ? "" : "source "}${bad.get(row.line)}.`
      : internalOnly && b.kind === "table" ? `${at} points only inside this paper; name the return or file that computed it.`
      : undefined;
    claims.push({ kind: b.kind, label: b.label, line: b.start, mapped: !flag, ...(row ? { source: row.source } : {}), ...(flag ? { flag } : {}) });
    if (!flag) covered.push([b.start, b.end]);
  }
  // A value whose source is named where it is derived (a mapped theorem or table) is mapped wherever else it is quoted.
  const coveredValues = new Set(numbers.filter((x) => covered.some(([a, z]) => x.line >= a && x.line <= z)).map((x) => digits(x.value)));
  for (const b of blocks) if (b.kind === "table" && covered.some(([a, z]) => a === b.start && z === b.end)) b.nums.forEach((v) => coveredValues.add(digits(v)));
  const seen = new Set<string>();
  for (const num of numbers) {
    const v = digits(num.value);
    if (seen.has(v)) continue;
    if (covered.some(([a, z]) => num.line >= a && num.line <= z)) continue;
    if (coveredValues.has(v)) continue;
    seen.add(v);
    const row = findRow(v);
    const internalOnly = row && row.refs.length > 0 && row.refs.every((r) => r.kind === "internal");
    const flag = !row ? `The number ${num.value} (line ${num.line}) has no row in the Claim sources table that names this value.`
      : bad.has(row.line) ? `The number ${num.value} (line ${num.line}): its ${bad.get(row.line)!.startsWith("row ") ? "" : "source "}${bad.get(row.line)}.`
      : internalOnly ? `The number ${num.value} (line ${num.line}) points only inside this paper; name the return or file that computed it.` : undefined;
    claims.push({ kind: "number", label: num.value, line: num.line, mapped: !flag, ...(row ? { source: row.source } : {}), ...(flag ? { flag } : {}) });
  }
  claims.sort((a, b) => a.line - b.line);
  const unmapped = claims.filter((c) => !c.mapped);
  const flags = mapLine === null && claims.length
    ? [`This paper has no Claim sources table, so none of its ${claims.length} claims names its source. Add a "## Claim sources" table with one row per theorem, table and result number, naming the return, receipt, Lean package, file or reference each comes from.`, ...unmapped.map((c) => c.flag!)]
    : unmapped.map((c) => c.flag!);
  return { has_map: mapLine !== null, map_line: mapLine, claims, rows, counts: { claims: claims.length, mapped: claims.length - unmapped.length, unmapped: unmapped.length, bad_source: claims.filter((c) => c.flag && /: its (source|row) /.test(c.flag)).length }, flags };
}

/** Sources looked up in the project's own record: its returns, receipts, jobs and served files. */
export function dbSourceContext(problemId: number, slug: string): SourceContext {
  return {
    returnStatus: async (id) => (await q<{ status: string }>(`SELECT status FROM returns WHERE id = $1 AND problem_id = $2`, [id, problemId]))[0]?.status ?? null,
    receiptExists: async (id) => (await q(`SELECT 1 FROM verification_runs v JOIN returns r ON r.id = v.subject_return_id WHERE v.id = $1 AND r.problem_id = $2`, [id, problemId])).length > 0,
    jobExists: async (id) => (await q(`SELECT 1 FROM jobs WHERE id = $1 AND problem_id = $2`, [id, problemId])).length > 0,
    fileExists: async (path) => {
      const rel = safeRel(path.replace(/^\.?\//, "")); if (!rel) return false;
      if (existsSync(mirrorPath(slug, rel)) || existsSync(overlayPath(slug, rel))) return true;
      // A bare file name: any served document of this project with that name, or a file uploaded with one of its returns.
      if (basenames(slug).has(rel.split("/").pop()!)) return true;
      return (await q(`SELECT 1 FROM files f JOIN file_refs x ON x.file_sha = f.sha256 AND x.ref_type = 'return' JOIN returns r ON r.id = x.ref_id WHERE r.problem_id = $1 AND f.name = $2 LIMIT 1`, [problemId, rel.split("/").pop()])).length > 0;
    },
  };
}

// File names under the project's mirror and overlay, read once every ten minutes: a map row often names `script.py` without its folder.
const names = new Map<string, { at: number; set: Set<string> }>();
function basenames(slug: string): Set<string> {
  const hit = names.get(slug); if (hit && Date.now() - hit.at < 600_000) return hit.set;
  const set = new Set<string>();
  const walk = (dir: string, depth: number) => { if (depth > 8 || !existsSync(dir)) return; for (const e of readdirSync(dir, { withFileTypes: true })) { if (e.name.startsWith(".")) continue; if (e.isDirectory()) walk(join(dir, e.name), depth + 1); else set.add(e.name); } };
  walk(docsRoot(slug), 0); walk(join(OVERLAY, slug), 0);
  names.set(slug, { at: Date.now(), set });
  return set;
}
