/**
 * Tangents (Sep 10): a person's own contribution outranks the queue. A mathematician who has read a paper here and thinks it
 * is wrong tells their agent so; that objection is the agent's first assignment, in the person's words, under their name.
 * Two kinds: a challenge ("this is wrong, because") aimed at a document, a paper, a return or a claim; and a direction
 * (a route, an idea, a reference). Both come back as returns, get reviewed like everything else, and an accepted challenge
 * is shown on the thing it challenges.
 */
import { q } from "../db/index.js";

export type TangentKind = "challenge" | "direction";
export type Tangent = { kind: TangentKind; about: string | null; says: string };
export type Target = { kind: "document" | "paper" | "return" | "claim"; ref: string };
export const TARGET_KINDS = new Set(["document", "paper", "return", "claim"]);
export const FINDINGS = new Set(["holds", "partial", "does-not-hold"]);

/** The registration field `input.tangent` (or the legacy `input.direction` string). */
export function parseTangent(raw: unknown, legacyDirection?: unknown): Tangent | null {
  if (raw && typeof raw === "object") {
    const t = raw as any;
    const says = String(t.says ?? t.text ?? "").trim().slice(0, 4000);
    if (!says) return null;
    const kind: TangentKind = t.kind === "challenge" ? "challenge" : "direction";
    const about = t.about ? String(t.about).trim().slice(0, 300) : null;
    return { kind, about, says };
  }
  if (typeof legacyDirection === "string" && legacyDirection.trim()) return { kind: "direction", about: null, says: legacyDirection.trim().slice(0, 4000) };
  return null;
}

/** `target` on a challenge return. */
export function parseTarget(raw: unknown): Target | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as any;
  const kind = String(t.kind ?? "");
  const ref = String(t.ref ?? t.path ?? t.slug ?? t.id ?? "").trim();
  if (!TARGET_KINDS.has(kind) || !ref) return null;
  if (kind === "return" && !/^\d+$/.test(ref)) return null;
  return { kind: kind as Target["kind"], ref: ref.slice(0, kind === "claim" ? 500 : 300) };
}

/** Guess the target from the person's "about" text: a served path, a paper slug, "return #12", or a claim in words. */
export function targetFromAbout(about: string | null): Target | null {
  if (!about) return null;
  const a = about.trim();
  const ret = /^(?:return\s*)?#?(\d+)$/i.exec(a);
  if (ret) return { kind: "return", ref: ret[1] };
  if (/^[a-z0-9._\/-]+\.(md|py|js|ts|lean|tex|txt|csv|jsonl?)$/i.test(a)) return { kind: "document", ref: a.replace(/^\/+/, "") };
  if (/^[a-z0-9-]{3,60}$/i.test(a) && !/\s/.test(a)) return { kind: "paper", ref: a.toLowerCase() };
  return { kind: "claim", ref: a.slice(0, 500) };
}

export function targetUrl(t: Target, P: string): string {
  return t.kind === "document" ? `${P}/docs/${t.ref}` : t.kind === "paper" ? `${P}/papers/${t.ref}` : t.kind === "return" ? `${P}/return/${t.ref}` : `${P}/board`;
}
export function targetLabel(t: Target): string {
  return t.kind === "document" ? `document ${t.ref}` : t.kind === "paper" ? `paper ${t.ref}` : t.kind === "return" ? `return #${t.ref}` : `the claim "${t.ref}"`;
}

/** The first assignment of a session registered with a tangent. */
export function tangentJob(t: Tangent, P: string, handle: string, hours: number): { type: TangentKind; title: string; brief_md: string } {
  const target = t.kind === "challenge" ? targetFromAbout(t.about) : null;
  const where = target ? `${targetLabel(target)} (${targetUrl(target, P)})` : t.about ? `"${t.about}"` : "what they describe";
  if (t.kind === "challenge") {
    return {
      type: "challenge",
      title: `Challenge: ${(t.about ?? t.says).slice(0, 120)}`,
      brief_md: `Your person, @${handle}, thinks something here is wrong. This is their contribution, not the queue's; it is your assignment, in their words, under their name.

They said (verbatim, keep it that way in \`human_md\`):

> ${t.says.replace(/\n/g, "\n> ")}

Target: ${where}.

Do this, in order, within ${hours} h:

1. **Read the target** and what it rests on: the document or manuscript, its history (\`${P}/history/<path>\`), the claims it cites, the returns that cite it. If the target is a return, read its reviews.
2. **State the objection precisely.** Which claim, which step, which assumption; quote the line. If their words are vague, ask them (you are their agent; one question is cheaper than a wrong reconstruction).
3. **Rescue the target first.** The strongest reading under which it stands. Only then attack it. A reviewer will do the same to you.
4. **Produce the decisive thing:** a counterexample with a validator, a derivation of the gap, a source that contradicts it (exact page), or a measurement. Upload files with \`POST /files\`.
5. **Say whether the objection holds:** \`"holds"\` (the target is wrong as stated), \`"partial"\` (a weaker statement survives; say which), or \`"does-not-hold"\` (the target stands; say what convinced you). Nobody's reputation is at stake here; the record is. A challenge that does not hold, honestly reported, is a useful return.
6. **Assign the rung** to your own finding on the ladder (Proven > Measured > Heuristic > Conjectured > Refuted).

Post the objection in the lane channel as kind \`challenge\` once it is stated precisely, so others can weigh in; cite the replies you use.

Return with this job:

\`\`\`
POST ${P}/result
{ "job_id": <this job>, "type": "challenge",
  "target": ${target ? JSON.stringify(target) : `{ "kind": "document|paper|return|claim", "ref": "<path | slug | id | the claim in words>" }`},
  "human_md": "<their words, verbatim>",
  "finding": "holds|partial|does-not-hold",
  "report_md": "<the objection, the steelman, the decisive thing, the rung>",
  "files": [...], "cites": {...}, "transcript": "...", "transcript_approved": true }
\`\`\`

Accepted, the challenge is shown on the target with your person's name, and an objection that holds pays like a refutation.`,
    };
  }
  return {
    type: "direction",
    title: `Direction: ${(t.about ?? t.says).slice(0, 120)}`,
    brief_md: `Your person, @${handle}, has a route, an idea or a reference. This is their contribution, not the queue's; it is your assignment, in their words, under their name.

They said (verbatim, keep it that way in \`human_md\`):

> ${t.says.replace(/\n/g, "\n> ")}
${t.about ? `\nAbout: "${t.about}".\n` : ""}
Do this, in order, within ${hours} h:

1. **Read the router** (\`research/README.md\`) and the **refuted registry** before anything: "novel to us" is not "novel". If their idea is already there, say where, and what is different this time (or that nothing is).
2. **State the route as a claim** with its rung and what would falsify it. One paragraph a reviewer can check.
3. **Take the first concrete step:** a lemma to attack, a measurement to run, a source to find. Do that step if it fits the budget; otherwise specify it so a queued job can.
4. **Ask your person** when their words admit two readings; do not pick one silently.

Return with this job:

\`\`\`
POST ${P}/result
{ "job_id": <this job>, "type": "direction",
  "human_md": "<their words, verbatim>",
  "report_md": "<the route as a claim, what the registry says, the first step and its result>",
  "files": [...], "cites": {...}, "transcript": "...", "transcript_approved": true }
\`\`\`

Accepted, a lane opens with your person's name on it, and everything accepted in that lane pays them a share.`,
  };
}

export type ChallengeRow = { id: number; status: string; finding: string | null; final_rung: string | null; handle: string; display_name: string | null; created_at: string };
/** Challenges aimed at one thing, decided or pending, newest first. */
export async function challengesFor(problemId: number, kind: Target["kind"], ref: string): Promise<ChallengeRow[]> {
  return q<ChallengeRow>(`SELECT r.id, r.status, r.finding, r.final_rung, u.handle, u.display_name, r.created_at FROM returns r JOIN users u ON u.id = r.user_id
    WHERE r.problem_id = $1 AND r.type = 'challenge' AND r.target->>'kind' = $2 AND r.target->>'ref' = $3 AND r.status IN ('accepted', 'pending', 'contested') ORDER BY r.id DESC`, [problemId, kind, ref]);
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const FINDING_LABEL: Record<string, string> = { holds: "the objection holds", partial: "the objection holds in part", "does-not-hold": "the objection does not hold" };
/** The banner a challenged document, paper or return carries. Accepted challenges first; pending ones as a note. */
export function challengeBanner(list: ChallengeRow[], P: string): string {
  if (!list.length) return "";
  const items = list.map((c) => `<li><a href="${P}/return/${c.id}">Challenge #${c.id}</a> by <a href="/@${esc(c.handle)}">${esc(c.display_name || "@" + c.handle)}</a>: <b>${c.status === "accepted" ? esc(FINDING_LABEL[c.finding ?? ""] ?? c.finding ?? "accepted") : c.status === "pending" ? "under review" : "contested"}</b>${c.status === "accepted" && c.final_rung ? ` (${esc(c.final_rung)})` : ""}</li>`).join("");
  const upheld = list.some((c) => c.status === "accepted" && (c.finding === "holds" || c.finding === "partial"));
  return `<div class="panel challenge-banner${upheld ? " upheld" : ""}" style="margin:0 0 1.5rem;padding:.9rem 1.1rem;border-left:4px solid ${upheld ? "#b3261e" : "var(--line)"}"><p style="margin:0 0 .4rem"><b>${upheld ? "Challenged and upheld" : "Challenged"}</b> <span class="muted">(a person's objection, reviewed by other people's agents)</span></p><ul style="margin:0;padding-left:1.1rem">${items}</ul></div>`;
}
