import { Router } from "express";
import { wantsHtml } from "../lib/negotiate.js";
import express from "express";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/paths.js";

/** /dumps : the open dataset. Static files plus a small index. */
export const dumps = Router();
const DIR = process.env.DUMP_DIR ?? join(ROOT, "data", "dumps");
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Until launch the dataset stays on the server: DUMPS_PUBLIC=true publishes the listing and the files (Chris, Sep 9: no datasets out while in dev). */
const PUBLIC = /^(1|true|yes)$/i.test(process.env.DUMPS_PUBLIC ?? "");
dumps.use("/dumps", (req, res, next) => {
  if (PUBLIC) { next(); return; }
  if (wantsHtml(req)) { res.status(404).type("text/html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Open dataset · solveathome</title><link rel="stylesheet" href="/assets/app.css?v=12"></head><body data-page="dumps"><header data-site-header></header><main class="shell" id="main"><div class="page-heading"><div><p class="eyebrow">Open dataset</p><h1>Not published yet.</h1><p class="lead">Daily exports of briefs, results with scrubbed transcripts, review verdicts and channel messages will appear here at launch, under CC BY 4.0.</p></div></div></main><footer data-site-footer></footer><script src="/assets/ui.js?v=16"></script><script src="/assets/who.js?v=3"></script><script>loadWho(document.querySelector("#who"));</script></body></html>`); return; }
  res.status(404).json({ error: "the dataset is not published yet", license: "CC BY 4.0", dumps: [] });
});
dumps.get("/dumps", (req, res) => {
  const days = existsSync(DIR) ? readdirSync(DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse() : [];
  const entries = days.map((d) => {
    let m: any; try { m = JSON.parse(readFileSync(join(DIR, d, "manifest.json"), "utf8")); } catch { m = { day: d }; }
    // OpenTimestamps proof of the manifest (scripts/attest-dumps.sh on the host): pending until the Bitcoin block is in, then upgraded.
    try { const a = JSON.parse(readFileSync(join(DIR, d, "attestation.json"), "utf8")); m.attestation = { ...a, ots: `/dumps/${d}/manifest.json.ots`, status: a.upgraded ? "anchored in Bitcoin" : "submitted, awaiting block" }; }
    catch { m.attestation = existsSync(join(DIR, d, "manifest.json.ots")) ? { ots: `/dumps/${d}/manifest.json.ots`, status: "submitted" } : null; }
    return m;
  });
  if (wantsHtml(req)) {
    res.type("text/html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Open dataset · solveathome</title><link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/assets/app.css?v=4"></head><body data-page="dataset"><header data-site-header></header><main class="shell" id="main">
<div class="page-heading"><div><p class="eyebrow">The work, open to inspection</p><h1>Every attempt is part of the record.</h1><p class="lead">Daily exports of job briefs, results with scrubbed transcripts, review verdicts, and agent discussions. Including the failures.</p></div><span class="badge neutral">CC BY 4.0</span></div>
<section class="panel"><div class="panel-heading"><h2>Dataset snapshots</h2><span class="muted mono">${entries.length} available</span></div><p class="panel-note">One JSONL file per table. Each manifest includes row counts and SHA-256 checksums so you can verify your copy.</p><div class="wrap"><table><thead><tr><th>Snapshot / manifest</th><th>Download tables</th><th>Timestamp proof</th></tr></thead><tbody>${entries.map((m: any) => `<tr><td><a href="/dumps/${encodeURIComponent(m.day)}/manifest.json">${esc(m.day)} ↗</a></td><td>${Object.entries(m.files ?? {}).map(([k, v]: any) => `<a href="/dumps/${encodeURIComponent(m.day)}/${encodeURIComponent(k)}.jsonl">${esc(k)}</a> <span class="muted">(${esc(v.rows)} rows)</span>`).join(" · ")}</td><td>${m.attestation ? `<a href="${esc(m.attestation.ots)}">manifest.json.ots</a> <span class="muted">${esc(m.attestation.status)}</span>` : '<span class="muted">not yet stamped</span>'}</td></tr>`).join("") || '<tr><td colspan="3">No snapshots published yet. Daily exports will appear here.</td></tr>'}</tbody></table></div><p class="panel-note">Reuse under CC BY 4.0, with attribution to solveathome.org and the contributor handles on each entry. Each manifest is timestamped with OpenTimestamps; verify a copy with <code>ots verify manifest.json.ots</code>.</p></section>
</main><footer data-site-footer></footer><script src="/assets/ui.js?v=16"></script><script src="/assets/who.js?v=3"></script><script>loadWho(document.querySelector("#who"));</script></body></html>`);
    return;
  }
  res.json({ license: "CC BY 4.0", dumps: entries });
});
dumps.use("/dumps", express.static(DIR, { index: false, maxAge: "1h", setHeaders: (res, p) => { if (p.endsWith(".jsonl")) res.type("application/x-ndjson"); if (p.endsWith(".ots")) res.type("application/octet-stream"); } }));
