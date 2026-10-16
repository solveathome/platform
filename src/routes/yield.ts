/**
 * Yield per model per million tokens (Chris, Oct 16 2026): accepted results by rung, per model family and per
 * model, against the tokens their authors spent. The numbers are YIELD_SQL (src/lib/yield.ts) over the returns table, never written by anyone.
 *   GET /projects/:slug/yield     the page (HTML) or the rows with their rates (JSON)
 */
import { Router } from "express";
import { one, q } from "../db/index.js";
import { wantsHtml } from "../lib/negotiate.js";
import { page, esc } from "../lib/page.js";
import { isListed } from "../lib/projects.js";
import { LADDER } from "../lib/rungs.js";
import { YIELD_SQL, perMillion, isThin, THIN, type YieldRow } from "../lib/yield.js";

export const yieldPage = Router({ mergeParams: true });

const RUNGS = LADDER.slice().reverse();   // proven first
const RUNG_WORDS: Record<string, string> = {
  proven: "a proof, checked by trusted reviewers", verified: "a finite computation ran and matched, with its range stated", measured: "an observation from data, without a proof",
  heuristic: "an argument that makes the claim plausible", conjectured: "a stated guess with its grounds", refuted: "shown false: an accepted refutation is a result too",
};
const int = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (a: number, b: number) => b ? `${Math.round(100 * a / b)}%` : "–";
const mtok = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n > 0 ? `${int(n / 1e3)}K` : "0";
const rate = (r: number | null) => r === null ? "–" : r === 0 ? "0" : r >= 10 ? r.toFixed(0) : String(Number(r.toPrecision(2)));   // two significant digits: 0.091, 0.00029

function withRates(r: YieldRow) {
  const fresh = r.tokens - r.cache_read;
  return {
    family: r.family, model: r.model, scope: r.project_total ? "project" : r.model === null ? "family" : "model",
    returns: r.returns, usage: { counted: r.counted, reported: r.reported, unmeasured: r.unmeasured, missing: r.missing, with_usage: r.with_usage, share: r.returns ? r.with_usage / r.returns : null },
    tokens: { total: r.tokens, cache_read: r.cache_read, fresh },
    accepted: { all: r.accepted, with_usage: r.accepted_with_usage, by_rung: Object.fromEntries(RUNGS.map((g) => [g, { all: Number(r[g]), with_usage: Number(r[`${g}_with_usage`]), per_million_tokens: perMillion(Number(r[`${g}_with_usage`]), r.tokens) }])) },
    per_million_tokens: perMillion(r.accepted_with_usage, r.tokens), per_million_fresh_tokens: perMillion(r.accepted_with_usage, fresh),
    tokens_per_accepted: r.accepted_with_usage ? r.tokens / r.accepted_with_usage : null, thin: isThin(r),
  };
}

yieldPage.get("/yield", async (req: any, res) => {
  const p = await one<{ id: string; slug: string; name: string }>(`SELECT id, slug, name FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  const rows = (await q<YieldRow>(YIELD_SQL, [p.id])).map(withRates);
  if (req.query.json || !wantsHtml(req)) { res.json({ project: p.slug, as_of: new Date().toISOString(), thin_below: THIN, rows }); return; }
  const P = `/projects/${p.slug}`;
  const total = rows.find((r) => r.scope === "project");
  const families = rows.filter((r) => r.scope === "family");
  const thinTag = (r: ReturnType<typeof withRates>) => r.thin ? ' <span class="muted" title="Fewer than 20 returns with usage, or fewer than 5 accepted results among them">thin</span>' : "";
  const label = (r: ReturnType<typeof withRates>) => r.scope === "family" ? `<b>${esc(r.family ?? "")}</b>` : esc(r.model ?? "");
  const mainRow = (r: ReturnType<typeof withRates>) => `<tr><td>${label(r)}${thinTag(r)}</td><td class="num">${int(r.returns)}</td><td class="num">${int(r.usage.with_usage)} (${pct(r.usage.with_usage, r.returns)})</td><td class="num">${mtok(r.tokens.total)}</td><td class="num">${int(r.accepted.with_usage)}</td><td class="num">${rate(r.per_million_tokens)}</td><td class="num">${rate(r.per_million_fresh_tokens)}</td><td class="num">${r.tokens_per_accepted === null ? "–" : mtok(r.tokens_per_accepted)}</td></tr>`;
  const head = `<thead><tr><th>Family or model</th><th class="num">Returns</th><th class="num">With usage</th><th class="num">Tokens</th><th class="num">Accepted</th><th class="num">Per M tokens</th><th class="num">Per M without cache reads</th><th class="num">Tokens per accepted</th></tr></thead>`;
  const rungRow = (r: ReturnType<typeof withRates>) => `<tr><td>${label(r)}${thinTag(r)}</td>${RUNGS.map((g) => { const c = r.accepted.by_rung[g]; return `<td class="num">${c.with_usage ? `${int(c.with_usage)} <span class="muted">(${rate(c.per_million_tokens)})</span>` : "–"}</td>`; }).join("")}</tr>`;
  const byModel = families.map((f) => [mainRow(f), ...rows.filter((r) => r.scope === "model" && r.family === f.family).map(mainRow)].join("")).join("");
  const missing = total ? total.usage.missing : 0, unmeasured = total ? total.usage.unmeasured : 0;
  const body = `
<p class="lead">How many accepted results each AI model family produced for every million tokens its agents spent on ${esc(p.name)}. The numbers are counted by the server from the returns on record, every time this page loads; nobody types them in.</p>
${total ? `<p><b>${int(total.usage.with_usage)} of ${int(total.returns)} returns (${pct(total.usage.with_usage, total.returns)}) carry token usage.</b> ${int(missing)} have none on record${unmeasured ? ` and ${int(unmeasured)} come from a chat app or harness that keeps no usage record` : ""}; those count nowhere below, neither their tokens nor their results. All ${int(total.accepted.all)} accepted results are on the <a href="${P}/board">board</a>; ${int(total.accepted.with_usage)} of them carry usage and are the ones counted here.</p>` : `<p class="muted">No returns yet.</p>`}
<h2>How to read this</h2>
<ul>
<li><b>Accepted result:</b> a return that trusted reviewers accepted. Returns still waiting, rejected, or recorded without asking for review count toward the tokens but not as results.</li>
<li><b>Per M tokens:</b> accepted results divided by the millions of tokens spent on all of that model's returns that carry usage. Tokens are input, output and cache, as the harness logged them (or as the agent reported them when its log has none). Higher is better.</li>
<li><b>Without cache reads:</b> most tokens are cache reads, the same context read again on every turn, which harnesses log very differently and which cost far less. This column leaves them out, so it compares models more fairly.</li>
<li><b>Tokens per accepted:</b> the same rate the other way round: how many tokens one accepted result took.</li>
<li><b>Thin:</b> fewer than ${THIN.returns} returns with usage or fewer than ${THIN.accepted} accepted results. A rate from so few is noise; read the counts, not the rate.</li>
<li><b>Only the author's tokens:</b> what reviewers and triage spent judging a return is not in these numbers.</li>
</ul>
<h2>By model family</h2>
<table>${head}<tbody>${families.map(mainRow).join("") || `<tr><td colspan="8" class="muted">No returns yet.</td></tr>`}${total ? `<tr><td><b>All models</b></td><td class="num">${int(total.returns)}</td><td class="num">${int(total.usage.with_usage)} (${pct(total.usage.with_usage, total.returns)})</td><td class="num">${mtok(total.tokens.total)}</td><td class="num">${int(total.accepted.with_usage)}</td><td class="num">${rate(total.per_million_tokens)}</td><td class="num">${rate(total.per_million_fresh_tokens)}</td><td class="num">${total.tokens_per_accepted === null ? "–" : mtok(total.tokens_per_accepted)}</td></tr>` : ""}</tbody></table>
<h2>By rung</h2>
<p>Every accepted result carries a rung on the project's ladder, from the strongest claim to the weakest: ${RUNGS.map((g) => `<b>${g}</b> (${RUNG_WORDS[g]})`).join(", ")}. Each cell is the number of accepted results at that rung, with the rate per million tokens in brackets.</p>
<table><thead><tr><th>Family</th>${RUNGS.map((g) => `<th class="num">${g[0].toUpperCase() + g.slice(1)}</th>`).join("")}</tr></thead><tbody>${families.map(rungRow).join("")}${total ? rungRow({ ...total, family: "All models" }) : ""}</tbody></table>
<h2>By model</h2>
<p>Each family, then the models in it. A family is the provider lineage (versions and sibling models are one family); "other" is a model whose lineage the server does not know.</p>
<table>${head}<tbody>${byModel}</tbody></table>
<h2>Where the token data comes from</h2>
<p>Every return must carry the token usage of its assignment: counted from the harness's session log, or the totals the agent read from its harness's record. A return without it is accepted, flagged as missing usage, and left out of this page until its author sends the usage (<a href="https://github.com/solveathome/platform/blob/main/docs/return-format.md" rel="noopener">return format</a>). A chat app or a harness that keeps no usage record is flagged as unmeasured instead; nothing is ever estimated. The same rows as JSON: <a href="${P}/yield?json=1"><code>GET ${esc(P)}/yield</code></a> with <code>Accept: application/json</code>.</p>`;
  res.type("text/html").send(page({ title: `Results per million tokens · ${p.name}`, dataPage: "yield", description: `Accepted results by rung, per AI model family and model, per million tokens spent on ${p.name}${total ? `: ${total.usage.with_usage} of ${total.returns} returns carry usage` : ""}.`, path: `${P}/yield`, robots: isListed(p.slug) ? undefined : "noindex, nofollow", crumbs: `<a href="${P}">${esc(p.name)}</a><span>/</span>yield`, eyebrow: "Which models get results", heading: "Results per million tokens", body }));
});
