/**
 * Display names (Chris, Sep 17 2026). A person may add a name that is shown beside their GitHub handle where they are credited.
 * The handle stays the identity: URLs, sign-in, the ledger and the open dataset never carry the name.
 * The name lives in one cell (users.display_name) and is joined in at render time, never copied into a record,
 * so clearing the cell withdraws it from every page. display_name_events logs set/clear/remove/lock without the name text.
 */
import { one, q, transaction } from "../db/index.js";

export const NAME_MIN = 2;
export const NAME_MAX = 40;
export const CHANGES_PER_WINDOW = 3;
export const WINDOW_DAYS = 30;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Words that would read as a role or a check the site never made. Whole words, any case. */
const RESERVED = ["verified", "official", "admin", "administrator", "staff", "moderator", "owner", "trusted", "reviewer", "solveathome"];
const SCRIPTS = ["Latin", "Cyrillic", "Greek", "Armenian", "Hebrew", "Arabic", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Tamil", "Telugu", "Kannada", "Malayalam", "Thai", "Georgian", "Hangul", "Hiragana", "Katakana", "Han", "Ethiopic", "Khmer", "Sinhala", "Myanmar"];
const SCRIPT_RE = SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, "u")] as const);
/** Scripts that are written together in one name. */
const MIXES = [new Set(["Han", "Hiragana", "Katakana"]), new Set(["Han", "Hangul"])];

/** NFC, trimmed, inner whitespace collapsed to single spaces. */
export function normalizeName(raw: unknown): string {
  return String(raw ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** Why a name is refused, in words the settings page shows as they are; null when it is fine. Pure: no database. */
export function nameProblem(raw: unknown): string | null {
  const name = normalizeName(raw);
  const length = [...name].length;
  if (length < NAME_MIN) return `A display name is at least ${NAME_MIN} characters.`;
  if (length > NAME_MAX) return `A display name is at most ${NAME_MAX} characters. This one is ${length}.`;
  if (!/^[\p{L}\p{M}\p{N} .'’-]+$/u.test(name)) return "Letters, digits, spaces, full stops, apostrophes and hyphens only. No @, brackets, slashes, emoji or links.";
  if (!/^\p{L}/u.test(name)) return "A display name starts with a letter.";
  if (/[.'’-]{2}/u.test(name)) return "Two punctuation marks in a row are not allowed.";
  const scripts = new Set<string>();
  for (const ch of name) { if (!/\p{L}/u.test(ch)) continue; scripts.add(SCRIPT_RE.find(([, re]) => re.test(ch))?.[0] ?? "other"); }
  if (scripts.size > 1 && !MIXES.some((mix) => [...scripts].every((s) => mix.has(s)))) return "Letters from one alphabet only. Mixed alphabets can make one name look like another.";
  const words = name.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  const reserved = RESERVED.find((w) => words.includes(w));
  if (reserved) return `"${reserved}" cannot be part of a display name: nothing about a name is checked here, and the word would suggest otherwise.`;
  return null;
}

export type NameStatus = { handle: string; display_name: string | null; locked: boolean; lock_note: string | null; removed_note: string | null; changes_used: number; changes_allowed: number; window_days: number; next_change_at: string | null };

async function lockOf(userId: number): Promise<{ locked: boolean; note: string | null }> {
  const last = await one<{ action: string; note: string | null }>(`SELECT action, note FROM display_name_events WHERE user_id = $1 AND action IN ('lock','unlock') ORDER BY id DESC LIMIT 1`, [userId]);
  return { locked: last?.action === "lock", note: last?.action === "lock" ? last.note : null };
}

export async function nameStatus(userId: number): Promise<NameStatus> {
  const u = await one<{ handle: string; display_name: string | null }>(`SELECT handle, display_name FROM users WHERE id = $1`, [userId]);
  const sets = await q<{ created_at: string }>(`SELECT created_at FROM display_name_events WHERE user_id = $1 AND action = 'set' AND by_user_id = $1 AND created_at > now() - make_interval(days => $2) ORDER BY created_at`, [userId, WINDOW_DAYS]);
  const lock = await lockOf(userId);
  // An owner's removal is shown to the person until they set or clear a name themselves.
  const last = await one<{ action: string; note: string | null }>(`SELECT action, note FROM display_name_events WHERE user_id = $1 AND action IN ('set','clear','remove') ORDER BY id DESC LIMIT 1`, [userId]);
  const full = sets.length >= CHANGES_PER_WINDOW;
  return { handle: u!.handle, display_name: u!.display_name ?? null, locked: lock.locked, lock_note: lock.note, removed_note: last?.action === "remove" ? last.note : null, changes_used: sets.length, changes_allowed: CHANGES_PER_WINDOW, window_days: WINDOW_DAYS,
    next_change_at: full ? new Date(new Date(sets[sets.length - CHANGES_PER_WINDOW].created_at).getTime() + WINDOW_DAYS * 86400_000).toISOString() : null };
}

export class NameRefused extends Error { constructor(message: string, public status = 400, public code = "invalid_name") { super(message); } }

/** The person sets their own name. Serialised per user so two tabs cannot both take the last change of the window. */
export async function setName(userId: number, raw: unknown): Promise<NameStatus> {
  const name = normalizeName(raw);
  const problem = nameProblem(name);
  if (problem) throw new NameRefused(problem);
  await transaction(async () => {
    await q(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`display-name:${userId}`]);
    const st = await nameStatus(userId);
    if (st.locked) throw new NameRefused("The display name on this account was removed by the site owner and cannot be set again. Write to chris@lol.dk if that is a mistake.", 403, "locked");
    if (st.display_name === name) return;
    if (st.changes_used >= CHANGES_PER_WINDOW) throw new NameRefused(`A display name can change ${CHANGES_PER_WINDOW} times in ${WINDOW_DAYS} days. The next change is possible on ${st.next_change_at!.slice(0, 10)}. Clearing it is always possible.`, 429, "rate_limited");
    const taken = await one(`SELECT 1 FROM users WHERE id <> $1 AND lower(handle) = lower($2)`, [userId, name.replace(/ /g, "")]) ?? await one(`SELECT 1 FROM users WHERE id <> $1 AND lower(handle) = lower($2)`, [userId, name.replace(/ /g, "-")]);
    if (taken) throw new NameRefused("That is another contributor's handle.", 400, "is_a_handle");
    await q(`UPDATE users SET display_name = $2 WHERE id = $1`, [userId, name]);
    await q(`INSERT INTO display_name_events (user_id, action, by_user_id) VALUES ($1, 'set', $1)`, [userId]);
  });
  forgetNames();
  return nameStatus(userId);
}

/** Clearing is never limited and never counted. */
export async function clearName(userId: number): Promise<NameStatus> {
  await transaction(async () => {
    const had = await one(`UPDATE users SET display_name = NULL WHERE id = $1 AND display_name IS NOT NULL RETURNING id`, [userId]);
    if (had) await q(`INSERT INTO display_name_events (user_id, action, by_user_id) VALUES ($1, 'clear', $1)`, [userId]);
  });
  forgetNames();
  return nameStatus(userId);
}

/** An owner removes a name, with a note the person sees on their settings page; `lock` stops the account from setting one again. The removed name is not kept. */
export async function removeName(userId: number, byUserId: number, note: string, lock: boolean): Promise<void> {
  await transaction(async () => {
    await q(`UPDATE users SET display_name = NULL WHERE id = $1`, [userId]);
    await q(`INSERT INTO display_name_events (user_id, action, by_user_id, note) VALUES ($1, 'remove', $2, $3)`, [userId, byUserId, note]);
    if (lock) await q(`INSERT INTO display_name_events (user_id, action, by_user_id, note) VALUES ($1, 'lock', $2, $3)`, [userId, byUserId, note]);
  });
  forgetNames();
}
export async function unlockName(userId: number, byUserId: number, note: string): Promise<void> {
  await q(`INSERT INTO display_name_events (user_id, action, by_user_id, note) VALUES ($1, 'unlock', $2, $3)`, [userId, byUserId, note]);
}

/**
 * The one way a credited person is written in server-rendered HTML: "Name @handle" inside one link, or "@handle" alone.
 * The handle is always there, so a chosen name never stands in for the identity.
 */
export function creditHtml(p: { handle: string; display_name?: string | null }): string {
  const h = esc(p.handle);
  return p.display_name
    ? `<a class="credit" href="/@${h}" title="Name chosen by @${h}. Names are not checked."><span class="credit-name">${esc(p.display_name)}</span> <span class="credit-handle">@${h}</span></a>`
    : `<a class="credit" href="/@${h}">@${h}</a>`;
}
/** The same in plain text, for titles and descriptions. */
export function creditText(p: { handle: string; display_name?: string | null }): string {
  return p.display_name ? `${p.display_name} (@${p.handle})` : `@${p.handle}`;
}

let names: { at: number; map: Map<string, string> } = { at: 0, map: new Map() };
export function forgetNames(): void { names.at = 0; }
/** handle (lower case) -> display name, for records that store handles only (document versions' verified_by). Cached 30 s; few people set a name. */
export async function nameMap(): Promise<Map<string, string>> {
  if (Date.now() - names.at > 30_000) {
    const rows = await q<{ handle: string; display_name: string }>(`SELECT handle, display_name FROM users WHERE display_name IS NOT NULL`);
    names = { at: Date.now(), map: new Map(rows.map((r) => [r.handle.toLowerCase(), r.display_name])) };
  }
  return names.map;
}
export async function creditByHandle(handle: string): Promise<string> {
  return creditHtml({ handle, display_name: (await nameMap()).get(String(handle).toLowerCase()) ?? null });
}
/** For a page that credits several handles: load the names once, then credit synchronously. */
export async function crediter(): Promise<(handle: string) => string> {
  const map = await nameMap();
  return (handle) => creditHtml({ handle, display_name: map.get(String(handle).toLowerCase()) ?? null });
}
