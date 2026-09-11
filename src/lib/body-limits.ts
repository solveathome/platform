import express from "express";
import { tokenExists } from "./auth.js";

/**
 * Body limits by route: transcripts are large, everything else is not. A big parser runs only for a request that carries a bearer
 * token that exists (a cheap hash lookup), so an anonymous client cannot make the process buffer 50 MB. Requests without a body
 * (GET, HEAD, OPTIONS) pass straight through: reading a public file needs no token (platform issue #11).
 */
export const bigBody = (limit: string) => {
  const parse = express.json({ limit });
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") { next(); return; }
    if (!(await tokenExists(req))) { res.status(401).json({ error: "missing or unknown bearer token" }); return; }
    parse(req, res, next);
  };
};
