import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

// #sah-fast-dumps-cold: the first visitor after the TTL is served the last copy at once, and the rebuild runs in the background.
const { responseCache, warmCache } = await import("../src/lib/cache.ts");

test("an expired entry is served stale while one background request rebuilds it; warmCache fills cold pages", async () => {
  let builds = 0;
  const app = express();
  app.use(responseCache([/^\/slow$/, /^\/warm$/], 200, 5_000));
  app.get("/slow", async (_req, res) => { builds++; await new Promise((r) => setTimeout(r, 150)); res.json({ build: builds }); });
  app.get("/warm", (_req, res) => { builds++; res.json({ warm: true }); });
  const srv = app.listen(0);
  await new Promise((r) => srv.once("listening", r));
  const port = srv.address().port, url = `http://127.0.0.1:${port}`;
  const get = async (path, headers = {}) => { const t = Date.now(); const r = await fetch(url + path, { headers: { accept: "application/json", ...headers } }); return { cache: r.headers.get("x-cache"), body: await r.json(), ms: Date.now() - t }; };
  try {
    const first = await get("/slow");
    assert.equal(first.cache, null);
    assert.equal((await get("/slow")).cache, "hit");
    await new Promise((r) => setTimeout(r, 220));
    const stale = await get("/slow");
    assert.equal(stale.cache, "stale");
    assert.deepEqual(stale.body, { build: 1 });
    assert.ok(stale.ms < 100, `stale answer took ${stale.ms} ms`);
    assert.equal((await get("/slow")).cache, "stale", "only one rebuild in flight");
    await new Promise((r) => setTimeout(r, 170));
    const fresh = await get("/slow");
    assert.equal(fresh.cache, "hit");
    assert.deepEqual(fresh.body, { build: 2 });
    assert.equal(builds, 2);
    assert.equal((await get("/slow", { cookie: "s=1" })).cache, null, "a signed-in request is never cached");

    warmCache(port, [{ url: "/warm", accept: "application/json" }], 60_000);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await get("/warm")).cache, "hit");
  } finally { srv.close(); }
});
