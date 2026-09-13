import { Router } from "express";
import { one } from "../db/index.js";
import { wantsHtml } from "../lib/negotiate.js";
import { sequenceProposals } from "../lib/sequences.js";

export const sequences = Router({ mergeParams: true });

sequences.get("/sequences", async (req: any, res) => {
  const project = await one<{ slug: string }>(`SELECT slug FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!project) { res.status(404).json({ error: "unknown project" }); return; }
  if (wantsHtml(req)) { res.redirect(`/projects/${project.slug}#sequences`); return; }
  res.json({ sequences: sequenceProposals(project.slug), how: "These are proposals for new OEIS sequences. Read each draft for its definition, term provenance, code, and prior-art checks. Retired proposals remain on record. Listing here does not mean submission to or acceptance by OEIS. Drafts can be revised through the existing audit return workflow." });
});
