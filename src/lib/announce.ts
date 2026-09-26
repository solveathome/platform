/**
 * Announcements (Chris, Sep 26 2026, #sah-discord-announcer). "Only share when there is actually something exciting that happened at the
 * validation state. E.g. our agent approved a finding that was exciting. We want to make sure the credit is given 100% to the person who
 * found the direction / proof / whatever."
 *
 * So a post needs all of: a trusted, non-provisional acceptance (the latest decision on the return); an accepting review marked `announce`
 * by a reviewer who holds a role on the project (owner or granted trust: trust by model never counts, whoever runs it); and a candidate kind
 * on the final record (candidateKind below). Nothing pending, recorded, provisional or contested ever goes out, and nothing about routes.
 *
 * A post names one person: the author of the accepted return, joined from users.handle when it is sent (never display_name, never the
 * reviewer, never the model). The ledger still pays the whole chain; the ledger's `result` row for the return must pay the same person,
 * or the post is skipped and the reason recorded: credit never drifts.
 *
 * Posts go out without a person in the loop (Chris, Sep 26 2026, #sah-discord-autopost: "Post without my approval"): a marked acceptance is
 * posted on the next pass, to a Discord webhook from the environment (the URL is never stored). The safeguards need nobody: the record is
 * read again just before sending, so a decision reversed before then drops the row; the only free text (the validator's note, a route
 * title) is left out of the post when it overclaims, and the row records what was left out (flag); one post per return, rate-limited. A
 * later decision that changes the acceptance edits a sent post, with a correction after it: every change is kept, a reversal is recorded,
 * never undone. /projects/<slug>/announcements is the owners' log of what was posted, dropped or changed.
 *
 * Config per project in project.json, off unless set: "announce": { "discord": true, "webhook_env": "DISCORD_PROGRESS_WEBHOOK_URL",
 * "hold_hours": 0, "approval": false, "max_per_day": 3, "route_cooldown_hours": 24, "burst_per_hour": 5 }. `approval: true` brings back an
 * owner's approval on that page; ANNOUNCE_ENABLED=0 stops it all.
 */
import { q, one } from "../db/index.js";
import { listProjectConfigs, readProjectConfig, type ProjectConfig } from "./projects.js";
import { roleOf } from "./roles.js";
import { verificationState } from "./verification.js";

export type AnnounceConfig = { discord: boolean; webhook_env: string; hold_hours: number; approval: boolean; max_per_day: number; route_cooldown_hours: number; burst_per_hour: number };
export const ANNOUNCE_DEFAULTS: AnnounceConfig = { discord: false, webhook_env: "DISCORD_PROGRESS_WEBHOOK_URL", hold_hours: 0, approval: false, max_per_day: 3, route_cooldown_hours: 24, burst_per_hour: 5 };
export function announceConfig(cfg: ProjectConfig | null | undefined): AnnounceConfig {
  const a = (cfg as any)?.announce ?? {};
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    discord: a.discord === true,
    webhook_env: typeof a.webhook_env === "string" && /^[A-Z][A-Z0-9_]*$/.test(a.webhook_env) ? a.webhook_env : ANNOUNCE_DEFAULTS.webhook_env,
    hold_hours: num(a.hold_hours, ANNOUNCE_DEFAULTS.hold_hours),
    approval: a.approval === true,
    max_per_day: num(a.max_per_day, ANNOUNCE_DEFAULTS.max_per_day),
    route_cooldown_hours: num(a.route_cooldown_hours, ANNOUNCE_DEFAULTS.route_cooldown_hours),
    burst_per_hour: num(a.burst_per_hour, ANNOUNCE_DEFAULTS.burst_per_hour),
  };
}
export const announceEnabled = (): boolean => !["0", "false", "off", "no"].includes(String(process.env.ANNOUNCE_ENABLED ?? "").trim().toLowerCase());

export type Kind = "proof" | "refutation" | "challenge" | "verified" | "opening";
const RANK: Record<string, number> = { refuted: 0, conjectured: 1, heuristic: 2, measured: 3, verified: 4, proven: 5 };
/** The kinds a validator may announce, read from the final record. `execution` is the verification state ('pass' = an independent re-run passed). */
export function candidateKind(ret: { type: string; final_rung: string | null; finding?: string | null }, execution?: string | null): Kind | null {
  if (ret.final_rung === "proven") return "proof";
  if (ret.type === "break" && ret.final_rung === "refuted") return "refutation";
  if (ret.type === "challenge" && ret.finding === "holds") return "challenge";
  if (ret.final_rung === "verified" && execution === "pass") return "verified";
  if (ret.type === "direction" || (ret.type === "explore" && RANK[ret.final_rung ?? ""] >= RANK.measured)) return "opening";
  return null;
}
/** Types whose review brief asks the announce question: not audits, curation, consolidation, papers or sources (dozens a day, never news). */
export const ANNOUNCE_TYPES = new Set(["formalize", "break", "challenge", "explore", "direction", "measure"]);
export const ANNOUNCE_MD_MAX = 200;

// Wording that would read as more than the record says: a person looks before it goes out, whatever the config.
const OVERCLAIM = [/\bsolved\b/i, /\bsolves\b/i, /\bbreakthrough\b/i, /conjecture (is|was) (true|proved|proven)/i, /\bproves? the (twin[- ]prime|conjecture)/i, /infinitely many twin primes (exist|are proved)/i, /\bhistoric\b/i, /\brevolutionary\b/i, /\bgroundbreaking\b/i, /\bamazing\b/i, /\bincredible\b/i, /\bfinally\b/i];
export function overclaim(text: string | null | undefined): string | null {
  const t = String(text ?? ""); const hit = OVERCLAIM.find((re) => re.test(t));
  return hit ? `wording to check: "${t.match(hit)![0]}"` : null;
}

// Discord renders no TeX. Simple math becomes Unicode; anything left over goes in inline code, and the link carries the reader to the rendered page.
const GREEK: Record<string, string> = { alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω" };
const SYMBOL: Record<string, string> = { le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", sim: "∼", asymp: "≍", ll: "≪", gg: "≫", cdot: "·", times: "×", pm: "±", mp: "∓", infty: "∞", to: "→", rightarrow: "→", mapsto: "↦", in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", sum: "∑", prod: "∏", int: "∫", partial: "∂", ll_: "≪", equiv: "≡", mid: "∣", nmid: "∤", ldots: "…", cdots: "⋯", dots: "…", log: "log", ln: "ln", exp: "exp", sin: "sin", cos: "cos", max: "max", min: "min", lim: "lim", sup: "sup", inf: "inf", gcd: "gcd", deg: "deg", det: "det" };
const BB: Record<string, string> = { N: "ℕ", Z: "ℤ", Q: "ℚ", R: "ℝ", C: "ℂ", P: "ℙ" };
const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", k: "ᵏ", x: "ˣ" };
const SUB: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", i: "ᵢ", j: "ⱼ", k: "ₖ", n: "ₙ", p: "ₚ", x: "ₓ" };
const script = (s: string, map: Record<string, string>, mark: string): string => [...s].every((c) => map[c]) ? [...s].map((c) => map[c]).join("") : `${mark}(${s})`;
export function texToUnicode(tex: string): { text: string; clean: boolean } {
  let t = tex;
  for (let i = 0; i < 4; i++) {   // nested groups resolve from the inside out
    t = t.replace(/\\(?:text|mathrm|operatorname|mathit|mathbf|textbf|mathsf)\{([^{}]*)\}/g, "$1")
      .replace(/\\mathbb\{([A-Z])\}/g, (m, c) => BB[c] ?? m)
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (_m, a, b) => `${a.length > 1 ? `(${a})` : a}/${b.length > 1 ? `(${b})` : b}`)
      .replace(/\\sqrt\{([^{}]*)\}/g, (_m, a) => a.length > 1 ? `√(${a})` : `√${a}`)
      .replace(/\^\{([^{}]*)\}/g, (_m, a) => script(a, SUP, "^"))
      .replace(/_\{([^{}]*)\}/g, (_m, a) => script(a, SUB, "_"));
  }
  t = t.replace(/\^([0-9a-z+\-])/g, (_m, a) => script(a, SUP, "^")).replace(/_([0-9a-z])/g, (_m, a) => script(a, SUB, "_"))
    .replace(/\\(left|right|big|Big|bigg|Bigg)\b/g, "").replace(/\\[,;:! ]|\\quad|\\qquad|~/g, " ")
    .replace(/\\([A-Za-z]+)/g, (m, w) => GREEK[w] ?? SYMBOL[w] ?? m).replace(/\\\{/g, "{").replace(/\\\}/g, "}")
    .replace(/\\#/g, "#").replace(/\{([^{}\\]*)\}/g, "$1").replace(/\s+/g, " ").trim();
  return { text: t, clean: !/[\\{}]/.test(t) };
}
/** Agent-written text quoted in a public channel: math converted, Markdown and links defused, mentions broken, one line, capped. */
export function quoteSafe(raw: string | null | undefined, max: number): string {
  const parts = String(raw ?? "").replace(/\s+/g, " ").trim().split(/(\$\$[^$]+\$\$|\$[^$]+\$|\\\([^]*?\\\))/g);
  let out = parts.map((p, i) => {
    if (i % 2) { const inner = p.replace(/^\$\$|\$\$$|^\$|\$$|^\\\(|\\\)$/g, ""); const u = texToUnicode(inner); return u.clean ? u.text.replace(/([*_~|`>])/g, "\\$1") : `\`${inner.replace(/`/g, "'")}\``; }
    return p.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/([*_~|`>\[\]])/g, "\\$1");
  }).join("").replace(/@/g, "@​").replace(/https?:\/\//gi, (m) => m.replace("//", "/​/"));
  if ([...out].length > max) out = [...out].slice(0, max - 1).join("").replace(/\\$/, "") + "…";
  return out;
}

const RUNG_COLOR: Record<string, number> = { proven: 0x2e7d32, verified: 0x1565c0, measured: 0x6a1b9a, refuted: 0xc62828, heuristic: 0x757575, conjectured: 0x757575 };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export type PostFacts = { kind: Kind; final_rung: string | null; return_id: number; type: string; handle: string; slug: string; base: string; decided_at: string | Date; route?: { id: number; title: string } | null; target_return_id?: number | null; note?: string | null };
/** Templates only (proposal v2 section 7): every line is a record field, the first says the rung and who decided, the finder is the one name. */
export function buildPost(f: PostFacts): { title: string; description: string; url: string; color: number } {
  const P = `${f.base}/projects/${f.slug}`;
  const title = {
    proof: "Proved: accepted at Proven by a trusted reviewer",
    refutation: "A claim was refuted: accepted at Refuted by a trusted reviewer",
    challenge: "An accepted result was shown not to hold: a challenge upheld by a trusted reviewer",
    verified: "Verified and reproduced: accepted at Verified by a trusted reviewer, re-run by an independent agent",
    opening: `A new direction was validated: accepted at ${cap(f.final_rung ?? "a rung")} by a trusted reviewer`,
  }[f.kind];
  const handle = String(f.handle).replace(/[^A-Za-z0-9_.-]/g, "");
  const what = `Return #${f.return_id} (${f.type})${f.route ? `, route #${f.route.id}${f.route.title ? ` “${quoteSafe(f.route.title, 160)}”` : ""}` : ""}${f.target_return_id && (f.kind === "refutation" || f.kind === "challenge") ? `: the claim in return #${f.target_return_id} does not hold` : ""}.`;
  const lines = [
    `Found by **[@${handle}](${f.base}/@${handle})**.`,
    what,
    ...(f.note ? [`Validator's note: “${quoteSafe(f.note, ANNOUNCE_MD_MAX)}”`] : []),
    `Decided ${new Date(f.decided_at).toISOString().slice(0, 10)}. Decisions can be revisited; this post is updated if one is. [Read the return](${P}/return/${f.return_id})`,
  ];
  return { title, description: lines.join("\n"), url: `${P}/return/${f.return_id}`, color: RUNG_COLOR[f.final_rung ?? ""] ?? 0x757575 };
}

type Row = { id: string; problem_id: string; return_id: string; review_id: string | null; finder_user_id: string; kind: Kind; final_rung: string | null; decided_at: string; due_at: string; status: string; flag: string | null; approved_at: string | null; payload: any; discord_message_id: string | null; sent_at: string | null };

/** Why a return is not (or no longer) announceable, or null with the marking review when it is. The latest decision is the record. */
export async function announceable(returnId: number): Promise<{ why: string } | { ret: any; decision: any; review: any; kind: Kind }> {
  const ret = await one(`SELECT r.*, p.slug FROM returns r JOIN problems p ON p.id = r.problem_id WHERE r.id = $1`, [returnId]);
  if (!ret) return { why: "no such return" };
  if (ret.status !== "accepted" || ret.provisional) return { why: `the return is ${ret.status}${ret.provisional ? " (provisional)" : ""}` };
  const decision = await one(`SELECT * FROM return_decisions WHERE return_id = $1 ORDER BY id DESC LIMIT 1`, [returnId]);
  if (!decision || decision.by !== "trusted" || decision.status !== "accepted" || decision.provisional) return { why: "the latest decision is not a trusted acceptance" };
  const marks = await q(`SELECT rv.id, rv.user_id, rv.announce_md, u.handle FROM reviews rv JOIN users u ON u.id = rv.user_id
    WHERE rv.return_id = $1 AND rv.announce AND rv.trusted AND rv.verdict = 'accept' AND NOT rv.needs_reassessment ORDER BY rv.id`, [returnId]);
  let review = null;
  for (const m of marks) if (await roleOf(Number(ret.problem_id), Number(m.user_id), m.handle)) { review = m; break; }
  if (!review) return { why: "no accepting review by a role-holder marks it" };
  const execution = ret.final_rung === "verified" ? (await verificationState(returnId)).execution : null;
  const kind = candidateKind(ret, execution);
  if (!kind) return { why: `not a candidate kind (${ret.type} at ${ret.final_rung ?? "no rung"})` };
  return { ret, decision, review, kind };
}

/** The finder, joined now, and whether the ledger's result row pays the same person. */
export async function finderOf(returnId: number): Promise<{ user_id: number; handle: string; mismatch: string | null } | null> {
  const r = await one<{ user_id: string; handle: string }>(`SELECT r.user_id, u.handle FROM returns r JOIN users u ON u.id = r.user_id WHERE r.id = $1`, [returnId]);
  if (!r) return null;
  const paid = await q<{ user_id: string }>(`SELECT DISTINCT user_id FROM credits WHERE source_type = 'return' AND source_id = $1 AND kind = 'result'`, [String(returnId)]);
  const mismatch = !paid.length ? "the ledger has no result credit for this return" : paid.some((p) => Number(p.user_id) !== Number(r.user_id)) ? "the ledger's result credit pays someone other than the return's author" : null;
  return { user_id: Number(r.user_id), handle: r.handle, mismatch };
}

async function routeOf(ret: any): Promise<{ id: number; title: string } | null> {
  const r = await one<{ id: string; title: string }>(`SELECT rr.id, rr.title FROM research_routes rr WHERE rr.id = coalesce($1, (SELECT e.route_id FROM research_events e WHERE e.return_id = $2 ORDER BY e.id DESC LIMIT 1))`, [ret.research_route_id ?? null, ret.id]);
  return r ? { id: Number(r.id), title: r.title } : null;
}

/** Outbox rows for every announceable acceptance not yet seen: one per return, ever (dedupe_key). Returns the ids created. */
export async function scan(slugs: string[]): Promise<number[]> {
  if (!slugs.length) return [];
  const made: number[] = [];
  const cands = await q<{ id: string; slug: string }>(`SELECT r.id, p.slug FROM returns r JOIN problems p ON p.id = r.problem_id
    WHERE p.slug = ANY($1) AND r.status = 'accepted' AND NOT r.provisional
      AND EXISTS (SELECT 1 FROM reviews rv WHERE rv.return_id = r.id AND rv.announce AND rv.trusted AND rv.verdict = 'accept' AND NOT rv.needs_reassessment)
      AND NOT EXISTS (SELECT 1 FROM announcements a WHERE a.dedupe_key = 'accept:' || r.id) ORDER BY r.id`, [slugs]);
  for (const c of cands) {
    const a = await announceable(Number(c.id));
    if ("why" in a) continue;
    const cfg = announceConfig(readProjectConfig(c.slug));
    const finder = await finderOf(Number(c.id));
    if (!finder) continue;
    const route = await routeOf(a.ret);
    const flag = omitted(a.review.announce_md, route?.title);
    const decided = new Date(a.decision.decided_at);
    const due = new Date(decided.getTime() + cfg.hold_hours * 3600_000);
    const row = await one<{ id: string }>(`INSERT INTO announcements (problem_id, return_id, review_id, finder_user_id, kind, final_rung, dedupe_key, decided_at, due_at, flag)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [a.ret.problem_id, a.ret.id, a.review.id, finder.user_id, a.kind, a.ret.final_rung, `accept:${a.ret.id}`, decided, due, flag]);
    if (row) made.push(Number(row.id));
  }
  return made;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;
/** The webhook from the environment: https, or http on this machine (a local stub). Anything else is treated as unset. */
export function webhookUrl(cfg: AnnounceConfig, env: Record<string, string | undefined> = process.env): URL | null {
  const raw = String(env[cfg.webhook_env] ?? "").trim(); if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) ? u : null; } catch { return null; }
}
const withPath = (u: URL, extra: string, wait: boolean): string => { const x = new URL(u.toString()); x.pathname = x.pathname.replace(/\/$/, "") + extra; if (wait) x.searchParams.set("wait", "true"); return x.toString(); };
async function send(fetchImpl: Fetch, url: string, method: string, body: any): Promise<any> {
  const r = await fetchImpl(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`webhook ${method} answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return method === "POST" ? r.json() : null;
}

/** Agent-written text that overclaims is left out of the post, never reworded by a model and never held for a person: the template lines
 *  carry the record on their own. Returns what was left out and why, for the row (null when nothing was). */
export function omitted(note: string | null | undefined, routeTitle: string | null | undefined): string | null {
  const parts = [overclaim(note) ? `validator's note left out (${overclaim(note)})` : null, overclaim(routeTitle) ? `route title left out (${overclaim(routeTitle)})` : null].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

const unsetLogged = new Map<string, number>();
export type DispatchResult = { sent: number[]; suppressed: number[]; corrected: number[]; waiting: Record<string, string> };
/** One pass for one project: settle held rows (suppress, wait, send) and correct sent ones. Safe to run from two containers: every send claims its row first. */
export async function dispatch(slug: string, opts: { now?: Date; fetchImpl?: Fetch; env?: Record<string, string | undefined>; base?: string } = {}): Promise<DispatchResult> {
  const now = opts.now ?? new Date(); const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as Fetch);
  const base = (opts.base ?? process.env.BASE_URL ?? "https://solveathome.org").replace(/\/$/, "");
  const out: DispatchResult = { sent: [], suppressed: [], corrected: [], waiting: {} };
  const cfg = announceConfig(readProjectConfig(slug));
  const p = await one<{ id: string }>(`SELECT id FROM problems WHERE slug = $1`, [slug]); if (!p) return out;
  const pid = Number(p.id);
  const hook = webhookUrl(cfg, opts.env ?? process.env);

  // Sent rows whose acceptance changed: edit the post, then say so after it. Not rate-limited: a correction always goes out.
  for (const s of await q<Row>(`SELECT * FROM announcements WHERE problem_id = $1 AND status = 'sent' ORDER BY id`, [pid])) {
    const ret = await one(`SELECT status, final_rung, provisional FROM returns WHERE id = $1`, [s.return_id]);
    if (ret && ret.status === "accepted" && !ret.provisional && ret.final_rung === s.final_rung) continue;
    if (!hook || !s.discord_message_id) { out.waiting[s.id] = !hook ? "correction due; webhook unset" : "correction due; no message id to edit"; continue; }
    const now_ = ret ? `${ret.status}${ret.provisional ? " (provisional)" : ""}${ret.status === "accepted" && ret.final_rung ? ` at ${cap(ret.final_rung)}` : ""}` : "gone";
    const day = now.toISOString().slice(0, 10);
    const note = `Revisited ${day}: return #${s.return_id} is now ${now_}.`;
    const claimed = await one(`UPDATE announcements SET status = 'corrected', corrected_at = $2, correction = $3 WHERE id = $1 AND status = 'sent' RETURNING id`, [s.id, now, note]);
    if (!claimed) continue;
    try {
      const e = s.payload?.embeds?.[0] ?? {};
      const handle = e.finder_handle ?? s.payload?.finder_handle ?? "";
      await send(fetchImpl, withPath(hook, `/messages/${s.discord_message_id}`, false), "PATCH", { embeds: [{ ...stripMeta(e), title: `[Revisited] ${String(e.title ?? "").slice(0, 240)}`, description: `**${note}** The post below no longer stands.${handle ? ` The finding was @${handle}'s.` : ""}\n\n~~${String(e.description ?? "").replace(/~~/g, "")}~~`.slice(0, 4000), color: 0x757575 }] });
      await send(fetchImpl, withPath(hook, "", true), "POST", { content: `Correction: ${note} The post about it no longer stands. <${base}/projects/${slug}/return/${s.return_id}>` });
      out.corrected.push(Number(s.id));
    } catch (e: any) {
      await q(`UPDATE announcements SET status = 'sent', corrected_at = NULL, correction = NULL WHERE id = $1`, [s.id]);
      console.error(`announce ${slug}: correction of #${s.id} failed, will retry:`, e?.message ?? e);
    }
  }

  const held = await q<Row>(`SELECT * FROM announcements WHERE problem_id = $1 AND status = 'held' ORDER BY due_at, id`, [pid]);
  const burst = await one<{ n: string }>(`SELECT count(*) AS n FROM announcements WHERE problem_id = $1 AND created_at > $2::timestamptz - interval '1 hour'`, [pid, now]);
  const paused = Number(burst?.n ?? 0) > cfg.burst_per_hour;
  if (paused) console.error(`announce ${slug}: ${burst!.n} rows queued in the last hour (more than ${cfg.burst_per_hour}): sending paused; look at /projects/${slug}/announcements`);
  for (const h of held) {
    const a = await announceable(Number(h.return_id));
    if ("why" in a || a.kind !== h.kind || a.ret.final_rung !== h.final_rung) {
      const why = "why" in a ? a.why : `the record changed (${a.kind} at ${a.ret.final_rung})`;
      await q(`UPDATE announcements SET status = 'suppressed', suppressed_reason = $2 WHERE id = $1 AND status = 'held'`, [h.id, `before posting: ${why}`]);
      out.suppressed.push(Number(h.id)); continue;
    }
    if (new Date(h.due_at) > now) { out.waiting[h.id] = `hold until ${new Date(h.due_at).toISOString()}`; continue; }
    // Credit never drifts: a post that cannot name the one person the ledger pays for this return is skipped, with the reason on the row.
    const finder = await finderOf(Number(h.return_id));
    const creditProblem = !finder ? "the return's author is gone" : finder.user_id !== Number(h.finder_user_id) ? "the return's author changed since the row was made" : finder.mismatch;
    if (!finder || creditProblem) {
      await q(`UPDATE announcements SET status = 'suppressed', suppressed_reason = $2 WHERE id = $1 AND status = 'held'`, [h.id, `skipped: ${creditProblem}`]);
      out.suppressed.push(Number(h.id)); continue;
    }
    if (cfg.approval && !h.approved_at) { out.waiting[h.id] = "waiting for an owner's approval"; continue; }
    if (paused) { out.waiting[h.id] = "burst guard"; continue; }
    if (!hook) {
      out.waiting[h.id] = `${cfg.webhook_env} is unset`;
      if (unsetLogged.get(slug) !== held.length) { unsetLogged.set(slug, held.length); console.log(`announce ${slug}: a post is due but ${cfg.webhook_env} is unset (or not https); nothing sent`); }
      continue;
    }
    const day = await one<{ n: string }>(`SELECT count(*) AS n FROM announcements WHERE problem_id = $1 AND sent_at > $2::timestamptz - interval '24 hours'`, [pid, now]);
    if (Number(day?.n ?? 0) >= cfg.max_per_day) { out.waiting[h.id] = `daily limit (${cfg.max_per_day})`; continue; }
    const route = await routeOf(a.ret);
    const note = overclaim(a.review.announce_md) ? null : a.review.announce_md;
    const shownRoute = route && overclaim(route.title) ? { id: route.id, title: "" } : route;
    const left = omitted(a.review.announce_md, route?.title);
    if (left !== h.flag) await q(`UPDATE announcements SET flag = $2 WHERE id = $1`, [h.id, left]);
    if (route && cfg.route_cooldown_hours > 0) {
      const recent = await one(`SELECT 1 FROM announcements a JOIN returns r ON r.id = a.return_id WHERE a.problem_id = $1 AND a.sent_at > $2::timestamptz - make_interval(secs => $3) AND coalesce(r.research_route_id, (SELECT e.route_id FROM research_events e WHERE e.return_id = r.id ORDER BY e.id DESC LIMIT 1)) = $4`, [pid, now, cfg.route_cooldown_hours * 3600, route.id]);
      if (recent) { out.waiting[h.id] = `route #${route.id} was announced in the last ${cfg.route_cooldown_hours} h`; continue; }
    }
    const target = a.ret.target?.kind === "return" && Number.isInteger(Number(a.ret.target.ref)) ? Number(a.ret.target.ref) : null;
    const post = buildPost({ kind: a.kind, final_rung: a.ret.final_rung, return_id: Number(a.ret.id), type: a.ret.type, handle: finder.handle, slug, base, decided_at: h.decided_at, route: shownRoute, target_return_id: target, note });
    const payload = { embeds: [{ ...post, finder_handle: finder.handle }] };
    const claimed = await one(`UPDATE announcements SET status = 'sent', sent_at = $2, payload = $3 WHERE id = $1 AND status = 'held' RETURNING id`, [h.id, now, JSON.stringify(payload)]);
    if (!claimed) continue;
    try {
      const msg = await send(fetchImpl, withPath(hook, "", true), "POST", { embeds: [post] });
      await q(`UPDATE announcements SET discord_message_id = $2 WHERE id = $1`, [h.id, msg?.id ? String(msg.id) : null]);
      out.sent.push(Number(h.id));
    } catch (e: any) {
      await q(`UPDATE announcements SET status = 'held', sent_at = NULL, payload = NULL WHERE id = $1`, [h.id]);
      out.waiting[h.id] = `send failed: ${e?.message ?? e}`;
      console.error(`announce ${slug}: send of #${h.id} failed, will retry:`, e?.message ?? e);
    }
  }
  return out;
}
const stripMeta = (e: any) => { const { finder_handle: _f, ...rest } = e ?? {}; return rest; };

/** Owner decisions on a held row, from the approve page. */
export async function approve(id: number, problemId: number, userId: number): Promise<boolean> {
  return !!(await one(`UPDATE announcements SET approved_at = now(), approved_by = $3 WHERE id = $1 AND problem_id = $2 AND status = 'held' RETURNING id`, [id, problemId, userId]));
}
export async function suppress(id: number, problemId: number, handle: string, reason: string): Promise<boolean> {
  return !!(await one(`UPDATE announcements SET status = 'suppressed', suppressed_reason = $3 WHERE id = $1 AND problem_id = $2 AND status = 'held' RETURNING id`, [id, problemId, `by @${handle}: ${reason || "no reason given"}`.slice(0, 500)]));
}

/** The projects that announce: project.json says so. */
export const announcingSlugs = (): string[] => listProjectConfigs().filter((c) => announceConfig(c).discord).map((c) => c.slug);
let running = false;
/** The periodic pass (server.ts): scan, then dispatch per project. The kill switch stops both. */
export async function announceTick(): Promise<void> {
  if (running || !announceEnabled()) return;
  running = true;
  try {
    const slugs = announcingSlugs();
    await scan(slugs);
    for (const s of slugs) await dispatch(s);
  } finally { running = false; }
}
