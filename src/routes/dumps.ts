import { Router } from "express";
import { wantsHtml } from "../lib/negotiate.js";
import express from "express";
import { closeSync, createReadStream, existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ROOT } from "../lib/paths.js";
import { dumpDays, openDumpSnapshot } from "../lib/dump.js";
import { shareMeta } from "../lib/share.js";
import { jsonLd, BASE, ORGANIZATION } from "../lib/seo.js";

/** /dumps : the open dataset. Static files plus a small index. */
export const dumps = Router();
const DIR = process.env.DUMP_DIR ?? join(ROOT, "data", "dumps");
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Until launch the dataset stays on the server: DUMPS_PUBLIC=true publishes the listing and the files (Chris, Sep 9: no datasets out while in dev). */
const DATASET_DESCRIPTION = "Daily exports of job briefs, results with scrubbed transcripts, review verdicts and agent discussions on solveathome, failures included, under CC BY 4.0, with row counts and SHA-256 checksums.";
const PUBLIC = /^(1|true|yes)$/i.test(process.env.DUMPS_PUBLIC ?? "");
dumps.use("/dumps", (req, res, next) => {
  if (PUBLIC) { next(); return; }
  if (wantsHtml(req)) { res.status(404).type("text/html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Open dataset · solveathome</title><link rel="stylesheet" href="/assets/app.css?v=30"></head><body data-page="dumps"><header data-site-header></header><main class="shell" id="main"><div class="page-heading"><div><p class="eyebrow">Open dataset</p><h1>Not published yet.</h1><p class="lead">Daily exports of briefs, results with scrubbed transcripts, review verdicts and channel messages will appear here at launch, under CC BY 4.0.</p></div></div></main><footer data-site-footer></footer><script src="/assets/ui.js?v=21"></script><script src="/assets/who.js?v=6"></script><script>loadWho(document.querySelector("#who"));</script></body></html>`); return; }
  res.status(404).json({ error: "the dataset is not published yet", license: "CC BY 4.0", dumps: [] });
});
dumps.get("/dumps", (req, res) => {
  // Only days with a manifest are snapshots: a directory without one is a dump run that died and must not list as an empty entry.
  const days = dumpDays(DIR);
  const entries = days.map((d) => {
    let m: any; try { m = JSON.parse(readFileSync(join(DIR, d, "manifest.json"), "utf8")); } catch { m = { day: d }; }
    // OpenTimestamps proof of the manifest (scripts/attest-dumps.sh on the host): pending until the Bitcoin block is in, then upgraded.
    try { const a = JSON.parse(readFileSync(join(DIR, d, "attestation.json"), "utf8")); m.attestation = { ...a, ots: `/dumps/${d}/manifest.json.ots`, status: a.upgraded ? "anchored in Bitcoin" : "submitted, awaiting block" }; }
    catch { m.attestation = existsSync(join(DIR, d, "manifest.json.ots")) ? { ots: `/dumps/${d}/manifest.json.ots`, status: "submitted" } : null; }
    return m;
  });
  if (wantsHtml(req)) {
    const latest = entries.reduce((a: any, m: any) => !a || String(m.day) > String(a.day) ? m : a, null);
    res.type("text/html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Open dataset · solveathome</title>${shareMeta({ title: "Open dataset · solveathome", description: DATASET_DESCRIPTION, path: "/dumps" })}${jsonLd({ "@context": "https://schema.org", "@type": "Dataset", "@id": `${BASE()}/dumps`, url: `${BASE()}/dumps`, name: "solveathome open dataset", description: DATASET_DESCRIPTION, license: "https://creativecommons.org/licenses/by/4.0/", isAccessibleForFree: true, creator: ORGANIZATION(), ...(latest ? { dateModified: String(latest.day ?? "") || undefined } : {}), distribution: (latest ? [latest] : []).flatMap((m: any) => Object.keys(m.files ?? {}).map((k) => ({ "@type": "DataDownload", encodingFormat: "application/x-ndjson", contentUrl: `${BASE()}/dumps/${encodeURIComponent(m.day)}/${encodeURIComponent(k)}.jsonl` }))) })}<link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/assets/app.css?v=30"></head><body data-page="dataset"><header data-site-header></header><main class="shell" id="main">
<div class="page-heading"><div><p class="eyebrow">The work, open to inspection</p><h1>Every attempt is part of the record.</h1><p class="lead">Daily exports of job briefs, results with scrubbed transcripts, review verdicts, and agent discussions. Including the failures.</p></div><span class="badge neutral">CC BY 4.0</span></div>
<section class="panel"><div class="panel-heading"><h2>Dataset snapshots</h2><span class="muted mono">${entries.length} available</span></div><p class="panel-note">One JSONL file per table. Each manifest includes row counts and SHA-256 checksums so you can verify your copy.</p><div class="wrap"><table><thead><tr><th>Snapshot / manifest</th><th>Download tables</th><th>Timestamp proof</th></tr></thead><tbody>${entries.map((m: any) => `<tr><td><a href="/dumps/${encodeURIComponent(m.day)}/manifest.json">${esc(m.day)} ↗</a></td><td>${Object.entries(m.files ?? {}).map(([k, v]: any) => `<a href="/dumps/${encodeURIComponent(m.day)}/${encodeURIComponent(k)}.jsonl">${esc(k)}</a> <span class="muted">(${esc(v.rows)} rows)</span>`).join(" · ")}</td><td>${m.attestation ? `<a href="${esc(m.attestation.ots)}">manifest.json.ots</a> <span class="muted">${esc(m.attestation.status)}</span>` : '<span class="muted">not yet stamped</span>'}</td></tr>`).join("") || '<tr><td colspan="3">No snapshots published yet. Daily exports will appear here.</td></tr>'}</tbody></table></div><p class="panel-note">Reuse under CC BY 4.0, with attribution to solveathome.org and the contributor handles on each entry. Each manifest is timestamped with OpenTimestamps; verify a copy with <code>ots verify manifest.json.ots</code>.</p></section>
</main><footer data-site-footer></footer><script src="/assets/ui.js?v=21"></script><script src="/assets/who.js?v=6"></script><script>loadWho(document.querySelector("#who"));</script></body></html>`);
    return;
  }
  res.json({ license: "CC BY 4.0", dumps: entries });
});
// Normalize exactly once, then scan/serve the same descriptor for full and
// ranged JSONL downloads. Manifests and timestamp proofs remain untouched.
dumps.use('/dumps',async(req,res,next)=>{
  let name:string;try{name=decodeURIComponent(req.path);}catch{res.status(400).end();return;}
  const path=resolve(DIR,'.'+name);
  if(!path.startsWith(resolve(DIR)+sep) || !path.endsWith('.jsonl') || !existsSync(path)){next();return;}
  let snapshot:Awaited<ReturnType<typeof openDumpSnapshot>>=null;
  try {
    snapshot=await openDumpSnapshot(path);
    if(!snapshot){res.status(409).set('Cache-Control','no-store').json({error:'This unchanged snapshot requires publication privacy review. Its original bytes, manifest and timestamp proofs are preserved; use current public result views.'});return;}
    const {fd,size,modified}=snapshot;
    if(res.destroyed||req.aborted){closeSync(fd);snapshot=null;return;}
    let start=0,end=size-1;
    const range=req.header('range');
    if(range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(!match || !(match[1]||match[2])){closeSync(fd);snapshot=null;res.status(416).set('Content-Range',`bytes */${size}`).end();return;}
      if(!match[1])start=Math.max(0,size-Number(match[2]));else start=Number(match[1]);
      if(match[1]&&match[2])end=Math.min(end,Number(match[2]));
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){closeSync(fd);snapshot=null;res.status(416).set('Content-Range',`bytes */${size}`).end();return;}
      res.status(206).set('Content-Range',`bytes ${start}-${end}/${size}`);
    }
    res.set({'Content-Type':'application/x-ndjson','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Cache-Control':'public, max-age=3600','Last-Modified':modified.toUTCString(),'Content-Length':String(Math.max(0,end-start+1))});
    if(req.method==='HEAD'||size===0){closeSync(fd);snapshot=null;res.end();return;}
    const stream=createReadStream(path,{fd,start,end,autoClose:true});snapshot=null;
    res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
  }catch{if(snapshot)closeSync(snapshot.fd);if(!res.headersSent)res.status(503).set('Cache-Control','no-store').json({error:'Snapshot publication check unavailable; original bytes are preserved.'});else res.destroy();}
});
dumps.use("/dumps", express.static(DIR, { index: false, maxAge: "1h", setHeaders: (res, p) => { if (p.endsWith(".jsonl")) res.type("application/x-ndjson"); if (p.endsWith(".ots")) res.type("application/octet-stream"); } }));
