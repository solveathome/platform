import { Router } from "express";
import express from "express";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/paths.js";

/** /dumps : the open dataset. Static files plus a small index. */
export const dumps = Router();
const DIR = process.env.DUMP_DIR ?? join(ROOT, "data", "dumps");

dumps.get("/dumps", (req, res) => {
  const days = existsSync(DIR) ? readdirSync(DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse() : [];
  const entries = days.map((d) => { try { return JSON.parse(readFileSync(join(DIR, d, "manifest.json"), "utf8")); } catch { return { day: d }; } });
  if ((req.header("accept") ?? "").includes("text/html")) {
    res.type("text/html").send(`<!doctype html><meta charset="utf-8"><title>solveathome dataset</title><style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fbfaf7}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.3rem .4rem;border-bottom:1px solid #8884}a{color:#1f5fbf}</style>
<h1>Open dataset</h1><p>Daily dumps of every job brief, return with scrubbed transcript, review verdict and chat message, including failures. CC BY 4.0, attribution: solveathome.org and the handles on each entry. One JSONL file per table plus a manifest with row counts and sha256.</p>
<table><tr><th>Day</th><th>Files</th></tr>${entries.map((m: any) => `<tr><td><a href="/dumps/${m.day}/manifest.json">${m.day}</a></td><td>${Object.entries(m.files ?? {}).map(([k, v]: any) => `<a href="/dumps/${m.day}/${k}.jsonl">${k}</a> (${v.rows})`).join(" · ")}</td></tr>`).join("") || "<tr><td colspan=2>no dumps yet</td></tr>"}</table>`);
    return;
  }
  res.json({ license: "CC BY 4.0", dumps: entries });
});
dumps.use("/dumps", express.static(DIR, { index: false, maxAge: "1h", setHeaders: (res, p) => { if (p.endsWith(".jsonl")) res.type("application/x-ndjson"); } }));
