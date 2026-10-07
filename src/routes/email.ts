/**
 * Progress emails on the site (#sah-progress-emails): the email step after sign-in (/welcome), the person's own address and choices
 * (/me/email, also shown in /settings), the confirmation link, one-click unsubscribe, Postmark's bounce and complaint webhook, the
 * person's own preview of today's email, and the owner's letters.
 *
 * Only the person, signed in on the site, sets or reads their address: a bearer token (an agent) is refused on every route here, the
 * same rule as the display name. Nothing on this router hands an address to anyone else.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { q, one } from "../db/index.js";
import { optionalAuth, cookieToken, hashToken } from "../lib/auth.js";
import { PUBLIC_DIR } from "../lib/paths.js";
import { hit } from "../lib/ratelimit.js";
import * as E from "../lib/email.js";
import { preview } from "../lib/email-update.js";
import { send } from "../lib/postmark.js";
import * as tpl from "../lib/email-template.js";

export const email = Router();
const BASE = () => (process.env.BASE_URL ?? "http://localhost:8600").replace(/\/+$/, "");
const OWNER_SET = () => new Set((process.env.OWNER_HANDLES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const safeNext = (n: unknown) => { const s = String(n ?? ""); return /^\/(?!\/)[^\s]*$/.test(s) && !s.startsWith("/welcome") ? s : "/"; };

/** A person on the site, never an agent: browser session cookie, no bearer header, same origin for writes. */
function personOnSite(req: Request, res: Response, write: boolean): boolean {
  if (!req.user) { res.status(401).json({ error: "Sign in first." }); return false; }
  if ((req.header("authorization") ?? "").startsWith("Bearer ") || !cookieToken(req).startsWith("sahweb_")) { res.status(403).json({ error: "Your email address is set by you, signed in on the site. An agent cannot read or set it." }); return false; }
  const site = req.header("sec-fetch-site");
  if (write && site && site !== "same-origin") { res.status(403).json({ error: "Change this on the site itself." }); return false; }
  if (write && hit(`email:${req.user.id}`, 20, 60_000).over) { res.status(429).json({ error: "Too many tries. Wait a minute." }); return false; }
  return true;
}

/** The verified address GitHub gave this browser's sign-in, if any (held on the session row until the person saves it). */
async function githubOffer(req: Request): Promise<string | null> {
  const raw = cookieToken(req);
  if (!raw.startsWith("sahweb_")) return null;
  return (await one<{ github_email: string | null }>(`SELECT github_email FROM browser_sessions WHERE token_hash = $1`, [hashToken(raw)]))?.github_email ?? null;
}

async function state(req: Request) {
  const id = req.user!.id;
  const [addr, prefs, offer, prompt] = await Promise.all([E.addressOf(id), E.prefsOf(id), githubOffer(req), E.shouldPrompt(id)]);
  return { handle: req.user!.handle, email: addr.email, confirmed: addr.confirmed, source: addr.source, status: addr.status, offered: addr.email ? null : offer, prefs, prompt, privacy: E.PRIVACY_LINE };
}

async function sendConfirmation(userId: number, address: string): Promise<{ sent: boolean; reason?: string }> {
  if (hit(`email-confirm:${userId}`, 5, 3600_000).over) return { sent: false, reason: "Five confirmation emails in an hour is the limit. Try again later." };
  const link = `${BASE()}/email/confirm?t=${encodeURIComponent(E.confirmToken(userId, address))}`;
  const text = `Confirm this address for solveathome updates:\n${link}\n\nThe link works for 48 hours. If you did not ask for this, ignore it: nothing is sent to an address until it is confirmed.`;
  const html = tpl.shell({ title: "Confirm your email", preheader: "One click and your agent's results start arriving.", eyebrow: "Confirm your email", footerWhy: "You get this because this address was typed on solveathome.org. If that was not you, ignore it.", footerLinks: [[`${BASE()}/settings#email`, "Email settings"]],
    body: tpl.hero({ eyebrow: "One click", head: "Confirm this address for your solveathome updates", why: "The link works for 48 hours. Nothing is sent to an address until it is confirmed, and you never get more than one email a day.", href: link, cta: "Confirm my address" }) });
  // The one email outside the one-a-day cap (decision 11): the person asked for it a second ago, and it carries nothing else.
  const r = await send({ to: address, subject: "Confirm your email for solveathome", text, html, stream: "transactional", tag: "confirm" });
  if (!r.ok) console.log(`email: confirmation for user ${userId} not sent (${r.reason})${process.env.POSTMARK_SERVER_TOKEN ? "" : `; dev link: ${link}`}`);
  return r.ok ? { sent: true } : { sent: false, reason: r.reason };
}

/** GET /welcome : the email step, right after the terms at sign-in. */
email.get("/welcome", optionalAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!req.user) { res.redirect(`/auth/github?next=${encodeURIComponent(req.originalUrl)}`); return; }
  const addr = await E.addressOf(req.user.id);
  if (addr.email) { res.redirect(safeNext(req.query.next)); return; }
  await E.markPrompted(req.user.id);
  res.type("text/html").send(readFileSync(join(PUBLIC_DIR, "welcome.html"), "utf8").replaceAll("__PRIVACY__", esc(E.PRIVACY_LINE)));
});

/** GET /me/email : the signed-in person's address, choices, and the GitHub address on offer. */
email.get("/me/email", optionalAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!personOnSite(req, res, false)) return;
  res.json(await state(req));
});

/** POST /me/email { email?, updates?, newsletter?, projects?, tz?, from } : save the address and/or the choices. */
email.post("/me/email", optionalAuth, async (req, res) => {
  if (!personOnSite(req, res, true)) return;
  const id = req.user!.id, b = req.body ?? {};
  const source = b.from === "welcome" ? "welcome" : "settings";
  let confirm: { sent: boolean; reason?: string } | null = null;
  if (b.email !== undefined) {
    const address = E.cleanEmail(b.email);
    if (!address) { res.status(400).json({ error: "That does not look like an email address you can receive mail at." }); return; }
    const r = await E.setAddress(id, address, await githubOffer(req), source);
    if (r.changed && r.needsConfirm) confirm = await sendConfirmation(id, address);
  }
  const tz = E.cleanTz(b.tz);
  if (tz) await q(`UPDATE users SET email_tz = $2 WHERE id = $1`, [id, tz]);
  const next: Partial<E.Prefs> = {};
  if (["daily", "weekly", "off"].includes(b.updates)) next.updates = b.updates;
  if (typeof b.newsletter === "boolean") next.newsletter = b.newsletter;
  if (typeof b.projects === "boolean") next.projects = b.projects;
  if (Object.keys(next).length || source === "welcome") await E.setPrefs(id, next, source);
  res.json({ ...(await state(req)), confirmation: confirm });
});

/** POST /me/email/confirm-again : send the confirmation link again. */
email.post("/me/email/confirm-again", optionalAuth, async (req, res) => {
  if (!personOnSite(req, res, true)) return;
  const a = await E.addressOf(req.user!.id);
  if (!a.email || a.confirmed) { res.status(400).json({ error: "There is no address waiting for confirmation." }); return; }
  res.json({ confirmation: await sendConfirmation(req.user!.id, a.email) });
});

/** POST /me/email/dismiss : "Not now". Counts as one of the two times the site asks. */
email.post("/me/email/dismiss", optionalAuth, async (req, res) => {
  if (!personOnSite(req, res, true)) return;
  await E.markPrompted(req.user!.id);
  res.json({ ok: true });
});

/** DELETE /me/email : delete the address and everything waiting to be sent to it. */
email.delete("/me/email", optionalAuth, async (req, res) => {
  if (!personOnSite(req, res, true)) return;
  await E.deleteAddress(req.user!.id, "settings");
  res.json(await state(req));
});

/** GET /me/email/preview : what today's email to you would say, if one were due now. Nothing is stored or sent. ?weekday=1 shows Monday's. */
email.get("/me/email/preview", optionalAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!personOnSite(req, res, false)) return;
  const wd = /^[1-7]$/.test(String(req.query.weekday ?? "")) ? Number(req.query.weekday) : undefined;
  const p = await preview(req.user!.id, wd);
  if (!p) { res.type("text/html").send(`<!doctype html><meta charset="utf-8"><title>No email today</title><body style="font:15px/1.5 sans-serif;max-width:600px;margin:40px auto"><p><b>No email would go out right now.</b> Nothing new happened to your work since your last email, and an update is only sent on a day with news${wd === 1 ? " (or, on Mondays, a week with activity)" : ""}.</p><p><a href="/settings#email">Back to settings</a></p></body>`); return; }
  res.type("text/html").send(p.html.replace(/<body([^>]*)>/, (m) => `${m}<p style="max-width:600px;margin:0 auto;padding:18px 16px 0;font:13px/1.5 -apple-system,Helvetica,Arial,sans-serif;color:#6a6963">Preview, not sent. Subject: <b>${esc(p.subject)}</b></p>`));
});

/** GET /email/confirm?t= : the confirmation link. */
email.get("/email/confirm", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const t = E.readConfirm(String(req.query.t ?? ""));
  const ok = t ? await E.confirmAddress(t.userId, t.email) : false;
  const already = t && !ok ? !!(await one(`SELECT 1 FROM users WHERE id = $1 AND email = $2 AND email_confirmed_at IS NOT NULL`, [t.userId, t.email])) : false;
  res.status(ok || already ? 200 : 400).type("text/html").send(simplePage(ok || already ? "Address confirmed" : "This link does not work",
    ok || already ? `<p>Your address is confirmed. Updates about your agent's work start with the next day something happens.</p><p><a class="text-link" href="/settings#email">Your email settings</a></p>`
      : `<p>The link is older than 48 hours, or the address was changed since. Ask for a new one in <a class="text-link" href="/settings#email">your settings</a>.</p>`));
});

const ACTION_TEXT: Record<E.UnsubAction, [string, string]> = {
  "weekly": ["Switch to weekly", "You'll get one update a week, on Mondays."],
  "updates-off": ["Stop updates about your work", "No more updates. The monthly letter and new-project emails keep their own settings."],
  "newsletter-off": ["Stop the monthly letter", "No more monthly letters."],
  "projects-off": ["Stop new-project emails", "No more emails about new projects."],
  "all-off": ["Stop all emails", "No more emails from solveathome."],
};

/** GET /email/u/:token : the unsubscribe page, one button. POST does it, with no sign-in: that is what List-Unsubscribe-Post triggers. */
email.get("/email/u/:token", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const u = E.readUnsub(String(req.params.token));
  if (!u) { res.status(400).type("text/html").send(simplePage("This link does not work", `<p>Change your emails in <a class="text-link" href="/settings#email">your settings</a>.</p>`)); return; }
  const [label, after] = ACTION_TEXT[u.action];
  const tok = esc(req.params.token);
  res.type("text/html").send(simplePage(label, `<form method="post" action="/email/u/${tok}"><button class="button" type="submit">${esc(label)}</button></form>
    ${u.action !== "all-off" ? `<form method="post" action="/email/u/${esc(E.unsubToken(u.userId, "all-off"))}" style="margin-top:1rem"><button class="link-button" style="background:none;border:0;padding:0;color:inherit;text-decoration:underline;text-underline-offset:5px;cursor:pointer" type="submit">Stop all emails instead</button></form>` : ""}
    <p class="muted" style="margin-top:1.5rem">${esc(after)}</p>`));
});
email.post("/email/u/:token", async (req, res) => {
  const u = E.readUnsub(String(req.params.token));
  if (!u) { res.status(400).type("text/plain").send("This link does not work.\n"); return; }
  await E.applyUnsub(u.userId, u.action);
  if (req.is("multipart/form-data") || req.body?.["List-Unsubscribe"] === "One-Click") { res.status(200).type("text/plain").send("Done.\n"); return; }
  res.type("text/html").send(simplePage("Done", `<p>${esc(ACTION_TEXT[u.action][1])}</p><p><a class="text-link" href="/settings#email">All your email settings</a></p>`));
});

/** POST /email/postmark-webhook : bounces, spam complaints and Postmark's own unsubscribes stop all mail to that address. Basic auth from POSTMARK_WEBHOOK_AUTH (user:pass). */
email.post("/email/postmark-webhook", async (req, res) => {
  const want = process.env.POSTMARK_WEBHOOK_AUTH;
  const got = (req.header("authorization") ?? "").replace(/^Basic\s+/i, "");
  const ok = !!want && Buffer.from(got).length === Buffer.from(Buffer.from(want).toString("base64")).length && timingSafeEqual(Buffer.from(got), Buffer.from(Buffer.from(want).toString("base64")));
  if (!ok) { res.status(401).json({ error: "unauthorised" }); return; }
  const b = req.body ?? {}, to = E.cleanEmail(b.Email ?? b.Recipient);
  // Postmark manages unsubscribes on the broadcast stream (custom handling needs their support): its own unsubscribe link arrives as
  // a SubscriptionChange with reason ManualSuppression, which turns the person's emails off; a bounce or complaint stops the address.
  const manual = b.RecordType === "SubscriptionChange" && b.SuppressSending === true && b.SuppressionReason === "ManualSuppression";
  const status = b.RecordType === "SpamComplaint" || (b.RecordType === "SubscriptionChange" && b.SuppressSending === true && b.SuppressionReason === "SpamComplaint") ? "complained"
    : (b.RecordType === "Bounce" && ["HardBounce", "BadEmailAddress", "ManuallyDeactivated", "SpamNotification"].includes(b.Type)) || (b.RecordType === "SubscriptionChange" && b.SuppressSending === true && b.SuppressionReason === "HardBounce") ? "bounced" : null;
  if (to && manual) for (const u of await q<{ id: number }>(`SELECT id FROM users WHERE lower(email) = $1`, [to])) await E.applyUnsub(Number(u.id), "all-off");
  if (to && status) {
    const users = await q<{ id: number }>(`UPDATE users SET email_status = $2 WHERE lower(email) = $1 RETURNING id`, [to, status]);
    for (const u of users) await q(`INSERT INTO email_consent_events (user_id, choice, value, source, wording_version) VALUES ($1, 'address', $2, 'webhook', $3)`, [u.id, status, E.EMAIL_WORDING_VERSION]);
  }
  res.json({ ok: true });
});

/** The owner's letters: POST /email/letters { kind, subject, body_md } drafts one, /email/letters/:id/approve sends it out with each opted-in person's next email. */
function owner(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !OWNER_SET().has(req.user.handle.toLowerCase()) || (req.header("authorization") ?? "").startsWith("Bearer ")) { res.status(403).json({ error: "Only the site owner, signed in on the site." }); return; }
  next();
}
email.get("/email/letters", optionalAuth, owner, async (_req, res) => {
  res.json(await q(`SELECT l.id, l.kind, l.subject, l.body_md, l.created_at, l.approved_at,
      (SELECT count(*)::int FROM email_items i WHERE i.dedupe_key LIKE l.kind || ':' || l.id || ':%') AS queued,
      (SELECT count(*)::int FROM email_items i JOIN email_outbox o ON o.id = i.email_id WHERE i.dedupe_key LIKE l.kind || ':' || l.id || ':%' AND o.status = 'sent') AS sent
    FROM email_letters l ORDER BY l.id DESC LIMIT 50`));
});
email.post("/email/letters", optionalAuth, owner, async (req, res) => {
  const b = req.body ?? {};
  if (!["letter", "project"].includes(b.kind) || !String(b.subject ?? "").trim() || !String(b.body_md ?? "").trim()) { res.status(400).json({ error: "kind (letter | project), subject and body_md are required" }); return; }
  res.json(await one(`INSERT INTO email_letters (kind, subject, body_md, created_by) VALUES ($1, $2, $3, $4) RETURNING id, kind, subject, approved_at`, [b.kind, String(b.subject).slice(0, 200), String(b.body_md).slice(0, 20000), req.user!.id]));
});
email.post("/email/letters/:id/approve", optionalAuth, owner, async (req, res) => {
  const r = await one(`UPDATE email_letters SET approved_at = now(), approved_by = $2 WHERE id = $1 AND approved_at IS NULL RETURNING id, kind, subject, approved_at`, [req.params.id, req.user!.id]);
  if (!r) { res.status(404).json({ error: "no such draft, or already approved" }); return; }
  res.json(r);
});

/** A click on a link in an email (?e=<outbox id>): the first one is recorded against that email. Runs before the page cache. */
export function emailClicks(req: Request, _res: Response, next: NextFunction): void {
  const e = req.method === "GET" ? String(req.query.e ?? "") : "";
  if (/^[1-9]\d{0,15}$/.test(e)) q(`UPDATE email_outbox SET first_click_at = now() WHERE id = $1 AND first_click_at IS NULL`, [e]).catch(() => {});
  next();
}

function simplePage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · solveathome</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/assets/app.css?v=30"></head>
<body><header data-site-header></header><main class="shell document-main" id="main" style="max-width:40rem"><div class="page-heading"><div><p class="eyebrow">Email</p><h1>${esc(title)}</h1></div></div>${body}</main><footer data-site-footer></footer><script src="/assets/ui.js?v=21"></script></body></html>`;
}
