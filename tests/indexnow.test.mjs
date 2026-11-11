import { test } from "node:test";
import assert from "node:assert/strict";

// #sah-bing-indexnow: IndexNow's key file, what is pinged and from where. Bing had never indexed the site.
process.env.BASE_URL = "https://example.org";
delete process.env.INDEXNOW_KEY; delete process.env.INDEXNOW_ENABLED;
const { indexNowKey, indexNowEnabled, changedUrls, ping, indexNowTick, ENDPOINT } = await import("../src/lib/indexnow.ts");
const { seo } = await import("../src/routes/seo.ts");
const express = (await import("express")).default;

test("the key is INDEXNOW_KEY when valid, else stable and derived from BASE_URL", () => {
  const k = indexNowKey();
  assert.match(k, /^[0-9a-f]{32}$/);
  assert.equal(indexNowKey(), k);
  process.env.INDEXNOW_KEY = "abc-DEF-12345678"; assert.equal(indexNowKey(), "abc-DEF-12345678");
  process.env.INDEXNOW_KEY = "bad key!"; assert.equal(indexNowKey(), k);
  delete process.env.INDEXNOW_KEY;
});

test("nothing is pinged from localhost, plain http, or with INDEXNOW_ENABLED=0", () => {
  assert.equal(indexNowEnabled(), true);
  for (const b of ["http://example.org", "https://localhost:8600", "https://127.0.0.1"]) { process.env.BASE_URL = b; assert.equal(indexNowEnabled(), false, b); }
  process.env.BASE_URL = "https://example.org";
  process.env.INDEXNOW_ENABLED = "0"; assert.equal(indexNowEnabled(), false); delete process.env.INDEXNOW_ENABLED;
});

test("the first snapshot pings everything; later ones only what is new or whose lastmod moved", () => {
  const a = new Map([["https://example.org/", ""], ["https://example.org/x", "2026-10-01"]]);
  assert.deepEqual(changedUrls(null, a), ["https://example.org/", "https://example.org/x"]);
  assert.deepEqual(changedUrls(a, new Map(a)), []);
  assert.deepEqual(changedUrls(a, new Map([...a, ["https://example.org/x", "2026-10-02"], ["https://example.org/y", ""]])), ["https://example.org/x", "https://example.org/y"]);
});

test("a ping posts host, key, key location and the urls, and reports the status", async () => {
  let sent;
  const statuses = await ping(["https://example.org/"], async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response("", { status: 202 }); });
  assert.deepEqual(statuses, [202]);
  assert.equal(sent.url, ENDPOINT);
  assert.deepEqual(sent.body, { host: "example.org", key: indexNowKey(), keyLocation: `https://example.org/${indexNowKey()}.txt`, urlList: ["https://example.org/"] });
  assert.deepEqual(await ping(["https://example.org/"], async () => { throw new Error("offline"); }), [0]);
});

test("/<key>.txt serves the key as text; any other .txt falls through", async () => {
  const app = express(); app.use(seo); app.use((_req, res) => res.status(404).send("no"));
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await fetch(`${base}/${indexNowKey()}.txt`);
    assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /^text\/plain/); assert.equal(await r.text(), indexNowKey());
    assert.equal((await fetch(`${base}/nope.txt`)).status, 404);
    assert.equal((await fetch(`${base}/robots.txt`)).status, 200);
  } finally { srv.close(); }
});

// #sah-bing-index-week-check: every deploy pinged the whole sitemap again (213.5K urls in a week for 4.1K); what was accepted now outlives the container.
test("a restart pings only what changed since the last accepted ping; a refused ping is not recorded", async () => {
  const kept = new Map(), store = { load: async () => new Map(kept), save: async (m) => { for (const [u, d] of m) kept.set(u, d); } };
  let map = new Map([["https://example.org/", ""], ["https://example.org/x", "2026-10-01"]]), status = 202;
  const sent = [], pingImpl = async (urls) => { sent.push(urls); return [status]; }, tick = () => indexNowTick(async () => map, store, pingImpl);
  assert.deepEqual(await tick(), ["https://example.org/x", "https://example.org/"], "newest lastmod first (#r2532)");
  assert.deepEqual(await tick(), [], "a second container start sends nothing");
  map = new Map([...map, ["https://example.org/x", "2026-10-02"]]); status = 429;
  assert.deepEqual(await tick(), ["https://example.org/x"]);
  status = 200;
  assert.deepEqual(await tick(), ["https://example.org/x"], "refused, so sent again");
  assert.deepEqual(await tick(), []);
  assert.equal(sent.length, 3);
});

// #r2532 (mba ask 7870): horrorgamestoplay was demoted hours after one deploy re-dated and pinged 1,317 urls.
const { allowedUrls, runCap, searchDemoted, SEARCH_DEMOTED } = await import("../src/lib/indexnow.ts");
const site = (n, day) => new Map(Array.from({ length: n }, (_, i) => [`https://example.org/p${i}`, typeof day === "function" ? day(i) : day]));

test("one run sends at most max(25, 10 %) of the sitemap, newest first; the rest go in later runs", async () => {
  assert.equal(runCap(100), 25); assert.equal(runCap(2719), 272);
  const kept = new Map(), store = { load: async () => new Map(kept), save: async (m) => { for (const [u, d] of m) kept.set(u, d); }, lastRun: async () => undefined };
  const map = site(400, (i) => `2026-11-${String(1 + (i % 9)).padStart(2, "0")}`), sent = [];
  const tick = () => indexNowTick(async () => map, store, async (urls) => { sent.push(urls); return [202]; });
  const first = await tick();
  assert.equal(first.length, 40);
  assert.ok(first.every((u) => map.get(u) === "2026-11-09"), "the newest go first");
  let runs = 1; while ((await tick()).length) runs++;
  assert.equal(kept.size, 400); assert.equal(runs, 10);
  assert.ok(sent.every((b) => b.length <= 40));
});

test("a url whose lastmod moved back or to a day before the previous run is never sent", () => {
  const prev = new Map([["a", "2026-11-05"], ["b", "2026-11-05"], ["c", "2026-11-05"], ["d", "2026-11-05"]]);
  const next = new Map([["a", "2026-11-01"], ["b", "2026-11-08"], ["c", "2026-11-11"], ["d", "2026-11-05"], ["e", "2026-10-01"]]);
  const r = allowedUrls(prev, next, "2026-11-10", changedUrls(prev, next));
  assert.deepEqual(r.refused.sort(), ["a", "b"]);
  assert.deepEqual(r.send, ["c", "e"], "a real change today and a url never sent before go");
});

test("once a site was pinged, the whole sitemap is never sent again (a bulk re-dating)", async () => {
  const prev = site(30, "2026-11-01"), next = site(30, "2026-11-11");
  const r = allowedUrls(prev, next, "2026-11-10", changedUrls(prev, next));
  assert.deepEqual(r.send, []); assert.equal(r.held.length, 30);
  let pinged = false;
  const out = await indexNowTick(async () => next, { load: async () => prev, save: async () => {}, lastRun: async () => "2026-11-10" }, async () => { pinged = true; return [202]; });
  assert.deepEqual(out, []); assert.equal(pinged, false);
});

test("SEARCH_DEMOTED sends nothing (#r633); it is off for this site", async () => {
  assert.equal(SEARCH_DEMOTED, false); assert.equal(searchDemoted(), false);
  process.env.SEARCH_DEMOTED = "1";
  try {
    let pinged = false;
    assert.deepEqual(await indexNowTick(async () => site(3, ""), { load: async () => new Map(), save: async () => {} }, async () => { pinged = true; return [202]; }), []);
    assert.equal(pinged, false);
  } finally { delete process.env.SEARCH_DEMOTED; }
});
