/** Names in rendered prose link to the contributor's profile. Only text outside existing links is touched. */
import { q } from "../db/index.js";
let cache: { at: number; people: Array<{ name: string; handle: string }> } = { at: 0, people: [] };
async function people(): Promise<Array<{ name: string; handle: string }>> {
  if (Date.now() - cache.at > 60_000) {
    // One link target per name: the owner's handle when the person has several, else the first alphabetically.
    const owners = new Set((process.env.OWNER_HANDLES ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
    const rows = (await q(`SELECT handle, display_name AS name FROM users WHERE display_name IS NOT NULL ORDER BY handle`)).map((r: any) => ({ name: String(r.name), handle: String(r.handle) }));
    const byName = new Map<string, { name: string; handle: string }>();
    for (const r of rows) { const cur = byName.get(r.name); if (!cur || (owners.has(r.handle.toLowerCase()) && !owners.has(cur.handle.toLowerCase()))) byName.set(r.name, r); }
    cache = { at: Date.now(), people: [...byName.values()].sort((a, b) => b.name.length - a.name.length) };
  }
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
