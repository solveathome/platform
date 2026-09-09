import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Repo root: walk up from this file until package.json is found. Works from src/ (tsx) and dist/src/ (node). */
function findRoot(from: string): string {
  let d = from;
  for (let i = 0; i < 8; i++) { if (existsSync(join(d, "package.json"))) return d; d = dirname(d); }
  throw new Error("repo root not found from " + from);
}
export const ROOT = findRoot(dirname(fileURLToPath(import.meta.url)));
export const PUBLIC_DIR = join(ROOT, "public");
