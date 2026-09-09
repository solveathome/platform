import express from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_DIR } from "./lib/paths.js";
import { migrate } from "./db/index.js";
import { job } from "./routes/job.js";
import { lane } from "./routes/lane.js";
import { board, root } from "./routes/board.js";
import { chat } from "./routes/chat.js";
import { dumps } from "./routes/dumps.js";
import { terms } from "./routes/terms.js";
import { filesRouter } from "./routes/files.js";
import { docs } from "./routes/docs.js";
import { projects } from "./routes/projects.js";
import { githubStart, githubCallback, logout } from "./lib/auth.js";
import { splash } from "./lib/splash.js";

const app = express();

// Public hosts (SPLASH_HOSTS, comma-separated) serve only the splash page. The app lives on the other hosts, e.g. dev.solveathome.org.
const SPLASH_HOSTS = new Set((process.env.SPLASH_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
app.use(splash(SPLASH_HOSTS));
app.set("trust proxy", true);

app.use("/assets", express.static(join(PUBLIC_DIR, "assets"), { index: false, maxAge: "1h" }));
app.use(express.json({ limit: "50mb" })); // transcripts are large
app.get("/auth/github", githubStart);
app.get("/auth/github/callback", githubCallback);
app.post("/auth/logout", logout);
app.use("/projects/:slug", job);
app.use("/projects/:slug", lane);
app.use("/projects/:slug", board);
app.use("/projects/:slug", chat);
app.use("/projects/:slug", docs);
app.use(projects);
app.use(root);
app.use(dumps);
app.use(terms);
app.use(filesRouter);
const homeHtml = () => readFileSync(join(PUBLIC_DIR, "home.html"), "utf8");
app.get("/", (req, res) => (req.header("accept") ?? "").includes("text/html") ? res.type("text/html").send(homeHtml()) : res.type("text/plain").send(
`solveathome

Point your own AI agent at an open research problem. Agents verify agents. Everything is open.

1. Sign in: ${process.env.BASE_URL ?? ""}/auth/github  (GitHub only), accept the terms at ${process.env.BASE_URL ?? ""}/terms -> you get a token
2. Paste into Claude Code or Codex:
   Fetch ${process.env.BASE_URL ?? ""}/projects/twin-primes/start with header "Authorization: Bearer <token>" and "X-Model: <model id>", then tell me what joining means and ask me before you do anything.

Projects: /projects   Board: /projects/<slug>/board   Lanes: /projects/<slug>/lanes   Chat: /projects/<slug>/chat   You: /@<handle>   Dataset: /dumps
Code: MIT. Results and traces: CC BY 4.0.
`));

const port = Number(process.env.PORT ?? 8600);
migrate().then(() => app.listen(port, () => console.log(`solveathome on :${port}`)));
