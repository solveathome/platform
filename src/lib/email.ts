/**
 * Progress emails (#sah-progress-emails, approved 3 Oct 2026): the person's address, their three choices, the consent log and the signed links.
 *
 * The address is personal data. It is set and read only by the person, signed in on the site (never by an agent, never in the dump), and
 * nothing is sent to it until GitHub vouched for it or its confirmation link was clicked. The choices are: updates (daily | weekly | off,
 * daily by default: news about the person's own work), the monthly letter and new projects (both off until ticked: marketing needs consent).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { q, one } from "../db/index.js";

export const EMAIL_WORDING_VERSION = "2026-10-03";
/** The privacy line on the email step and in /settings, as the client approved it (3 Oct 2026). */
export const PRIVACY_LINE = "We store this address only to send you the emails you choose here. It is never published, never in the open dataset, and never shown to an agent. Change or delete it any time at /settings.";

export type Updates = "daily" | "weekly" | "off";
export type Prefs = { updates: Updates; newsletter: boolean; projects: boolean };
export const DEFAULT_PREFS: Prefs = { updates: "daily", newsletter: false, projects: false };

let warned = false;
const fallbackSecret = randomBytes(32).toString("hex");
/** The key that signs confirmation and unsubscribe links. Without EMAIL_LINK_SECRET (a dev checkout) links work until the process restarts. */
function secret(): string {
  const s = process.env.EMAIL_LINK_SECRET;
  if (s) return s;
  if (!warned) { console.warn("EMAIL_LINK_SECRET is not set: email links are signed with a per-process key"); warned = true; }
  return fallbackSecret;
}
const mac = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url").slice(0, 32);

/** A signed, URL-safe token for `parts`. Nothing is stored: the signature is the proof. */
export function sign(parts: Array<string | number>): string {
  const payload = Buffer.from(parts.map(String).join("\n")).toString("base64url");
  return `${payload}.${mac(payload)}`;
}
export function verify(token: string): string[] | null {
  const [payload, sig] = String(token ?? "").split(".");
  if (!payload || !sig || sig.length !== 32) return null;
  const want = Buffer.from(mac(payload)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return Buffer.from(payload, "base64url").toString("utf8").split("\n");
}

/** The one-click unsubscribe actions an email can carry. */
export const UNSUB_ACTIONS = ["weekly", "updates-off", "newsletter-off", "projects-off", "all-off"] as const;
export type UnsubAction = typeof UNSUB_ACTIONS[number];
export const unsubToken = (userId: number, action: UnsubAction) => sign(["u", userId, action]);
export function readUnsub(token: string): { userId: number; action: UnsubAction } | null {
  const p = verify(token);
  if (!p || p[0] !== "u" || !/^\d+$/.test(p[1] ?? "") || !(UNSUB_ACTIONS as readonly string[]).includes(p[2])) return null;
  return { userId: Number(p[1]), action: p[2] as UnsubAction };
}
const CONFIRM_HOURS = 48;
export const confirmToken = (userId: number, email: string, now = Date.now()) => sign(["c", userId, email, now + CONFIRM_HOURS * 3600_000]);
export function readConfirm(token: string, now = Date.now()): { userId: number; email: string } | null {
  const p = verify(token);
  if (!p || p[0] !== "c" || !/^\d+$/.test(p[1] ?? "") || !p[2] || Number(p[3]) < now) return null;
  return { userId: Number(p[1]), email: p[2] };
}

/** A plausible address, normalised. Deliverability is what the confirmation link and the bounce webhook find out. */
export function cleanEmail(raw: unknown): string | null {
  const e = String(raw ?? "").trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@<>()",;:\\[\]]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return null;
  if (/@users\.noreply\.github\.com$/.test(e)) return null;   // GitHub's relay goes nowhere a person reads
  return e;
}
export function cleanTz(raw: unknown): string | null {
  const tz = String(raw ?? "").trim();
  if (!tz || tz.length > 64) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch { return null; }
}

/** GitHub's verified primary address (scope user:email), or null. The noreply relay is never offered. */
export function pickGithubEmail(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  const ok = list.filter((e: any) => e && e.verified === true && cleanEmail(e.email));
  const pick = ok.find((e: any) => e.primary) ?? ok[0];
  return pick ? cleanEmail(pick.email) : null;
}

export async function prefsOf(userId: number): Promise<Prefs> {
  const r = await one<Prefs>(`SELECT updates, newsletter, projects FROM email_preferences WHERE user_id = $1`, [userId]);
  return r ? { updates: r.updates, newsletter: !!r.newsletter, projects: !!r.projects } : { ...DEFAULT_PREFS };
}

async function logConsent(userId: number, choice: string, value: string, source: string): Promise<void> {
  await q(`INSERT INTO email_consent_events (user_id, choice, value, source, wording_version) VALUES ($1,$2,$3,$4,$5)`, [userId, choice, value, source, EMAIL_WORDING_VERSION]);
}

/** Change any of the three choices; each change that differs is written to the consent log. */
export async function setPrefs(userId: number, next: Partial<Prefs>, source: string): Promise<Prefs> {
  const cur = await prefsOf(userId);
  const merged: Prefs = {
    updates: next.updates && ["daily", "weekly", "off"].includes(next.updates) ? next.updates : cur.updates,
    newsletter: typeof next.newsletter === "boolean" ? next.newsletter : cur.newsletter,
    projects: typeof next.projects === "boolean" ? next.projects : cur.projects,
  };
  await q(`INSERT INTO email_preferences (user_id, updates, newsletter, projects) VALUES ($1,$2,$3,$4)
    ON CONFLICT (user_id) DO UPDATE SET updates = EXCLUDED.updates, newsletter = EXCLUDED.newsletter, projects = EXCLUDED.projects, updated_at = now()`,
    [userId, merged.updates, merged.newsletter, merged.projects]);
  for (const k of ["updates", "newsletter", "projects"] as const) if (merged[k] !== cur[k] || source === "welcome") await logConsent(userId, k, String(merged[k]), source);
  return merged;
}

export type AddressState = { email: string | null; source: string | null; confirmed: boolean; status: string | null; tz: string | null };
export async function addressOf(userId: number): Promise<AddressState> {
  const u = await one<any>(`SELECT email, email_source, email_confirmed_at, email_status, email_tz FROM users WHERE id = $1`, [userId]);
  return { email: u?.email ?? null, source: u?.email_source ?? null, confirmed: !!u?.email_confirmed_at, status: u?.email_status ?? null, tz: u?.email_tz ?? null };
}

/**
 * Save the address. The one GitHub verified at this sign-in is confirmed at once; any other waits for its link (returned as `confirm`
 * so the route can send it). Saving the same address again changes nothing.
 */
export async function setAddress(userId: number, email: string, githubVerified: string | null, source: string): Promise<{ changed: boolean; needsConfirm: boolean }> {
  const cur = await addressOf(userId);
  const fromGithub = !!githubVerified && email === githubVerified;
  if (cur.email === email && (cur.confirmed || !fromGithub)) return { changed: false, needsConfirm: !cur.confirmed };
  await q(`UPDATE users SET email = $2, email_source = $3, email_confirmed_at = $4, email_status = NULL WHERE id = $1`,
    [userId, email, fromGithub ? "github_verified" : "typed", fromGithub ? new Date() : null]);
  await logConsent(userId, "address", fromGithub ? "github_verified" : "typed", source);
  return { changed: true, needsConfirm: !fromGithub };
}

export async function confirmAddress(userId: number, email: string): Promise<boolean> {
  const r = await one(`UPDATE users SET email_confirmed_at = now(), email_status = NULL WHERE id = $1 AND email = $2 AND email_confirmed_at IS NULL RETURNING id`, [userId, email]);
  if (r) await logConsent(userId, "address", "confirmed", "confirm");
  return !!r;
}

/** Delete the address and everything waiting to be sent. The consent log keeps only the events. */
export async function deleteAddress(userId: number, source: string): Promise<void> {
  await q(`UPDATE users SET email = NULL, email_source = NULL, email_confirmed_at = NULL, email_status = NULL WHERE id = $1`, [userId]);
  await q(`DELETE FROM email_items WHERE user_id = $1 AND email_id IS NULL`, [userId]);
  await q(`DELETE FROM email_outbox WHERE user_id = $1 AND status = 'queued'`, [userId]);
  await logConsent(userId, "address", "deleted", source);
}

export async function applyUnsub(userId: number, action: UnsubAction): Promise<Prefs> {
  const next: Partial<Prefs> = action === "weekly" ? { updates: "weekly" } : action === "updates-off" ? { updates: "off" }
    : action === "newsletter-off" ? { newsletter: false } : action === "projects-off" ? { projects: false } : { updates: "off", newsletter: false, projects: false };
  return setPrefs(userId, next, "unsubscribe");
}

/**
 * Should the site ask for an address? Never once one is saved; at most twice in all: the first time at sign-in, the second only after
 * the person's agent made a return since the first ask ("Your agent just made its first return. Want to hear the verdict?").
 */
export async function shouldPrompt(userId: number): Promise<boolean> {
  const u = await one<any>(`SELECT email, email_prompts, email_prompted_at,
      EXISTS (SELECT 1 FROM returns r WHERE r.user_id = users.id AND (users.email_prompted_at IS NULL OR r.created_at > users.email_prompted_at)) AS returned
    FROM users WHERE id = $1`, [userId]);
  if (!u || u.email) return false;
  const n = Number(u.email_prompts ?? 0);
  return n === 0 || (n === 1 && !!u.returned);
}
export async function markPrompted(userId: number): Promise<void> {
  await q(`UPDATE users SET email_prompts = email_prompts + 1, email_prompted_at = now() WHERE id = $1`, [userId]);
}
