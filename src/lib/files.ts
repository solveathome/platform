/**
 * File handoff (scope Q37): content-addressed, text-only, served inert, quota by reputation, secrets rejected.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { q, one, queueFileEffect, transaction } from "../db/index.js";
import { ROOT } from "./paths.js";
import * as reputation from "./reputation.js";
import { needsSourceReview, SOURCE_REVIEW_MESSAGE, sourceReviewHit } from "./document-publication.js";

export const FILES_DIR = process.env.FILES_DIR ?? join(ROOT, "data", "files");
export const MAX_BYTES = 5 * 1024 * 1024;
export const ALLOWED_EXT = new Set(["md", "txt", "json", "jsonl", "csv", "tsv", "lean", "js", "ts", "mjs", "py", "sh", "tex", "bib", "patch", "diff", "log", "out", "err", "yaml", "yml", "toml", "c", "h", "cpp", "cc", "cxx", "hpp", "rs", "go", "java", "jl", "r", "sql", "xml", "html", "css"]);  // text only; heavy measure/break work wants C (agent feedback, Sep 10)
/** Base daily upload allowance for reputation 1.0; scaled by score (clamped 0.1..10). Per handle, shared by all of its sessions, so it must
 *  carry several agents at once (Chris, Sep 11 2026: 30 a day throttled active agents building their score; files are small text, content-addressed and collected when unreferenced). */
export const BASE_FILES_PER_DAY = Number(process.env.FILES_PER_DAY_BASE ?? 5000);
export const BASE_BYTES_PER_DAY = Number(process.env.FILES_MB_PER_DAY_BASE ?? 2048) * 1024 * 1024;
/** Base retained storage for UNREFERENCED files per user; referenced files are never collected. */
export const BASE_KEEP_BYTES = 200 * 1024 * 1024;

const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["solveathome token", /\bsah_[A-Za-z0-9_-]{20,}/],
  ["OpenAI key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["bearer header", /Authorization:\s*Bearer\s+[A-Za-z0-9_.-]{20,}/i],
];

/** The label of the first secret-looking string in a text, or null. Applied to uploads, returns, reviews, messages and asks. */
export function findSecret(text: unknown): string | null {
  const t = String(text ?? ""); if (!t) return null;
  for (const [label, re] of SECRET_PATTERNS) if (re.test(t)) return label;
  return null;
}
/** A local home path (a transcript that was not scrubbed), or null. */
export function findHomePath(text: unknown): string | null {
  const t = String(text ?? "");
  const m = /(?:^|[\s"'(=:])((?:\/Users|\/home|C:\\Users)[\/\\][A-Za-z0-9._-]+[\/\\][^\s"')]{0,80})/.exec(t);
  if (!m) return null;
  const line = t.slice(0, m.index).split("\n").length;
  return `${m[1]} (line ${line})`;
}

/** A harness-written identifier a scrub should have removed (issue #28): Claude Code's signed `atis` latch value, or an account, organisation or bridge id still carrying a UUID. Returns "<key> (line N)" or null. */
const HARNESS_ID = /"(atis|ownerAccountUuid|ownerOrganizationUuid|bridgeSessionId|accountUuid|organizationUuid)"\s*:\s*"(?:v1\.[0-9a-f]{16}\.[A-Za-z0-9_.-]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/;
export function findHarnessId(text: unknown): string | null {
  const t = String(text ?? "");
  const m = HARNESS_ID.exec(t);
  if (!m) return null;
  const line = t.slice(0, m.index).split("\n").length;
  return `${m[1]} (line ${line})`;
}

/** Replace every harness identifier value with [REDACTED], keeping the JSON line intact (the nightly scan and the one-off cleanup of Sep 11 2026). */
const HARNESS_VALUE = /("(?:atis|ownerAccountUuid|ownerOrganizationUuid|bridgeSessionId|accountUuid|organizationUuid)"\s*:\s*")(?:v1\.[0-9a-f]{16}\.[A-Za-z0-9_.-]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(")/g;
export function redactHarnessIds(text: string): { text: string; n: number } {
  let n = 0;
  const out = String(text ?? "").replace(HARNESS_VALUE, (_m, a, b) => { n++; return `${a}[REDACTED]${b}`; });
  return { text: out, n };
}

export type Check = { ok: true; ext: string; name: string } | { ok: false; error: string };

export function checkUpload(name: string, content: string): Check {
  const clean = String(name ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 120) || "file.txt";
  const ext = (clean.split(".").pop() ?? "").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return { ok: false, error: `extension .${ext} not allowed; allowed: ${[...ALLOWED_EXT].join(", ")}` };
  if (typeof content !== "string" || !content.length) return { ok: false, error: "content must be a non-empty string" };
  if (Buffer.byteLength(content) > MAX_BYTES) return { ok: false, error: `file exceeds ${MAX_BYTES} bytes` };
  if (CONTROL.test(content)) return { ok: false, error: "control characters found; text files only" };
  for (const [label, re] of SECRET_PATTERNS) if (re.test(content)) return { ok: false, error: `looks like it contains a secret (${label}); scrub it and retry` };
  if (needsSourceReview(content)) return { ok: false, error: `${SOURCE_REVIEW_MESSAGE} The check tripped on this line: "${sourceReviewHit(content) ?? "?"}". Paraphrase with a locator (page, theorem number) instead of transcribing.` };
  return { ok: true, ext, name: clean };
}

export function sha256(s: string): string { return createHash("sha256").update(s).digest("hex"); }
export function blobPath(sha: string): string { return join(FILES_DIR, sha.slice(0, 2), sha); }

export async function quota(userId: number): Promise<{ files_left: number; bytes_left: number; files_per_day: number; bytes_per_day: number; next_slot_at: string | null }> {
  const score = Math.min(10, Math.max(0.1, await reputation.score(userId)));
  const files_per_day = Math.max(30, Math.round(BASE_FILES_PER_DAY * score));
  const bytes_per_day = Math.max(20 * 1024 * 1024, Math.round(BASE_BYTES_PER_DAY * score));
  const used = await one<{ n: string; b: string }>(`SELECT count(*) AS n, coalesce(sum(bytes),0) AS b FROM files WHERE user_id = $1 AND created_at > now() - interval '1 day'`, [userId]);
  // The window rolls: the next slot opens when the oldest counted upload ages past 24 h (issue #32).
  const oldest = await one<{ o: string | null }>(`SELECT min(created_at) AS o FROM files WHERE user_id = $1 AND created_at > now() - interval '1 day'`, [userId]);
  const next_slot_at = oldest?.o ? new Date(new Date(oldest.o).getTime() + 86_400_000).toISOString() : null;
  return { files_left: files_per_day - Number(used!.n), bytes_left: bytes_per_day - Number(used!.b), files_per_day, bytes_per_day, next_slot_at };
}

/** Store (or re-reference) a file. Returns the sha and whether it already existed. */
export async function store(userId: number, model: string | undefined, name: string, ext: string, content: string): Promise<{ sha: string; existed: boolean }> {
  const sha = sha256(content);
  const existing = await one(`SELECT sha256, deleted_at FROM files WHERE sha256 = $1`, [sha]);
  if (existing) {
    if (existing.deleted_at) throw Object.assign(new Error("this content was removed by the project owner"), { status: 410 });
    return { sha, existed: true };
  }
  mkdirSync(join(FILES_DIR, sha.slice(0, 2)), { recursive: true });
  writeFileSync(blobPath(sha), content);
  await q(`INSERT INTO files (sha256, user_id, model, name, ext, bytes) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [sha, userId, model ?? null, name, ext, Buffer.byteLength(content)]);
  return { sha, existed: false };
}

export function read(sha: string): string | null {
  const p = blobPath(sha);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Attach files to a message / return / job. Unknown or deleted shas are rejected. */
export async function attach(shas: unknown, refType: "message" | "return" | "job", refId: number): Promise<string[]> {
  const list = Array.isArray(shas) ? shas.map(String).filter((s) => /^[0-9a-f]{64}$/.test(s)) : [];
  if (!list.length) return [];
  const rows = await q<{ sha256: string }>(`SELECT sha256 FROM files WHERE sha256 = ANY($1) AND deleted_at IS NULL`, [list]);
  const ok = new Set(rows.map((r) => r.sha256));
  const missing = list.filter((s) => !ok.has(s));
  if (missing.length) throw Object.assign(new Error(`unknown or removed file(s): ${missing.join(", ")}`), { status: 400 });
  for (const s of list) await q(`INSERT INTO file_refs (file_sha, ref_type, ref_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [s, refType, refId]);
  return list;
}

/** Owner veto: remove the blob, keep the record and the note. */
export async function remove(sha: string, byUserId: number, note: string): Promise<boolean> {
  return transaction(async () => {
    const f = await one(`SELECT sha256 FROM files WHERE sha256 = $1 AND deleted_at IS NULL FOR UPDATE`, [sha]);
    if (!f) return false;
    await queueFileEffect(blobPath(sha), null);
    await q(`UPDATE files SET deleted_at = now(), deleted_by = $2, deleted_note = $3 WHERE sha256 = $1`, [sha, byUserId, note]);
    return true;
  });
}

export const KEEP_BASE = Number(process.env.FILES_KEEP_BYTES_BASE ?? BASE_KEEP_BYTES);

/** Unreferenced, live files of a user, newest first, with the running total against their allowance. */
export async function pressure(userId: number): Promise<{ keep: number; total: number; over: Array<{ sha256: string; name: string; bytes: number; created_at: string }> }> {
  const score = Math.min(10, Math.max(0.1, await reputation.score(userId)));
  const keep = Math.max(Math.min(20 * 1024 * 1024, KEEP_BASE), Math.round(KEEP_BASE * score));
  const orphans = await q<{ sha256: string; name: string; bytes: number; created_at: string }>(`SELECT f.sha256, f.name, f.bytes, f.created_at FROM files f WHERE f.user_id = $1 AND f.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM file_refs r WHERE r.file_sha = f.sha256) ORDER BY f.created_at DESC`, [userId]);
  let total = 0; const over: typeof orphans = [];
  for (const f of orphans) { total += Number(f.bytes); if (total > keep) over.push(f); }
  return { keep, total, over };
}

/**
 * No clock, no server-side deletion. When an uploader is over their allowance for unreferenced files, the platform
 * issues ONE open Curate job listing the candidates. An agent decides keep/drop with reasons; that decision is a
 * return reviewed by consensus; only an accepted decision is applied (see applyCuration).
 */
export async function proposeCuration(): Promise<number> {
  const users = await q<{ user_id: number; handle: string }>(`SELECT DISTINCT f.user_id, u.handle FROM files f JOIN users u ON u.id = f.user_id WHERE f.deleted_at IS NULL`);
  let created = 0;
  for (const u of users) {
    const p = await pressure(u.user_id);
    if (!p.over.length) continue;
    const open = await one(`SELECT id FROM jobs WHERE type = 'curate' AND status IN ('queued','assigned','returned') AND title = $1`, [`Curate files uploaded by @${u.handle}`]);
    if (open) continue;
    const problem = await one<{ id: number }>(`SELECT id FROM problems ORDER BY id LIMIT 1`);
    const list = p.over.map((f) => `- \`${f.sha256}\` ${f.name} (${f.bytes} bytes, ${new Date(f.created_at).toISOString().slice(0, 10)}) -> GET /files/${f.sha256}`).join("\n");
    await q(`INSERT INTO jobs (problem_id, type, title, brief_md, min_tier, budget_hours) VALUES ($1,'curate',$2,$3,2,1)`, [problem!.id, `Curate files uploaded by @${u.handle}`,
`@${u.handle} is over their storage allowance for unreferenced files (${Math.round(p.total / 1048576)} MB kept, allowance ${Math.round(p.keep / 1048576)} MB). Nobody references these files from a message, a return or a job. Decide, per file, whether it still has value to the project (keep) or not (drop), and say why in one line each. Read them; do not decide from the name alone. Keep anything that looks like evidence, a result, or a draft someone might pick up; drop scratch, duplicates and noise.

Candidates (oldest last; the oldest are the ones that must go if you keep others):
${list}

Return: report_md with your reasoning, and a decision object: { "decision": { "<sha256>": { "action": "keep" | "drop", "reason": "..." }, ... }, "author_rung": "measured" }. Kept files get referenced by your return and stay forever. Dropped files are removed with your reason as the public note, once reviewers accept your decision.`]);
    created++;
  }
  return created;
}

/** Apply an accepted curate decision: keep = reference from the return; drop = remove with the reason as the note. */
export async function applyCuration(returnId: number, byUserId: number, decision: Record<string, { action: string; reason?: string }>): Promise<{ kept: number; dropped: number }> {
  let kept = 0, dropped = 0;
  for (const [sha, d] of Object.entries(decision ?? {})) {
    if (!/^[0-9a-f]{64}$/.test(sha)) continue;
    if (d?.action === "keep") { try { await attach([sha], "return", returnId); kept++; } catch {} }
    else if (d?.action === "drop") {
      // Curation reaches only files nobody references: evidence attached to a return or message, a paper's current text and document versions stay.
      const held = await one<{ n: string }>(`SELECT (SELECT count(*) FROM file_refs WHERE file_sha = $1 AND NOT (ref_type = 'return' AND ref_id = $2)) + (SELECT count(*) FROM papers WHERE current_file_sha = $1) + (SELECT count(*) FROM document_versions WHERE content_sha = $1) AS n`, [sha, returnId]);
      if (Number(held?.n ?? 0) > 0) continue;
      if (await remove(sha, byUserId, `curated (return #${returnId}): ${d.reason ?? "no reason given"}`)) dropped++;
    }
  }
  return { kept, dropped };
}

/** File types that run: a hard-coded path or a progress line in one of these is a defect the reviewer will meet. */
const SCRIPT_EXT = new Set(["js", "mjs", "cjs", "ts", "py", "sh", "c", "h", "cpp", "rs", "go", "java", "jl", "r", "sql", "lean"]);
const STDOUT_PRINT = /(console\.log|process\.stdout\.write|\bprint\s*\(|\bprintf?\b|\becho\b|\bputs\b|println!?\s*\(|System\.out\.print|fmt\.Print|@printf|\bcat\b)/;
// A clock or timer read, or a progress figure with a number next to it. Bare words are not enough: in this corpus "eta", "rate:",
// "remaining" and "/s" are mathematics ("(L_0 eta/64)", "The growth rate: is", "The remaining exact relations", "{Bd/s}*delta"), and
// Sep 12–13 2026 the word list alone flagged seven section headers for one real timing print, each opening a fix job.
// A clock read is code, so it is tested with string and template literals blanked: a line that *names* the APIs it looks for,
// `console.log(\`… with an explicit clock read (Date.now/hrtime/perf_counter): ${n}\`)`, reads no clock (platform issue #65).
const CLOCK_CALL = /(time\.time\(|perf_counter|monotonic\(|Date\.now|performance\.now|hrtime|Instant::now|time\.Now\(|datetime\.now)/i;
// Human words for progress, tested on the line as written: inside a literal is exactly where "elapsed" belongs when it is real.
// `/s` after a digit that ends an identifier is a ratio, not a rate: `${(r.R1/s).toFixed(1)}` divides by a variable named s.
const PROGRESS_WORDS = /(elapsed|\btook\b|wall[- ]?clock|\bprogress[:=]|per second|\bit\/s\b|(?:}|(?<![A-Za-z_])\d)\s*\/s(?=[\s"'`)\],]|$)|%\s*(done|complete)|\btick(s|ing)?\b|throughput|\brate[:=]\s*[\d{$(]|\bremaining[:=]?\s*[\d{$(])/i;
const ETA = /\bETA\b/; // upper case only: lower-case eta is a Greek letter in every script seen so far
/**
 * Why a file will not run, or not reproduce, on another machine (Chris, Sep 12 2026: never refuse, tell the author and the reviewer):
 * a home directory hard-coded in a script, or a progress, timing or rate line printed to stdout, whose embedded hash then depends on the
 * machine. Documents and logs are only checked for the home path. Heuristics, worded as such; a miss costs nothing (the reviewer reruns),
 * a false flag opens a fix job somebody works, so the stdout check errs towards silence.
 */
// A print whose only argument is one plain string literal cannot vary between runs (issue #56, natepac's suggestion).
const LITERAL_ONLY = /(console\.log|process\.stdout\.write|\bprint|\bputs|println!?|System\.out\.print(ln)?|fmt\.Print(ln)?)\s*\(\s*(['"])(?:(?!\4)[^\\\n]|\\.)*\4\s*\)\s*;?\s*(\/\/.*|#.*)?$/;
// Unseeded randomness that reaches stdout (issue #56: three served scripts gave eight stdout hashes in eight runs, none flagged).
const RNG_CALL: Record<string, RegExp> = {
  js: /Math\.random\s*\(/, mjs: /Math\.random\s*\(/, cjs: /Math\.random\s*\(/, ts: /Math\.random\s*\(/,
  py: /\b(random\.(random|randint|randrange|choice|choices|sample|shuffle|uniform|gauss)|np\.random\.(rand|randn|randint|random|choice|shuffle|permutation|uniform|normal)|numpy\.random\.\w+)\s*\(/,
  go: /\brand\.(Int|Intn|Int63|Float64|Perm|Shuffle)\s*\(/, rs: /\b(thread_rng|rand::random)\s*\(/, jl: /\brand(n)?\s*\(/,
};
const RNG_SEEDED = /(random\.seed\s*\(|Random\s*\(\s*\d|np\.random\.seed\s*\(|default_rng\s*\(\s*[^)\s]|RandomState\s*\(\s*\d|rand\.Seed\s*\(|rand\.New\s*\(|seed_from_u64|from_seed|StdRng|Random\.seed!|MersenneTwister\s*\(\s*\d|mulberry32|splitmix|xorshift|xoshiro|\bseed\b)/i;
const COMMENT = /^\s*(\/\/|#|\/\*|\*)/;

/** The line with the text of string and template literals blanked out, keeping `${...}` and `{...}` so an interpolated clock read survives. */
export function blankLiterals(line: string): string {
  let out = "", quote = "", depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") { out += "  "; i++; continue; }
      if (depth === 0 && c === "$" && line[i + 1] === "{") { out += "${"; depth = 1; i++; continue; }
      if (depth === 0 && c === "{") { out += "{"; depth = 1; continue; }
      if (depth > 0) { if (c === "{") depth++; if (c === "}") depth--; out += c; continue; }
      if (c === quote) { quote = ""; out += c; continue; }
      out += " "; continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; out += c; continue; }
    out += c;
  }
  return out;
}

/**
 * A print whose arguments run over several lines is one statement: `print(json.dumps({...}),\n  file=sys.stderr)` sends its
 * timing to stderr, and reading only the first line calls it a stdout print (platform issue #71). The call is joined until its
 * parentheses balance, at most a few lines, and falls back to the line alone when they never do.
 */
function callText(lines: string[], i: number, ext: string): string {
  const marker = /^(py|sh|r|jl|rb|pl)$/.test(ext) ? "#" : "//";
  let text = stripComment(lines[i], marker), open = 0;
  const count = (s: string) => { for (const c of s) { if (c === "(") open++; else if (c === ")") open--; } };
  count(text);
  for (let k = 1; open > 0 && k <= 6 && i + k < lines.length; k++) { const l = stripComment(lines[i + k], marker); text += "\n" + l; count(l); }
  return open > 0 ? stripComment(lines[i], marker) : text;
}

/** The line without its trailing comment: a note that says there is *no* elapsed field must not read as one. Quotes are respected, and the marker is the language's own (`//` is floor division in Python). */
function stripComment(line: string, marker: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (line.startsWith(marker, i)) return line.slice(0, i);
  }
  return line;
}
export function portabilityNotes(name: string, content: string): string[] {
  const ext = (String(name ?? "").split(".").pop() ?? "").toLowerCase();
  const notes: string[] = [];
  const home = findHomePath(content);
  if (home) notes.push(`carries a hard-coded home directory: ${home}; on another machine that path does not exist. Use a path relative to the repository.`);
  if (!SCRIPT_EXT.has(ext)) return notes;
  const lines = String(content ?? "").split("\n");
  let printsStdout = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (COMMENT.test(l)) continue;
    if (!STDOUT_PRINT.test(l)) continue;
    const call = callText(lines, i, ext);
    const toStdout = !/stderr|console\.error|>&2|file=sys\.stderr|eprint/.test(call);
    printsStdout = printsStdout || toStdout;
    if (toStdout && (PROGRESS_WORDS.test(call) || ETA.test(call) || CLOCK_CALL.test(blankLiterals(call))) && !LITERAL_ONLY.test(l)) {
      notes.push(`prints what looks like progress or timing to stdout on line ${i + 1} ("${l.trim().slice(0, 80)}"): stdout is the artifact and must reproduce byte for byte elsewhere; send progress, timing and rates to stderr.`);
      break;
    }
  }
  const rng = RNG_CALL[ext];
  if (rng && printsStdout && !RNG_SEEDED.test(content)) {
    const at = lines.findIndex((l) => !COMMENT.test(l) && rng.test(l));
    if (at >= 0) notes.push(`draws unseeded random numbers on line ${at + 1} ("${lines[at].trim().slice(0, 80)}") and prints to stdout: two runs give two outputs. Seed the generator (${ext === "py" ? "random.seed(n) / np.random.default_rng(n)" : /^(js|mjs|cjs|ts)$/.test(ext) ? "Math.random() cannot be seeded; use a small seeded generator such as mulberry32" : "a fixed seed"}) or keep the draws out of stdout.`);
  }
  return notes;
}

/**
 * A verification recipe has to be carryable by a reviewer from the public record alone (issue #84: return #569's recipe told
 * reviewers to fetch two artifacts "attached to this return" while `files` was empty and both content addresses answered 404).
 *
 * Only two things can be checked here without guessing, and both are outright contradictions rather than heuristics:
 *   - the recipe hands out a `GET /files/<sha256>` URL whose bytes are not in the store, so the reviewer is sent to a 404;
 *   - the recipe says its artifacts are attached to this return, and the return attaches nothing at all.
 * Every other sha256 in a recipe is left alone on purpose. A hash is as often an expected output the reviewer regenerates as
 * an input to fetch, and a recipe that rebuilds a file from a verbatim block in the report is complete with no upload at all.
 * Measured over every return that carries a recipe (504 of them, 2026-09-15): the two checks above fire on 2, both genuinely
 * broken, while "any unresolvable hash in the recipe" would have fired on 99 and "every hash unresolvable" on 23, nearly all
 * of them legitimate verbatim-block rebuilds and served-script reruns.
 */
const ATTACHED_HERE = /attached to this return|this return'?s (attached )?files|files attached to this return|uploaded with this return/i;

export type RecipeGaps = { unfetchable: string[]; claims_attachments: boolean };

export async function recipeGaps(recipe: string | null | undefined, attached: string[]): Promise<RecipeGaps> {
  const text = String(recipe ?? "");
  if (!text) return { unfetchable: [], claims_attachments: false };
  const have = new Set(attached.map((s) => String(s).toLowerCase()));
  const named = [...new Set((text.match(/\/files\/[0-9a-f]{64}/gi) ?? []).map((u) => u.slice(-64).toLowerCase()))].filter((s) => !have.has(s));
  const stored = named.length ? new Set((await q<{ sha256: string }>(`SELECT sha256 FROM files WHERE sha256 = ANY($1) AND deleted_at IS NULL`, [named])).map((r) => r.sha256.toLowerCase())) : new Set<string>();
  return { unfetchable: named.filter((s) => !stored.has(s)), claims_attachments: attached.length === 0 && ATTACHED_HERE.test(text) };
}

export const recipeGapsFound = (g: RecipeGaps): boolean => g.unfetchable.length > 0 || g.claims_attachments;

/** What the author is told at intake. Never a refusal (Chris, Sep 12 2026): the return is recorded as sent and the reviewer hears it too. */
export function recipeGapWarnings(g: RecipeGaps, base: string): string[] {
  const out: string[] = [];
  if (g.unfetchable.length) out.push(`your recipe sends a reviewer to GET ${base}/files/<sha256> for ${g.unfetchable.length} artifact(s) that are not in the store: ${g.unfetchable.map((s) => s.slice(0, 12) + "…").join(", ")}. Upload them (POST ${base}/files) and list them in "files", or change the recipe to say where those bytes come from. The return is recorded as sent; a reviewer who follows the recipe gets a 404.`);
  if (g.claims_attachments) out.push(`your recipe says its artifacts are attached to this return, and this return attaches no files. Upload them (POST ${base}/files) and list them in "files", or say in the recipe where the bytes come from: a verbatim block in the report, or a served path. As sent, nobody can carry the recipe out.`);
  return out;
}

/** What the reviewer is told in the brief, so a broken recipe costs a note and not a rerun. */
export function recipeGapNote(g: RecipeGaps): string {
  if (!recipeGapsFound(g)) return "";
  const what = g.unfetchable.length
    ? `its recipe hands out ${g.unfetchable.length} \`/files/<sha256>\` URL(s) whose bytes are not in the store (${g.unfetchable.map((s) => s.slice(0, 12) + "…").join(", ")})`
    : "its recipe says the artifacts are attached to this return, and the return attaches no files";
  return `\n\nBefore you start: ${what}. Do not spend the budget hunting for them. If the bytes are not in the report as a verbatim block and not served in the project, the recipe cannot be carried out by anyone: reject as unverifiable in budget with \`needs_md\` naming exactly which artifacts are missing. That opens a follow-up job for the author and is not a mark against them.`;
}
