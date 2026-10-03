import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

// The ChatGPT plugin (POST /mcp): read-only over public data, every link tagged, one open problem a conversation can carry,
// and mounted ahead of pathGuard so the domain-verification path, a dotfile to the guard, still answers.
const { solveAtHomePlugin, clip } = await import("../src/lib/chatgpt.ts");
const { mountPlugin } = await import("../src/lib/chatgpt-plugin/express.ts");
const { pathGuard } = await import("../src/lib/guards.ts");
const { terms } = await import("../src/routes/terms.ts");

const project = { id: 1, slug: "demo", name: "Demo Conjecture", summary: "Is every demo number even?", status_md: "Open.", featured: true, accepted: 3, queued: 2, active_agents: 1 };
const step = (question, extra = {}) => ({ question, method: "Work it out by hand.", success: "A bound with proof.", failure: "A counterexample.", compute: { cpu_hours: 0 }, required_tools: [], required_sources: [], ...extra });
const routes = [
  { id: 11, title: "Needs a served file", state: "active", contribution_md: "x", uncertainty_md: "y", next_step: step("Rerun check-11.py with a larger N?"), updated_at: "2026-10-01" },
  { id: 12, title: "Sieve bound for demo gaps", state: "active", contribution_md: "The **sieve** gives C_2 bounds.", uncertainty_md: "Whether it is uniform.", next_step: step("Is the demo gap bounded by a sieve?"), updated_at: "2026-10-02" },
  { id: 13, title: "Heavy census", state: "active", contribution_md: "x", uncertainty_md: "y", next_step: step("Does the census hold to 1e20?", { compute: { cpu_hours: 40 } }), updated_at: "2026-10-03" },
  { id: 14, title: "Closed route", state: "result", contribution_md: "A result on demo parity.", uncertainty_md: "", next_step: null, updated_at: "2026-10-03" },
];
const source = {
  projects: async () => [project],
  routes: async () => routes,
  questions: () => [{ id: "Q-odd", text: "Is there an odd demo number?", status: "OPEN", verdict: "None below 10^6.", item: "1" }],
  papers: async () => [{ slug: "parity", title: "Demo parity", kind: "draft", status: "reviewed", status_label: "reviewed", final_rung: "verified", summary: "Parity of demo numbers.", url: "/projects/demo/papers/parity" }],
  accepted: async () => [{ id: 5, type: "audit", title: "Audit of the parity note", label: "Audit", final_rung: "verified", created_at: "2026-10-01T00:00:00Z" }],
};
const plugin = solveAtHomePlugin(source, "https://solveathome.org");
const rpc = async (method, params = {}) => (await plugin.handle({ jsonrpc: "2.0", id: 1, method, params })).result;
const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });

test("every tool is announced read-only, without auth, with an output schema and a 'Use this when' description", async () => {
  const { tools } = await rpc("tools/list");
  assert.deepEqual(tools.map((t) => t.name), ["get_open_problem", "find_research", "get_project"]);
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true); assert.equal(t.annotations.destructiveHint, false);
    assert.deepEqual(t.securitySchemes, [{ type: "noauth" }]);
    assert.ok(t.outputSchema, `${t.name} declares its output`);
    assert.match(t.description, /^Use this when /);
  }
});

test("an open problem is one a conversation can carry: no served file, light compute first, and links tagged", async () => {
  const r = await call("get_open_problem");
  const p = r.structuredContent.problem;
  assert.equal(p.question, "Is the demo gap bounded by a sieve?", "the step naming check-11.py is left out, the light one leads");
  assert.match(p.known, /C_2/, "underscores in mathematics survive the plain-text cut");
  assert.match(p.page, /^https:\/\/solveathome\.org\/projects\/demo\/research-routes\/12\?utm_source=chatgpt&utm_medium=plugin&utm_campaign=solveathome/);
  assert.match(r.content[0].text, /How results are checked: .*trusted reviewers/);
  assert.match(r.structuredContent.taking_part, /#contribute$/);
  const next = await call("get_open_problem", { skip: 1 });
  assert.equal(next.structuredContent.problem.kind, "question", "the programme's open question follows the light experiments");
  const all = new Set();
  for (let i = 0; i < 4; i++) all.add((await call("get_open_problem", { skip: i })).structuredContent.problem.question);
  assert.ok(![...all].some((q) => /check-11\.py/.test(q)));
});

test("an area narrows the problem; a field we do not cover is a plain no, not an error", async () => {
  assert.equal((await call("get_open_problem", { area: "sieve" })).structuredContent.problem.question, "Is the demo gap bounded by a sieve?");
  assert.ok((await call("get_open_problem", { area: "an open math problem" })).structuredContent.found, "generic words ask for anything");
  const none = await call("get_open_problem", { area: "protein folding" });
  assert.equal(none.isError, undefined); assert.equal(none.structuredContent.found, false);
  assert.match(none.content[0].text, /no open problem on "protein folding"/);
});

test("search finds routes, papers and questions by whole words; no query lists what reached a result", async () => {
  const hits = (await call("find_research", { query: "demo parity" })).structuredContent.items;
  assert.deepEqual(hits.map((i) => i.kind).sort(), ["paper", "research route"]);
  assert.equal((await call("find_research", { query: "black holes" })).structuredContent.total, 0);
  const overview = (await call("find_research")).structuredContent.items.map((i) => i.title);
  assert.deepEqual(overview, ["Demo parity", "Closed route"]);
});

test("a project answers with its record; an unknown name is a plain no", async () => {
  const r = await call("get_project", { name: "demo" });
  assert.equal(r.structuredContent.project.accepted_results, 3);
  assert.equal(r.structuredContent.latest_results[0].kind, "Audit");
  assert.equal((await call("get_project", { name: "Riemann hypothesis" })).structuredContent.found, false);
});

test("the widget is self-contained", async () => {
  const { contents } = await rpc("resources/read", { uri: "ui://widget/solveathome.html" });
  assert.equal(contents[0].mimeType, "text/html;profile=mcp-app");
  assert.doesNotMatch(contents[0].text, /<script src|<link /);
});

test("clip cuts at a sentence and keeps the mathematics", () => {
  assert.equal(clip("a_1 + **b** = `c`.", 100), "a_1 + b = c.");
  assert.equal(clip("One two. Three four five six seven.", 12), "One two. …");
  assert.equal(clip("One. Two three four five six seven.", 12), "One. Two …", "a sentence end too early cuts at a word");
});

test("mounted ahead of pathGuard: /mcp answers JSON-RPC and the challenge path is not refused as a dotfile; /privacy covers the plugin", async () => {
  const app = express();
  mountPlugin(app, plugin);
  app.use(pathGuard);
  app.use(terms);
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const init = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) });
    assert.equal(init.status, 200);
    assert.equal((await init.json()).result.serverInfo.name, "solveathome");
    assert.equal((await fetch(`${base}/mcp`)).status, 405);
    const before = process.env.OPENAI_APPS_CHALLENGE;
    delete process.env.OPENAI_APPS_CHALLENGE;
    const missing = await fetch(`${base}/.well-known/openai-apps-challenge`);
    assert.equal(missing.status, 404); assert.equal(await missing.text(), "Not Found", "the plugin's own 404, not the guard's JSON");
    process.env.OPENAI_APPS_CHALLENGE = "test-token";
    assert.equal(await (await fetch(`${base}/.well-known/openai-apps-challenge`)).text(), "test-token");
    if (before === undefined) delete process.env.OPENAI_APPS_CHALLENGE; else process.env.OPENAI_APPS_CHALLENGE = before;
    const privacy = await (await fetch(`${base}/privacy`)).text();
    assert.match(privacy, /## 3\. The ChatGPT plugin/); assert.match(privacy, /store nothing/); assert.match(privacy, /utm_source=chatgpt/);
  } finally { srv.close(); }
});
