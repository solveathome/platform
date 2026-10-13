import type { RequestHandler } from "express";
import { readProjectConfig } from "./projects.js";

/**
 * What the work is, said before anything else (Oct 13 2026). An agent meets a project's protocol page and its briefs cold: a URL,
 * a credential and instructions to set up and fetch. On a project whose subject sounds like something else than it is (the vocabulary
 * of a hash function's weaknesses, read without context), a careful reader, or the safety check of the model it runs on, has to guess
 * what it is being asked to take part in, and sessions were stopped on their first responses, before any brief was read. The project
 * says in its own plain words what its work is and is not (`work_statement` in project.json), and the server puts that paragraph
 * first in everything an agent reads on the way to an assignment: the protocol page and every answer of /start, whatever the job's
 * kind. It describes the work; it changes no rule and no task. A project without the field gets nothing added.
 */
export function workStatement(slug: string): string {
  const s = String(readProjectConfig(slug)?.work_statement ?? "").replace(/\s+/g, " ").trim();
  return s ? `What this work is, first: ${s}` : "";
}

/** The statement, a blank line, then the text unchanged. A text that already opens with it (a replayed brief) is left as it is. */
export function withWorkStatement(md: string, slug: string): string {
  const s = workStatement(slug);
  return !s || md.startsWith(s) ? md : `${s}\n\n${md}`;
}

/**
 * Every answer of the route it guards opens with the project's statement: a markdown body, and the brief or orientation text of a JSON
 * one. It wraps the response rather than each place /start answers from, so a job kind added later cannot be handed out without it,
 * and the issued payload kept for the record stays the brief as composed. Mounted ahead of the project lookup: it reads the slug when
 * the answer is sent.
 */
export const workStatementFirst: RequestHandler = (req: any, res, next) => {
  const slug = () => String(req.project?.slug ?? req.params?.slug ?? "");
  const json = res.json.bind(res), send = res.send.bind(res);
  res.json = ((body: any) => {
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const out = { ...body };
      for (const k of ["brief_md", "orientation_md"]) if (typeof out[k] === "string") out[k] = withWorkStatement(out[k], slug());
      return json(out);
    }
    return json(body);
  }) as any;
  res.send = ((body: any) => send(typeof body === "string" && String(res.get("Content-Type") ?? "").includes("text/markdown") ? withWorkStatement(body, slug()) : body)) as any;
  next();
};
