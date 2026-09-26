// Tell IndexNow engines (Bing, Yandex, Seznam, Naver) about every URL in the sitemap (#sah-search-console-sitemaps).
// Run after a deploy, from any machine: node scripts/indexnow.mjs [https://solveathome.org]
// It reads the live site only: the key from public/indexnow.txt, which the site serves at /<key>.txt, and the URLs from /sitemap.xml.
import { readFileSync } from "node:fs";

const base = (process.argv[2] ?? process.env.BASE_URL ?? "https://solveathome.org").replace(/\/+$/, "");
const key = readFileSync(new URL("../public/indexnow.txt", import.meta.url), "utf8").trim();
const served = await fetch(`${base}/${key}.txt`);
if (!served.ok || (await served.text()).trim() !== key) { console.error(`${base}/${key}.txt does not serve the key yet: deploy first`); process.exit(1); }
const xml = await (await fetch(`${base}/sitemap.xml`)).text();
const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
for (let i = 0; i < urls.length; i += 10_000) {   // the protocol's limit per request
  const res = await fetch("https://api.indexnow.org/indexnow", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: new URL(base).host, key, keyLocation: `${base}/${key}.txt`, urlList: urls.slice(i, i + 10_000) }) });
  console.log(`IndexNow ${i + 1}-${Math.min(i + 10_000, urls.length)} of ${urls.length}: ${res.status} ${await res.text()}`);
}
