import { test } from "node:test";
import assert from "node:assert/strict";

// #sah-bing-indexnow: IndexNow's key file, what is pinged and from where. Bing had never indexed the site.
process.env.BASE_URL = "https://example.org";
delete process.env.INDEXNOW_KEY; delete process.env.INDEXNOW_ENABLED;
const { indexNowKey, indexNowEnabled, changedUrls, ping, ENDPOINT } = await import("../src/lib/indexnow.ts");
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
