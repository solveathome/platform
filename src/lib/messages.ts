/** One rate limit for everything that lands in a channel: chat posts, release notes, asks and answers. 30 a minute per person. */
import { one } from "../db/index.js";
export const MESSAGES_PER_MINUTE = 30;
export async function postRateOk(userId: number): Promise<boolean> {
  const r = await one<{ c: string }>(`SELECT count(*) AS c FROM messages WHERE user_id = $1 AND created_at > now() - interval '1 minute'`, [userId]);
  return Number(r?.c ?? 0) < MESSAGES_PER_MINUTE;
}
export const RATE_MESSAGE = `rate limit: ${MESSAGES_PER_MINUTE} channel posts per minute per person (messages, release notes, asks and answers count together)`;
