/**
 * A lane's state of the art (src/lib/lane-state.ts), Oct 12 2026, #sah-sota-trusted-upkeep:
 *   GET  /projects/:slug/state                    every lane's document (markdown, or JSON with Accept: application/json)
 *   GET  /projects/:slug/state/:lane              one lane's document, both sections
 *   POST /projects/:slug/state/:lane/entries      { body_md, source_return_id | source_url, hardware?, throughput? }   any contributor: an unverified entry
 *   PUT  /projects/:slug/state/:lane              { summary_md?, promote?, reject?, through_return_id? }              a reviewer trusted by grant
 * The usual route for a trusted update is an upkeep job, whose return carries the same object as `state_update`; PUT is the same
 * write for a trusted reviewer outside a job.
 */
import { Router } from "express";
import { one, q, projectTransaction } from "../db/index.js";
import { bearer } from "../lib/auth.js";
import { isGrantedTrusted } from "../lib/roles.js";
import { needsSourceReview, SOURCE_REVIEW_MESSAGE } from "../lib/document-publication.js";
import { scrubError } from "./job.js";
import { addEntry, applyStateUpdate, laneBySlug, parseStateUpdate, stateDoc, stateMarkdown, stateTemplate, StateError } from "../lib/lane-state.js";

export const state = Router({ mergeParams: true });

async function project(req: any, res: any, next: any): Promise<void> {
  const p = await one(`SELECT * FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { next("router"); return; }
  req.project = p; next();
}
const json = (req: any) => (req.header("accept") ?? "").includes("application/json");
const base = (req: any) => `${process.env.BASE_URL ?? ""}/projects/${req.project.slug}`;
/** Public text: the same secret and source-transcription rules as a return's report. */
function refused(res: any, body: any): boolean {
  const text = JSON.stringify(body ?? {}), bad = scrubError("body", text);
  if (bad) { res.status(400).json(bad); return true; }
  if (needsSourceReview(text)) { res.status(400).json({ error: SOURCE_REVIEW_MESSAGE }); return true; }
  return false;
}
const fail = (res: any, e: unknown) => { if (e instanceof StateError) { res.status(e.status).json({ error: e.message }); return true; } return false; };

state.get("/state", project, async (req: any, res) => {
  const lanes = await q(`SELECT l.id, l.slug, l.title, l.problem_id FROM lanes l LEFT JOIN lane_states s ON s.lane_id = l.id
    WHERE l.problem_id = $1 AND (l.status = 'open' OR s.version > 0) ORDER BY l.id`, [req.project.id]);
  const docs = [];
  for (const l of lanes) docs.push(await stateDoc(Number(req.project.id), req.project.slug, { ...l, id: Number(l.id), problem_id: Number(l.problem_id) }));
  if (json(req)) { res.json({ lanes: docs }); return; }
  const template = stateTemplate(req.project.slug);
  res.type("text/markdown").send(`# ${req.project.name}: state of the art\n\nOne document per lane, in two sections: Verified (written by reviewers trusted by grant, under the records the server computes) and New, not yet verified (entries any contributor's agent may add). Every assignment brief carries its lane's document.\n\n${docs.map((d) => stateMarkdown(d, base(req), template, false)).join("\n---\n\n")}`);
});

state.get("/state/:lane", project, async (req: any, res) => {
  const lane = await laneBySlug(Number(req.project.id), String(req.params.lane));
  if (!lane) { res.status(404).json({ error: "no lane with that slug in this project" }); return; }
  const doc = await stateDoc(Number(req.project.id), req.project.slug, lane);
  if (json(req)) {
    const versions = await q(`SELECT v.version, v.through_return_id, u.handle, v.model, v.return_id, v.created_at FROM lane_state_versions v LEFT JOIN users u ON u.id = v.user_id WHERE v.lane_id = $1 ORDER BY v.version DESC`, [lane.id]);
    const decided = await q(`SELECT e.id, e.status, e.body_md, e.source_return_id, e.decision_note, e.decided_at, d.handle AS decided_by FROM lane_state_entries e LEFT JOIN users d ON d.id = e.decided_by WHERE e.lane_id = $1 AND e.status <> 'unverified' ORDER BY e.decided_at DESC LIMIT 100`, [lane.id]);
    res.json({ ...doc, versions, decided_entries: decided }); return;
  }
  res.type("text/markdown").send(`# ${req.project.name}\n\n${stateMarkdown(doc, base(req), stateTemplate(req.project.slug), false)}`);
});

state.post("/state/:lane/entries", bearer, project, async (req: any, res) => {
  if (req.termsStale) { res.status(403).json({ error: req.termsStale }); return; }
  if (refused(res, req.body)) return;
  try {
    await projectTransaction(req.project.id, async () => {
      const lane = await laneBySlug(Number(req.project.id), String(req.params.lane));
      if (!lane) throw new StateError(404, "no lane with that slug in this project");
      const id = await addEntry(Number(req.project.id), req.project.slug, lane, req.user, req.model ?? null, req.body ?? {});
      res.json({ ok: true, entry_id: id, status: "unverified", note: `Added to the New, not yet verified section of ${lane.slug}. A trusted upkeep promotes it into the Verified summary, rejects it with a reason, or leaves it: ${base(req)}/state/${lane.slug}` });
    });
  } catch (e) { if (!fail(res, e)) throw e; }
});

state.put("/state/:lane", bearer, project, async (req: any, res) => {
  if (!await isGrantedTrusted(Number(req.project.id), Number(req.user.id), req.user.handle)) { res.status(403).json({ error: "only a reviewer trusted by grant writes a lane's verified state of the art; anyone may add an unverified entry (POST /state/<lane>/entries)" }); return; }
  if (refused(res, req.body)) return;
  try {
    await projectTransaction(req.project.id, async () => {
      const lane = await laneBySlug(Number(req.project.id), String(req.params.lane));
      if (!lane) throw new StateError(404, "no lane with that slug in this project");
      const r = await applyStateUpdate(Number(req.project.id), lane, { id: Number(req.user.id), model: req.model ?? null }, parseStateUpdate(req.body), null);
      res.json({ ok: true, lane: lane.slug, ...r });
    });
  } catch (e) { if (!fail(res, e)) throw e; }
});
