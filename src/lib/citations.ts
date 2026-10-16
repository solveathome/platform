/**
 * Reference check (Oct 16 2026, Sakana lesson #4): before a referee reads a paper, every reference in it is looked up against the free
 * public indexes (Crossref for DOIs and bibliographic search, doi.org for DOIs registered elsewhere, arXiv's export API for arXiv ids),
 * and a reference that does not resolve, or whose identifier points to another work, is flagged. Invented references are the most
 * common failure of AI-written papers; this catches the checkable part of it. It never decides a reference is wrong on its own: a book
 * with no DOI is "not found", which asks for a check by hand, not a removal.
 *
 * The lookup is a validation of public bibliographic records, not literature search, and needs no key: Crossref is asked through its
 * polite pool (a mailto in the User-Agent), arXiv at one request every three seconds as its terms ask, and both back off on 429/503.
 * One lookup per distinct reference text is kept in citation_lookups, so an unchanged reference is never asked again; a network error
 * is retried after an hour. Nothing here blocks intake or review: results that are not in yet show as pending.
 */
import { createHash } from "node:crypto";
import { q } from "../db/index.js";

export type RefEntry = { key: string | null; text: string; line: number; inline: boolean; dois: string[]; arxiv: string[]; urls: string[]; title: string | null; years: number[] };
export type LookupStatus = "resolved" | "found" | "mismatch" | "unresolved" | "skipped" | "error";
export type Lookup = { status: LookupStatus; source: string | null; identifier: string | null; found_title: string | null; found_doi: string | null; note: string | null };
export type RefResult = RefEntry & { ref_sha: string; status: LookupStatus | "pending"; lookup: Lookup | null; flag: string | null };
export type CitationReport = { references: RefResult[]; counts: { references: number; resolved: number; found: number; unresolved: number; mismatch: number; skipped: number; pending: number }; flags: string[] };

const REF_HEADING = /^#{1,6}\s+.*\b(references?|bibliography)\b/i;
const DOI = /\b(10\.\d{4,9}\/[^\s"<>`]+)/g;
const ARXIV = /arXiv[:\s]*((?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7})|\d{4}\.\d{4,5})(?:v\d+)?|arxiv\.org\/(?:abs|pdf)\/((?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7})|\d{4}\.\d{4,5})/gi;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const KEYED = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?\*{0,2}\[([A-Za-z][A-Za-z0-9+–-]{0,15})\]\*{0,2}/;
const MAILTO = () => process.env.CROSSREF_MAILTO || "support@solveathome.org";
const UA = () => `solveathome-reference-check/1.0 (https://solveathome.org; mailto:${MAILTO()})`;

const cleanDoi = (d: string) => d.replace(/[*_]+$/g, "").replace(/[.,;:)\]]+$/g, "").replace(/\)$/, "");
export const refSha = (text: string) => createHash("sha256").update(text.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex");
const plain = (s: string) => s.replace(/\*\*?|__?|`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();

function entry(text: string, line: number, inline: boolean): RefEntry {
  const key = KEYED.exec(text)?.[1] ?? null;
  const dois = [...new Set([...text.matchAll(DOI)].map((m) => cleanDoi(m[1])))];
  const arxiv = [...new Set([...text.matchAll(ARXIV)].map((m) => (m[1] ?? m[2])))];
  const urls = [...new Set([...text.matchAll(/https?:\/\/[^\s)>\]]+/g)].map((m) => m[0]))];
  // The title is the first emphasised span that is not a provenance note (those start with a verb or a bracket tag), or a quoted
  // span standing between commas: a quoted phrase inside a title (The "Riemann hypothesis" for …) is not the title.
  const em = [...text.matchAll(/(?<![*\w])\*(?!\*)([^*]{6,}?)\*(?!\*)|(?:^|[,;:.]\s*)"([^"]{6,})"(?=\s*[,.;:]|$)|(?:^|[,;:.]\s*)“([^”]{6,})”(?=\s*[,.;:]|$)/g)].map((m) => (m[1] ?? m[2] ?? m[3]).trim())
    .filter((t) => !/^\[|^(record|read|bibliograph|entry|cited|not |confirmed|carried|abbreviated)/i.test(t) && words(t).length >= 2);
  const years = [...new Set([...text.matchAll(/\b(1[6-9]\d\d|20[0-4]\d)\b/g)].map((m) => Number(m[1])))];
  return { key, text: plain(text), line, inline, dois, arxiv, urls, title: em[0] ? plain(em[0]) : null, years };
}

/** Every reference: the entries of a References or Bibliography section, plus any DOI or arXiv id cited elsewhere in the text. */
export function parseReferences(md: string): RefEntry[] {
  const lines = md.split("\n");
  const out: RefEntry[] = [];
  let fence = false, inRefs = false, level = 0;
  let section: Array<{ text: string; line: number; item: boolean }> = [];
  const flush = () => {
    const listed = section.some((s) => s.item);
    for (const s of section) if ((!listed || s.item) && (/\b(1[6-9]\d\d|20[0-4]\d)\b|10\.\d{4,9}\/|arxiv/i.test(s.text))) out.push(entry(s.text, s.line, false));
    section = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^(#{1,6})\s/.exec(line);
    if (h) { if (inRefs && h[1].length <= level) { flush(); inRefs = false; } if (REF_HEADING.test(line) && !inRefs) { inRefs = true; level = h[1].length; continue; } }
    if (!inRefs) continue;
    if (!line.trim() || /^\s*(---|\*\*\*)\s*$/.test(line) || h) { if (section.length && !section[section.length - 1].item) section.push({ text: "", line: i + 1, item: false }); continue; }
    const item = ITEM.test(line) || KEYED.test(line);
    const last = section[section.length - 1];
    // A wrapped line continues its item; in a section without list markers every line is its own entry.
    if (!item && last && last.item && /^\s{2,}|^[a-z(]/.test(line)) last.text += " " + line.trim();
    else section.push({ text: line.trim(), line: i + 1, item });
  }
  if (inRefs) flush();
  const known = new Set(out.flatMap((e) => [...e.dois.map((d) => d.toLowerCase()), ...e.arxiv]));
  // Identifiers cited in the body and absent from the list are checked too (kk-lower-bound carries its bibliography in a paragraph).
  fence = false; inRefs = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^(#{1,6})\s/.exec(line);
    if (h) { if (inRefs && h[1].length <= level) inRefs = false; if (REF_HEADING.test(line)) { inRefs = true; level = h[1].length; } }
    if (inRefs) continue;
    const ids = [...[...line.matchAll(DOI)].map((m) => cleanDoi(m[1]).toLowerCase()), ...[...line.matchAll(ARXIV)].map((m) => m[1] ?? m[2])].filter((x) => !known.has(x));
    if (!ids.length) continue;
    // One entry per cited work: the sentence around the identifier, so its title and year travel with it.
    const sentences = line.split(/(?<=[;])\s+|(?<=\.)\s+(?=[A-Z])/);
    for (const s of sentences) {
      const e = entry(s, i + 1, true);
      const fresh = [...e.dois.map((d) => d.toLowerCase()), ...e.arxiv].filter((x) => !known.has(x));
      if (!fresh.length) continue;
      fresh.forEach((x) => known.add(x));
      out.push(e);
    }
  }
  return out;
}

export function referenceKeys(md: string): string[] { return parseReferences(md).map((e) => e.key).filter((k): k is string => !!k); }

// ---- lookups ------------------------------------------------------------------------------------------------------------------

const STOP = new Set(["the", "and", "for", "with", "from", "into", "über", "une", "des", "les", "der", "die", "und", "von", "sur", "on", "of", "in", "a", "an", "to", "la", "le", "et", "its", "their", "some"]);
export const words = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/<[^>]+>/g, " ").replace(/\$[^$]*\$/g, " ").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
/** The share of a's title words that appear in b. */
export function contained(a: string, b: string): number { const A = [...new Set(words(a))], B = new Set(words(b)); return A.length ? A.filter((w) => B.has(w)).length / A.length : 0; }

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastArxiv = 0, lastCrossref = 0;
async function polite(fetcher: Fetcher, url: string, host: "arxiv" | "crossref" | "doi", accept = "application/json"): Promise<Response | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const gap = host === "arxiv" ? 3100 - (Date.now() - lastArxiv) : host === "crossref" ? 120 - (Date.now() - lastCrossref) : 0;
    if (gap > 0 && process.env.NODE_ENV !== "test") await sleep(gap);
    if (host === "arxiv") lastArxiv = Date.now(); else if (host === "crossref") lastCrossref = Date.now();
    const res = await fetcher(url, { headers: { "user-agent": UA(), accept }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (res && res.status !== 429 && res.status < 500) return res;
    const wait = Number(res?.headers.get("retry-after")) * 1000 || 2000 * 2 ** attempt;
    if (process.env.NODE_ENV !== "test") await sleep(Math.min(wait, 30_000));
  }
  return null;
}

class Unavailable extends Error {}
async function crossrefWork(f: Fetcher, doi: string): Promise<{ title: string; doi: string; year: number | null } | null> {
  const r = await polite(f, `https://api.crossref.org/works/${encodeURIComponent(doi)}`, "crossref");
  if (!r) throw new Unavailable("Crossref did not answer");
  if (r.status === 404) return null;
  if (!r.ok) throw new Unavailable(`Crossref answered ${r.status}`);
  const m = (await r.json() as any).message;
  return { title: [m.title?.[0], m.subtitle?.[0]].filter(Boolean).join(": "), doi: m.DOI, year: m.issued?.["date-parts"]?.[0]?.[0] ?? null };
}
async function doiRegistered(f: Fetcher, doi: string): Promise<boolean> {
  const r = await polite(f, `https://doi.org/api/handles/${encodeURIComponent(doi)}`, "doi");
  if (!r) throw new Unavailable("doi.org did not answer");
  if (r.status === 404) return false;
  const j = await r.json().catch(() => null) as any;
  return j?.responseCode === 1;
}
async function crossrefSearch(f: Fetcher, e: RefEntry): Promise<{ title: string; doi: string } | null> {
  const query = e.text.replace(DOI, "").replace(ARXIV, "").replace(/https?:\/\/\S+/g, "").slice(0, 300);
  const r = await polite(f, `https://api.crossref.org/works?rows=5&select=DOI,title,issued,author&query.bibliographic=${encodeURIComponent(query)}`, "crossref");
  if (!r) throw new Unavailable("Crossref did not answer");
  if (!r.ok) throw new Unavailable(`Crossref answered ${r.status}`);
  const items = ((await r.json() as any).message?.items ?? []) as any[];
  for (const it of items) {
    // A corrigendum or erratum shares its paper's title and is never the work cited (first run, Oct 16: "Long gaps in sieved sets").
    const title = String(it.title?.[0] ?? ""); if (!title || /^(corrigendum|erratum|correction|retraction|addendum)\b/i.test(title)) continue;
    const year = it.issued?.["date-parts"]?.[0]?.[0];
    const family = String(it.author?.[0]?.family ?? "");
    const titleOk = e.title ? contained(e.title, title) >= 0.8 && contained(title, e.title) >= (words(e.title).length >= 3 ? 0.4 : 0.6) : contained(title, e.text) >= 0.85 && words(title).length >= 3;
    const yearOk = !e.years.length || !year || e.years.some((y) => Math.abs(y - year) <= 1);
    const authorOk = !family || contained(family, e.text) > 0;
    if (titleOk && yearOk && authorOk) return { title, doi: it.DOI };
  }
  return null;
}
async function arxivTitles(f: Fetcher, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const r = await polite(f, `https://export.arxiv.org/api/query?id_list=${ids.map(encodeURIComponent).join(",")}&max_results=${ids.length}`, "arxiv", "application/atom+xml");
  if (!r || !r.ok) throw new Unavailable("arXiv did not answer");
  const xml = await r.text();
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = /<id>https?:\/\/arxiv\.org\/abs\/([^<]+?)(?:v\d+)?<\/id>/.exec(m[1])?.[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1]?.replace(/\s+/g, " ").trim();
    if (id && title && title !== "Error") out.set(id, title);
  }
  return out;
}
async function arxivSearch(f: Fetcher, title: string): Promise<{ id: string; title: string } | null> {
  const t = words(title).slice(0, 10).join(" ");
  if (!t) return null;
  const r = await polite(f, `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`ti:"${t}"`)}&max_results=3`, "arxiv", "application/atom+xml");
  if (!r || !r.ok) throw new Unavailable("arXiv did not answer");
  for (const m of (await r.text()).matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = /<id>https?:\/\/arxiv\.org\/abs\/([^<]+?)(?:v\d+)?<\/id>/.exec(m[1])?.[1];
    const found = /<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    if (id && contained(title, found) >= 0.85 && contained(found, title) >= 0.7) return { id, title: found };
  }
  return null;
}

const quote = (t: string) => `"${t.length > 90 ? t.slice(0, 87) + "…" : t}"`;
/** One reference against the indexes. arxivKnown carries a batch lookup for the paper's arXiv ids, so a paper costs one arXiv call. */
export async function lookupReference(e: RefEntry, f: Fetcher = fetch, arxivKnown?: Map<string, string>): Promise<Lookup> {
  // An identifier quoted in running text, or in an entry with no title, is checked for existence only: there is no title to compare
  // (a word in italics in a sentence is not one; reading those as titles gave three false mismatches on the first run, Oct 16).
  const titleFits = (found: string) => e.inline || !e.title ? true : contained(e.title, found) >= 0.6 || contained(found, e.title) >= 0.6;
  const notes: string[] = [];
  try {
    for (const doi of e.dois) {
      const w = await crossrefWork(f, doi);
      if (w) {
        if (titleFits(w.title)) return { status: "resolved", source: "crossref", identifier: `doi:${doi}`, found_title: w.title, found_doi: w.doi, note: null };
        const alt = await crossrefSearch(f, e);
        return { status: "mismatch", source: "crossref", identifier: `doi:${doi}`, found_title: w.title, found_doi: alt?.doi ?? null, note: `the DOI ${doi} belongs to a different work, ${quote(w.title)}.${alt ? ` Crossref has this reference as DOI ${alt.doi}.` : " Fix the DOI."}` };
      }
      if (await doiRegistered(f, doi)) return { status: "resolved", source: "doi.org", identifier: `doi:${doi}`, found_title: null, found_doi: doi, note: "registered at doi.org outside Crossref, so its title was not compared" };
      notes.push(`the DOI ${doi} is not registered (neither Crossref nor doi.org knows it)`);
    }
    const ax = e.arxiv.length ? (arxivKnown && e.arxiv.every((id) => arxivKnown.has(id) || arxivKnown.has(`missing:${id}`)) ? arxivKnown : await arxivTitles(f, e.arxiv)) : new Map<string, string>();
    for (const id of e.arxiv) {
      const t = ax.get(id);
      if (t && titleFits(t)) return { status: notes.length ? "mismatch" : "resolved", source: "arxiv", identifier: `arXiv:${id}`, found_title: t, found_doi: null, note: notes.length ? `${notes.join("; ")}; the arXiv id ${id} does resolve to it. Fix or remove the DOI.` : null };
      if (t) return { status: "mismatch", source: "arxiv", identifier: `arXiv:${id}`, found_title: t, found_doi: null, note: `the arXiv id ${id} belongs to a different paper, ${quote(t)}. Fix the arXiv id.` };
      notes.push(`the arXiv id ${id} does not exist`);
    }
    if (notes.length) {
      const alt = await crossrefSearch(f, e);
      return { status: "unresolved", source: null, identifier: e.dois[0] ? `doi:${e.dois[0]}` : `arXiv:${e.arxiv[0]}`, found_title: alt?.title ?? null, found_doi: alt?.doi ?? null, note: `${notes.join("; ")}.${alt ? ` Crossref has this reference as DOI ${alt.doi}: probably a typo.` : " Check the identifier for a typo."}` };
    }
    // Not publications: an OEIS sequence, a blog post, the project's own files. The claim check looks project files up.
    if (!e.dois.length && !e.arxiv.length && /\bOEIS\b|\bA\d{6}\b/.test(e.text) && !e.title) return { status: "skipped", source: null, identifier: null, found_title: null, found_doi: null, note: "an OEIS sequence, not looked up" };
    if (/\bblog\b/i.test(e.text)) return { status: "skipped", source: null, identifier: e.urls[0] ?? null, found_title: null, found_doi: null, note: "a blog post, not looked up" };
    if (!e.title && /(?:^|\s)`?(?:research|paper|tools|bench)\/[\w./-]+\.\w+/.test(e.text)) return { status: "skipped", source: null, identifier: null, found_title: null, found_doi: null, note: "the project's own files, not a publication" };
    if (!e.title && e.urls.length && !/\b(1[6-9]\d\d|20[0-4]\d)\b/.test(e.text.replace(/https?:\/\/\S+/g, ""))) return { status: "skipped", source: null, identifier: e.urls[0], found_title: null, found_doi: null, note: "a web page, not a publication: not looked up" };
    const hit = await crossrefSearch(f, e);
    if (hit) return { status: "found", source: "crossref", identifier: null, found_title: hit.title, found_doi: hit.doi, note: `found in Crossref as DOI ${hit.doi}; add it to the entry.` };
    if (e.title) { const a = await arxivSearch(f, e.title); if (a) return { status: "found", source: "arxiv", identifier: null, found_title: a.title, found_doi: null, note: `found on arXiv as arXiv:${a.id}; add it to the entry.` }; }
    if (e.urls.length) return { status: "skipped", source: null, identifier: e.urls[0], found_title: null, found_doi: null, note: "not in Crossref or arXiv; it names a web page, which is not looked up" };
    if (!e.title) return { status: "unresolved", source: null, identifier: null, found_title: null, found_doi: null, note: "gives no title, DOI or arXiv id, so it could not be looked up: add the title, and the DOI or arXiv id if it has one." };
    return { status: "unresolved", source: null, identifier: null, found_title: null, found_doi: null, note: "not found in Crossref or arXiv. A book or an old paper may have no DOI: check it by hand at the page and say so in the entry; if it has a DOI or arXiv id, add it." };
  } catch (err) {
    if (err instanceof Unavailable) return { status: "error", source: null, identifier: null, found_title: null, found_doi: null, note: err.message };
    throw err;
  }
}

// ---- stored results ------------------------------------------------------------------------------------------------------------

const RETRY_ERROR_MS = 60 * 60 * 1000;
async function stored(shas: string[]): Promise<Map<string, Lookup & { checked_at: Date }>> {
  if (!shas.length) return new Map();
  const rows = await q<any>(`SELECT * FROM citation_lookups WHERE ref_sha = ANY($1)`, [shas]);
  return new Map(rows.map((r) => [r.ref_sha, r]));
}

/** Looks up every reference of a manuscript not yet on record (or whose lookup failed over an hour ago) and stores each result. */
export async function resolveReferences(md: string, f: Fetcher = fetch): Promise<{ looked_up: number }> {
  const refs = parseReferences(md);
  const have = await stored(refs.map((r) => refSha(r.text)));
  const todo = refs.filter((r) => { const s = have.get(refSha(r.text)); return !s || (s.status === "error" && Date.now() - new Date(s.checked_at).getTime() > RETRY_ERROR_MS); });
  if (!todo.length) return { looked_up: 0 };
  let ax = new Map<string, string>();
  const ids = [...new Set(todo.flatMap((r) => r.arxiv))];
  try { ax = await arxivTitles(f, ids); for (const id of ids) if (!ax.has(id)) ax.set(`missing:${id}`, ""); } catch { /* each reference asks again on its own */ }
  for (const r of todo) {
    const l = await lookupReference(r, f, ax);
    await q(`INSERT INTO citation_lookups (ref_sha, ref_text, status, source, identifier, found_title, found_doi, note, checked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
      ON CONFLICT (ref_sha) DO UPDATE SET status = EXCLUDED.status, source = EXCLUDED.source, identifier = EXCLUDED.identifier, found_title = EXCLUDED.found_title, found_doi = EXCLUDED.found_doi, note = EXCLUDED.note, checked_at = now()`,
      [refSha(r.text), r.text, l.status, l.source, l.identifier, l.found_title, l.found_doi, l.note]);
  }
  return { looked_up: todo.length };
}

// One queue for the whole process: papers are looked up one after another, never in parallel against the same index.
let queue: Promise<unknown> = Promise.resolve();
const queued = new Set<string>();
/** Starts the lookup in the background (intake, a paper page with references not yet on record) and returns at once. */
export function queueReferenceLookup(md: string): void {
  const key = refSha(md);
  // Off under the test runner: a test that submits a paper must not reach Crossref or leave lookups behind.
  if (queued.has(key) || process.env.CITATION_LOOKUP === "off" || process.env.NODE_TEST_CONTEXT) return;
  queued.add(key);
  queue = queue.then(() => resolveReferences(md)).catch((e) => console.error("reference lookup failed:", e?.message ?? e)).finally(() => queued.delete(key));
}

const short = (e: RefEntry) => `${e.key ? `[${e.key}] ` : ""}${e.title ? quote(e.title) : quote(e.text)}`;
/** The stored results for a manuscript's references, with a plain-language flag on each one a person should look at. */
export async function citationReport(md: string): Promise<CitationReport> {
  const refs = parseReferences(md);
  const have = await stored(refs.map((r) => refSha(r.text)));
  const references: RefResult[] = refs.map((r) => {
    const sha = refSha(r.text), l = have.get(sha) ?? null;
    const status = !l || l.status === "error" ? "pending" : l.status;
    const flag = status === "unresolved" || status === "mismatch" ? `Reference ${short(r)} (line ${r.line}): ${l!.note}` : null;
    return { ...r, ref_sha: sha, status, lookup: l ? { status: l.status, source: l.source, identifier: l.identifier, found_title: l.found_title, found_doi: l.found_doi, note: l.note } : null, flag };
  });
  const n = (s: string) => references.filter((r) => r.status === s).length;
  return { references, counts: { references: references.length, resolved: n("resolved"), found: n("found"), unresolved: n("unresolved"), mismatch: n("mismatch"), skipped: n("skipped"), pending: n("pending") }, flags: references.map((r) => r.flag).filter((x): x is string => !!x) };
}
