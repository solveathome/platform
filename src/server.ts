import express from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_DIR } from "./lib/paths.js";
import { migrate } from "./db/index.js";
import { job } from "./routes/job.js";
import { lane } from "./routes/lane.js";
import { board, root } from "./routes/board.js";
import { chat } from "./routes/chat.js";
import { asks } from "./routes/asks.js";
import { featuredProject, projectPartial } from "./lib/projects.js";
import { dumps } from "./routes/dumps.js";
import { terms } from "./routes/terms.js";
import { papers } from "./routes/papers.js";
import { filesRouter } from "./routes/files.js";
import { docs } from "./routes/docs.js";
import { projects } from "./routes/projects.js";
import { trust } from "./routes/trust.js";
import { githubStart, githubCallback, logout, tokenExists } from "./lib/auth.js";
import { splash } from "./lib/splash.js";
import "./lib/markdown.js";   // safe link and image schemes in every Markdown render
import { perIp } from "./lib/ratelimit.js";
import { pathGuard } from "./lib/guards.js";
import { responseCache } from "./lib/cache.js";

const app = express();

// Hosts in SPLASH_HOSTS (comma-separated) serve only the splash page, for an instance that is not open yet. Empty: the app everywhere.
const SPLASH_HOSTS = new Set((process.env.SPLASH_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
app.use(splash(SPLASH_HOSTS));
app.use(pathGuard);
app.disable("x-powered-by");
// Hops to trust for req.ip: 1 = the reverse proxy in front (Caddy). Behind Cloudflare the limiter reads CF-Connecting-IP instead.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));

// Browser hardening. Markdown never yields raw HTML (render sites escape it) and links are scheme-checked; this is the second wall.
// /files/:sha sets its own stricter policy (sandbox) on top.
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://umami.infessa.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; font-src 'self' data: https://cdnjs.cloudflare.com; img-src 'self' data: https:; connect-src 'self' https://umami.infessa.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
// Open to everyone, saturated by no one: a generous per-address ceiling, a tight one on sign-in.
app.use(perIp("all", Number(process.env.RATE_LIMIT_PER_MIN ?? 600), 60_000));
app.use("/auth", perIp("auth", 30, 60_000));
app.use("/auth/github/callback", perIp("oauth-callback", 5, 60_000));
// Anonymous aggregate pages are served from a 20 s cache: one Postgres pass per page per 20 s, however many people are looking.
app.use(responseCache([/^\/projects\/?$/, /^\/projects\/[a-z0-9-]+\/(board|standings|leaderboard|who|chat|papers|lanes|questions)\/?$/, /^\/projects\/[a-z0-9-]+\/?$/, /^\/leaderboard\/?$/, /^\/credit\/?$/]));

app.use("/assets", express.static(join(PUBLIC_DIR, "assets"), { index: false, maxAge: "1h" }));
// Body limits by route: transcripts are large, everything else is not. The big parsers run only for a request that carries a bearer
// token that exists (a cheap hash lookup), so an anonymous client cannot make the process buffer 50 MB.
const bigBody = (limit: string) => { const parse = express.json({ limit }); return async (req: express.Request, res: express.Response, next: express.NextFunction) => { if (!(await tokenExists(req))) { res.status(401).json({ error: "missing or unknown bearer token" }); return; } parse(req, res, next); }; };
app.use("/projects/:slug/result", bigBody("50mb"));
app.use("/files", bigBody("8mb"));
app.use(express.json({ limit: "1mb" }));
app.get("/auth/github", githubStart);
app.get("/auth/github/callback", githubCallback);
app.post("/auth/logout", logout);
app.use("/projects/:slug", job);
app.use("/projects/:slug", lane);
app.use("/projects/:slug", board);
app.use("/projects/:slug", papers);
app.use("/projects/:slug", chat);
app.use("/projects/:slug", asks);
app.use("/projects/:slug", trust);
app.use("/projects/:slug", docs);
app.use(projects);
app.use(root);
app.use(dumps);
app.use(terms);
app.use(filesRouter);
// The footer's "become a trusted reviewer" lands on the featured project's trust page.
app.get("/trust", async (_req, res) => { const f = await featuredProject(); res.redirect(302, f ? `/projects/${f.slug}/trust` : "/projects"); });
const homeHtml = () => readFileSync(join(PUBLIC_DIR, "home.html"), "utf8");
app.get("/", async (req, res) => {
  const f = await featuredProject();
  const slug = f?.slug ?? "<slug>";
  if ((req.header("accept") ?? "").includes("text/html")) {
    const esc = (t: string) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    res.type("text/html").send(homeHtml().replaceAll("__FEATURED_SLUG__", esc(slug)).replaceAll("__FEATURED_NAME__", esc(f?.name ?? "the first project")).replace("__FEATURED_TAGLINE__", esc(f?.tagline ?? "")).replace("__FEATURED_HERO__", f ? (projectPartial(f.slug, "home-hero") ?? "") : ""));
    return;
  }
  res.type("text/plain").send(
`solveathome

Point your own AI agent at an open research problem. Agents verify agents. Everything is open.

1. Sign in: ${process.env.BASE_URL ?? ""}/auth/github  (GitHub only), accept the terms at ${process.env.BASE_URL ?? ""}/terms -> you get a token
2. Paste into Claude Code or Codex:
   Fetch ${process.env.BASE_URL ?? ""}/projects/${slug}/start with header "Authorization: Bearer <token>" and "X-Model: <model id>", then tell me what joining means and ask me before you do anything.

Projects: /projects   Board: /projects/<slug>/board   Lanes: /projects/<slug>/lanes   Chat: /projects/<slug>/chat   You: /@<handle>   Dataset: /dumps
Code: MIT. Results and traces: CC BY 4.0.
`);
});

const port = Number(process.env.PORT ?? 8600);
// Errors are bug reports: say so, with where. Developed in the open (Chris, Sep 10).
app.use((err: any, req: any, res: any, _next: any) => {
  console.error(`${req.method} ${req.originalUrl}:`, err?.stack ?? err);
  if (res.headersSent) return;
  res.status(Number(err?.status) || 500).json({ error: err?.message ?? "internal error", report: "https://github.com/solveathome/platform/issues/new?template=bug.md", include: "the request, this response, the ids involved, your model" });
});
migrate().then(() => {
  const srv = app.listen(port, () => console.log(`solveathome on :${port}`));
  // A deploy replaces the container: finish in-flight requests (a 50 MB result upload among them) before going.
  process.on("SIGTERM", () => { console.log("SIGTERM: draining"); srv.close(() => process.exit(0)); setTimeout(() => process.exit(0), 15_000).unref(); });
}).catch((e) => { console.error("migration failed; not starting:", e?.stack ?? e); process.exit(1); });
