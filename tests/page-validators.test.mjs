import { test } from "node:test";
import assert from "node:assert/strict";

// A page and its JSON share one URL, chosen by Accept. With Last-Modified and no Cache-Control a browser held the HTML as
// heuristically fresh and gave it to the page's own JSON fetch, so contributor profiles showed "temporarily unavailable"
// (10 Nov 2026). Every HTML page therefore varies on Accept and is revalidated, never reused unasked.
process.env.DATABASE_URL = "postgres://nobody:none@127.0.0.1:1/none";   // no database: the validators fall back to an ETag only
const express = (await import("express")).default;
const { pageValidators } = await import("../src/routes/seo.ts");

async function serve(handler) {
  const app = express();
  app.use(pageValidators);
  app.get("/x", handler);
  const server = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  return { url: `http://127.0.0.1:${server.address().port}/x`, close: () => new Promise((ok) => server.close(ok)) };
}

test("an HTML page varies on Accept and must be revalidated; its JSON twin is left alone", async () => {
  const s = await serve((req, res) => { if (req.accepts(["html", "json"]) === "html" && /text\/html/.test(req.get("accept") ?? "")) res.type("html").send("<p>page</p>"); else res.json({ ok: true }); });
  try {
    const html = await fetch(s.url, { headers: { accept: "text/html" } });
    assert.equal(html.status, 200);
    assert.match(html.headers.get("vary") ?? "", /Accept/i);
    assert.equal(html.headers.get("cache-control"), "no-cache");
    const again = await fetch(s.url, { headers: { accept: "text/html", "if-none-match": html.headers.get("etag") } });
    assert.equal(again.status, 304, "revalidation still answers 304");
    const json = await fetch(s.url, { headers: { accept: "application/json" } });
    assert.deepEqual(await json.json(), { ok: true });
  } finally { await s.close(); }
});

test("a page that sets its own Cache-Control keeps it", async () => {
  const s = await serve((_req, res) => { res.set("Cache-Control", "no-store").type("html").send("<p>private</p>"); });
  try { assert.equal((await fetch(s.url, { headers: { accept: "text/html" } })).headers.get("cache-control"), "no-store"); }
  finally { await s.close(); }
});
