/**
 * Sending through Postmark (#sah-progress-emails). The token lives in the host environment (POSTMARK_SERVER_TOKEN), never in a file here.
 * Without it nothing leaves the server: the message is reported as not sent, so a dev checkout or a deploy without the key cannot mail anyone.
 * Updates, letters and project news go on the broadcast stream (POSTMARK_STREAM) with one-click unsubscribe headers; only the
 * confirmation link uses the transactional stream.
 */
export type Mail = { to: string; subject: string; html: string; text: string; from?: string; stream: "broadcast" | "transactional"; unsubscribeUrl?: string; tag?: string };
export type Sent = { ok: true; id: string } | { ok: false; reason: string };

export const fromAddress = () => process.env.EMAIL_FROM || "solveathome <updates@solveathome.org>";
export const letterFromAddress = () => process.env.EMAIL_LETTER_FROM || "Chris from solveathome <chris@solveathome.org>";
const replyTo = () => process.env.EMAIL_REPLY_TO || "support@solveathome.org";

/** Swappable for tests: the real one posts to Postmark. */
export let transport: (body: Record<string, unknown>, token: string) => Promise<Response> = (body, token) =>
  fetch("https://api.postmarkapp.com/email", { method: "POST", signal: AbortSignal.timeout(15_000), headers: { accept: "application/json", "content-type": "application/json", "X-Postmark-Server-Token": token }, body: JSON.stringify(body) });
export function setTransport(t: typeof transport): void { transport = t; }

export async function send(m: Mail): Promise<Sent> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) return { ok: false, reason: "no provider configured (POSTMARK_SERVER_TOKEN unset)" };
  const headers = m.unsubscribeUrl ? [{ Name: "List-Unsubscribe", Value: `<${m.unsubscribeUrl}>` }, { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" }] : [];
  const body = {
    From: m.from ?? fromAddress(), To: m.to, ReplyTo: replyTo(), Subject: m.subject, HtmlBody: m.html, TextBody: m.text, Headers: headers, Tag: m.tag,
    MessageStream: m.stream === "broadcast" ? (process.env.POSTMARK_STREAM || "broadcast") : "outbound",
    // Clicks are measured on our own links (?e=<outbox id>); opens are meaningless since Apple Mail's privacy protection.
    TrackOpens: false, TrackLinks: "None",
  };
  try {
    const r = await transport(body, token);
    const d: any = await r.json().catch(() => ({}));
    if (r.ok && d.ErrorCode === 0) return { ok: true, id: String(d.MessageID) };
    return { ok: false, reason: `postmark ${r.status}: ${String(d.Message ?? "").slice(0, 200)}` };
  } catch (e: any) { return { ok: false, reason: `postmark unreachable: ${String(e?.message ?? e).slice(0, 200)}` }; }
}
