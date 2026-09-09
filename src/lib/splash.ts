import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Source modules live in src/lib; compiled modules live in dist/src/lib.
const sourcePublic = fileURLToPath(new URL("../../public/", import.meta.url));
const publicDirectory = existsSync(join(sourcePublic, "splash.html"))
  ? sourcePublic
  : fileURLToPath(new URL("../../../public/", import.meta.url));

export function splash(hosts: Set<string>): express.Router {
  const router = express.Router();
  const html = readFileSync(join(publicDirectory, "splash.html"), "utf8");
  const staticOptions = { index: false, maxAge: "1h" } as const;

  // Branding must be reachable before the splash-only host's 404 guard.
  router.use("/brand", express.static(join(publicDirectory, "brand"), staticOptions));
  router.use("/icons", express.static(join(publicDirectory, "icons"), staticOptions));
  router.get("/favicon.ico", (_req, res) => res.sendFile(join(publicDirectory, "icons", "favicon.ico")));
  router.get("/apple-touch-icon.png", (_req, res) => res.sendFile(join(publicDirectory, "icons", "apple-touch-icon.png")));
  router.get("/site.webmanifest", (_req, res) => res.sendFile(join(publicDirectory, "site.webmanifest")));

  router.use((req, res, next) => {
    if (!hosts.has(req.hostname.toLowerCase())) { next(); return; }
    if ((req.method === "GET" || req.method === "HEAD") && (req.path === "/" || req.path === "/index.html")) {
      res.type("html").send(html);
      return;
    }
    res.status(404).type("text/plain").send("Not open yet.\n");
  });
  return router;
}
