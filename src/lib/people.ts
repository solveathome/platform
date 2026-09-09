/** Names in rendered prose link to the contributor's profile. Only text outside existing links is touched. */
import { q } from "../db/index.js";
let cache: { at: number; people: Array<{ name: string; handle: string }> } = { at: 0, people: [] };
async function people(): Promise<Array<{ name: string; handle: string }>> {
  if (Date.now() - cache.at > 60_000) cache = { at: Date.now(), people: (await q(`SELECT handle, display_name AS name FROM users WHERE display_name IS NOT NULL`)).map((r: any) => ({ name: String(r.name), handle: String(r.handle) })) };
  return cache.people;
}
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export async function linkPeople(html: string): Promise<string> {
  const list = await people(); if (!list.length) return html;
  const parts = html.split(/(<[^>]+>)/); let depth = 0; let inKatex = 0;
  return parts.map((part) => {
    if (part.startsWith("<")) {
      if (/^<a[\s>]/i.test(part)) depth++; else if (/^<\/a>/i.test(part)) depth = Math.max(0, depth - 1);
      return part;
    }
    if (depth > 0 || !part.trim()) return part;
    let out = part;
    for (const p of list) out = out.replace(new RegExp(`(?<![\\w@-])${escRe(p.name)}(?![\\w-])`, "g"), () => `<a href="/@${p.handle}" class="person">${p.name}</a>`);
    return out;
  }).join("");
}
