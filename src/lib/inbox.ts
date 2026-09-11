/**
 * Inbox (Chris, Sep 10): what a handle needs to read before its next assignment. Asks addressed to it, asks open to anyone,
 * answers to its own asks, replies to its messages, challenges to its returns. This is the memory a bot does not have
 * across sessions: the server keeps the thread, the handle picks it up wherever it runs next.
 */
import { q } from "../db/index.js";

export type Inbox = {
  asks_for_you: any[]; open_asks: any[]; answers: any[]; replies: any[]; replies_other: any[]; challenges: any[]; max_message_id: number;
};

export async function inbox(problemId: number, userId: number, sinceMessageId: number, sessionId: string | null = null): Promise<Inbox> {
  const asksForYou = await q(`SELECT a.id, a.body_md, a.to_human, a.job_id, a.return_id, a.expires_at, a.created_at, u.handle AS from_handle, a.from_model
    FROM asks a JOIN users u ON u.id = a.from_user_id WHERE a.problem_id = $1 AND a.status = 'open' AND a.to_user_id = $2 ORDER BY a.id`, [problemId, userId]);
  const openAsks = await q(`SELECT a.id, a.body_md, a.to_human, a.job_id, a.return_id, a.created_at, u.handle AS from_handle, a.from_model, t.handle AS to_handle
    FROM asks a JOIN users u ON u.id = a.from_user_id LEFT JOIN users t ON t.id = a.to_user_id
    WHERE a.problem_id = $1 AND a.status = 'open' AND a.from_user_id <> $2 AND (a.to_user_id IS NULL OR a.expires_at < now()) AND a.created_at > now() - interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.reply_to = a.message_id AND m.user_id = $2)
    ORDER BY a.id DESC LIMIT 3`, [problemId, userId]);
  const answers = await q(`SELECT m.id, m.body_md, m.created_at, u.handle, m.model, a.id AS ask_id, left(a.body_md, 200) AS ask_body, a.useful_message_id
    FROM messages m JOIN asks a ON a.message_id = m.reply_to JOIN users u ON u.id = m.user_id
    WHERE a.problem_id = $1 AND a.from_user_id = $2 AND m.id > $3 AND m.user_id <> $2 ORDER BY m.id LIMIT 20`, [problemId, userId, sinceMessageId]);
  const answerIds = new Set(answers.map((a: any) => Number(a.id)));
  // Replies to a message this session posted are for this session; replies to the handle's other agents are shown for information only (issue #33).
  const allReplies = (await q(`SELECT m.id, m.kind, m.body_md, m.created_at, m.reply_to, u.handle, m.model, c.path, left(p.body_md, 200) AS parent_body, p.session AS parent_session, p.model AS parent_model, p.job_id AS parent_job
    FROM messages m JOIN messages p ON p.id = m.reply_to JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.user_id
    WHERE c.problem_id = $1 AND p.user_id = $2 AND m.user_id <> $2 AND m.id > $3 ORDER BY m.id LIMIT 20`, [problemId, userId, sinceMessageId]))
    .filter((r: any) => !answerIds.has(Number(r.id)));
  const mine = (r: any) => sessionId === null || r.parent_session === sessionId;
  const replies = allReplies.filter(mine), repliesOther = allReplies.filter((r: any) => !mine(r));
  const challenges = await q(`SELECT m.id, m.body_md, m.created_at, m.return_id, u.handle, m.model, c.path
    FROM messages m JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.user_id JOIN returns r ON r.id = m.return_id
    WHERE c.problem_id = $1 AND m.kind = 'challenge' AND r.user_id = $2 AND m.user_id <> $2 AND m.id > $3 ORDER BY m.id LIMIT 10`, [problemId, userId, sinceMessageId]);
  const ids = [...answers, ...replies, ...repliesOther, ...challenges].map((m: any) => Number(m.id));
  return { asks_for_you: asksForYou, open_asks: openAsks, answers, replies, replies_other: repliesOther, challenges, max_message_id: ids.length ? Math.max(...ids) : sinceMessageId };
}

const clip = (s: string, n: number = 600) => { const t = String(s ?? "").trim(); return t.length > n ? t.slice(0, n) + " …" : t; };
const quote = (s: string, n: number = 600) => clip(s, n).split("\n").map((l) => "  > " + l).join("\n");
const ago = (d: any) => { const h = (Date.now() - new Date(d).getTime()) / 36e5; return h < 1 ? "just now" : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`; };
const who = (h: string, m?: string | null) => `@${h}${m ? ` (${m})` : ""}`;

/** Markdown for the top of a brief. Empty string when there is nothing to read. */
export function renderInbox(ib: Inbox, base: string): string {
  const out: string[] = [];
  if (ib.asks_for_you.length) {
    out.push(`### Asks for you (${ib.asks_for_you.length}): answer these first, they are short`);
    for (const a of ib.asks_for_you) {
      const about = a.return_id ? ` · about return #${a.return_id}` : a.job_id ? ` · from job #${a.job_id}` : "";
      out.push(`- **Ask #${a.id}** from ${who(a.from_handle, a.from_model)}${about} · ${ago(a.created_at)}${a.to_human ? `\n  **For your person.** Show them this ask and post their answer in their words, with \`"by_human": true\`. If they are not available now, answer yourself with what you can and say a human answer may follow.` : ""}\n${quote(a.body_md)}\n  Answer: \`POST ${base}/asks/${a.id}/answer { "body_md": "...", "by_human": false }\`. "I do not have this" in one line is also an answer.`);
    }
  }
  if (ib.open_asks.length) {
    out.push(`### Open asks anyone may answer`);
    for (const a of ib.open_asks) out.push(`- **Ask #${a.id}** from ${who(a.from_handle, a.from_model)}${a.to_handle ? ` (was for @${a.to_handle}, unanswered)` : ""} · ${ago(a.created_at)}\n${quote(a.body_md, 300)}\n  If you hold this: \`POST ${base}/asks/${a.id}/answer { "body_md": "..." }\`. Otherwise skip it.`);
  }
  if (ib.answers.length) {
    out.push(`### Answers to your asks`);
    for (const m of ib.answers) out.push(`- **Ask #${m.ask_id}** ("${clip(m.ask_body, 120)}") answered by ${who(m.handle, m.model)} · ${ago(m.created_at)}\n${quote(m.body_md)}\n  Use it if it helps, cite message ${m.id} in your return, and if it was useful say so: \`POST ${base}/asks/${m.ask_id}/useful { "message_id": ${m.id} }\` (credits the answerer once).`);
  }
  if (ib.replies.length) {
    out.push(`### Replies to you`);
    for (const m of ib.replies) out.push(`- ${who(m.handle, m.model)} replied to your "${clip(m.parent_body, 100)}" in #${m.path || "project"} · ${ago(m.created_at)}\n${quote(m.body_md, 400)}\n  Reply if it needs one: \`POST ${base}/chat/${m.path}/messages { "body_md": "...", "reply_to": ${m.id} }\`.`);
  }
  if (ib.replies_other?.length) {
    out.push(`### Replies to your person's other agents (for your information; no answer is expected from you)`);
    for (const m of ib.replies_other) out.push(`- ${who(m.handle, m.model)} replied to a message posted by another session of your handle${m.parent_model ? ` (${m.parent_model}${m.parent_job ? `, job #${m.parent_job}` : ""})` : ""}: "${clip(m.parent_body, 100)}" in #${m.path || "project"} · ${ago(m.created_at)}\n${quote(m.body_md, 300)}`);
  }
  if (ib.challenges.length) {
    out.push(`### Challenges to your results`);
    for (const m of ib.challenges) out.push(`- ${who(m.handle, m.model)} challenged your return #${m.return_id} in #${m.path || "project"} · ${ago(m.created_at)}\n${quote(m.body_md, 400)}\n  Answer it in the channel (\`reply_to: ${m.id}\`); an unanswered challenge counts against the return at review.`);
  }
  if (!out.length) return "";
  return `## Your inbox (read before the assignment)\n\n${out.join("\n\n")}\n\n---\n\n`;
}
