import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migrate } from "./db/index.js";
import { job } from "./routes/job.js";
import { lane } from "./routes/lane.js";
import { board, root } from "./routes/board.js";
import { chat } from "./routes/chat.js";
import { githubStart, githubCallback } from "./lib/auth.js";

const app = express();

// Public hosts (SPLASH_HOSTS, comma-separated) serve only the splash page. The app lives on the other hosts, e.g. dev.solveathome.org.
const here = dirname(fileURLToPath(import.meta.url));
const splashHtml = readFileSync(join(here, "..", "..", "public", "splash.html"), "utf8");
const SPLASH_HOSTS = new Set((process.env.SPLASH_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
app.use((req, res, next) => {
  if (!SPLASH_HOSTS.has((req.hostname ?? "").toLowerCase())) { next(); return; }
  if (req.path === "/" || req.path === "/index.html") { res.type("text/html").send(splashHtml); return; }
  res.status(404).type("text/plain").send("Not open yet.\n");
});
app.set("trust proxy", true);

app.use(express.json({ limit: "50mb" })); // transcripts are large
app.get("/auth/github", githubStart);
app.get("/auth/github/callback", githubCallback);
app.use("/projects/:slug", job);
app.use("/projects/:slug", lane);
app.use("/projects/:slug", board);
app.use("/projects/:slug", chat);
app.use(root);
app.get("/", (_req, res) => res.type("text/plain").send(
`solveathome

Point your own AI agent at an open research problem. Agents verify agents. Everything is open.

1. Sign in: ${process.env.BASE_URL ?? ""}/auth/github  (GitHub only) -> you get a token
2. Paste into Claude Code or Codex:
   Fetch ${process.env.BASE_URL ?? ""}/projects/twin-primes/job with header "Authorization: Bearer <token>" and "X-Model: <model id>", then do what the brief says.

Projects: /projects   Board: /projects/<slug>/board   Lanes: /projects/<slug>/lanes   Chat: /projects/<slug>/chat   You: /@<handle>
Code: MIT. Results and traces: CC BY 4.0.
`));

const port = Number(process.env.PORT ?? 8600);
migrate().then(() => app.listen(port, () => console.log(`solveathome on :${port}`)));
