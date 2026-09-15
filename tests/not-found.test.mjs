import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

// Issue #89: a JSON client that missed a route got Express's default HTML page, so it recorded a decode error where the fault
// was a wrong path, and its journal then said "bad JSON" instead of "no such route" — the wrong answer to the question the
// journal exists to settle. The near-miss that found it was the plural of a real route: /returns/587 for /return/587.
const { notFound, nearestRoute, routeHeads } = await import("../src/lib/not-found.ts");
const { job } = await import("../src/routes/job.ts");
const { board } = await import("../src/routes/board.ts");

const heads = routeHeads([job, board]);

test("the route heads are read from the routers themselves, so the list cannot drift", () => {
  for (const expected of ["start", "result", "return", "release", "scheduler"]) assert.ok(heads.includes(expected), `missing ${expected}: ${heads.join(" ")}`);
  assert.ok(!heads.some((h) => h.startsWith(":")), "a parameter is not a route head");
});

test("a near-miss names the route it probably meant; a guess names nothing", () => {
  assert.equal(nearestRoute("/projects/twin-primes/returns/587", heads), "/projects/twin-primes/return/587");
  assert.equal(nearestRoute("/projects/twin-primes/resul", heads), "/projects/twin-primes/result");
  assert.equal(nearestRoute("/projects/twin-primes/no-such-endpoint", heads), null, "nothing is close, so nothing is suggested");
  assert.equal(nearestRoute("/projects/twin-primes/return/587", heads), null, "a real route is not a miss");
  assert.equal(nearestRoute("/files/abc", heads), null, "only project paths have a candidate list");
});

test("the handler answers JSON to a JSON client and leaves a browser its page", async () => {
  const app = express();
  app.get("/projects/:slug/return/:id", (_req, res) => { res.json({ ok: true }); });
  app.use(notFound([job, board]));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const miss = await fetch(`${base}/projects/twin-primes/returns/587`, { headers: { accept: "application/json" } });
  assert.equal(miss.status, 404); assert.match(miss.headers.get("content-type"), /application\/json/);
  const body = await miss.json();
  assert.match(body.error, /no such route: GET \/projects\/twin-primes\/returns\/587/);
  assert.equal(body.did_you_mean, "/projects/twin-primes/return/587");
  assert.match(body.report, /github\.com\/solveathome\/platform\/issues/);
  const post = await (await fetch(`${base}/projects/twin-primes/resul`, { method: "POST", headers: { accept: "application/json" } })).json();
  assert.match(post.error, /^no such route: POST/); assert.equal(post.did_you_mean, "/projects/twin-primes/result");
  const noAccept = await fetch(`${base}/projects/twin-primes/returns/587`);
  assert.match(noAccept.headers.get("content-type"), /application\/json/, "a client that sends no Accept is not a browser");
  const browser = await fetch(`${base}/projects/twin-primes/returns/587`, { headers: { accept: "text/html" } });
  assert.equal(browser.status, 404); assert.doesNotMatch(browser.headers.get("content-type") ?? "", /application\/json/);
  const real = await (await fetch(`${base}/projects/twin-primes/return/587`, { headers: { accept: "application/json" } })).json();
  assert.deepEqual(real, { ok: true }, "a route that exists is untouched");
  await new Promise((r) => server.close(r));
});
