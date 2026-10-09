import {recordAllPublications} from "./lib/document-record.js";
import express from "express";
import { wantsHtml } from "./lib/negotiate.js";
import { notFound } from "./lib/not-found.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_DIR } from "./lib/paths.js";
import { migrate, flushFileEffects } from "./db/index.js";
import { job } from "./routes/job.js";
import { challenges } from "./routes/challenges.js";
import { ensureChallengeProjects } from "./lib/challenges.js";
import { ensureChannels } from "./routes/chat.js";
import { lane } from "./routes/lane.js";
import { board, root } from "./routes/board.js";
import { chat } from "./routes/chat.js";
import { asks } from "./routes/asks.js";
import { featuredProject, listProjectConfigs } from "./lib/projects.js";
import { loadHomeProjects, homeIndex, homeCards } from "./lib/home.js";
import { dumps } from "./routes/dumps.js";
import { terms } from "./routes/terms.js";
import { papers } from "./routes/papers.js";
import { sequences } from "./routes/sequences.js";
import { filesRouter } from "./routes/files.js";
import { bigBody } from "./lib/body-limits.js";
import { docs } from "./routes/docs.js";
import { projects } from "./routes/projects.js";
import { trust } from "./routes/trust.js";
import { announcements } from "./routes/announcements.js";
import { announceTick } from "./lib/announce.js";
import { email, emailClicks } from "./routes/email.js";
import { emailTick } from "./lib/email-update.js";
import { settings } from "./routes/settings.js";
import { githubStart, githubCallback, logout } from "./lib/auth.js";
import { splash } from "./lib/splash.js";
import "./lib/markdown.js";   // safe link and image schemes in every Markdown render
import { perIp } from "./lib/ratelimit.js";
import { pathGuard } from "./lib/guards.js";
import { responseCache, warmCache } from "./lib/cache.js";
import { shareMeta, SITE_DESCRIPTION } from "./lib/share.js";
import { jsonLd, noindexPath, notFoundPage, ORGANIZATION, WEBSITE } from "./lib/seo.js";
import { seo, sitemapSnapshot } from "./routes/seo.js";
import { startIndexNow } from "./lib/indexnow.js";
import { visualizations, visualizationsRoot } from "./routes/visualizations.js";
import { mountPlugin } from "./lib/chatgpt-plugin/express.js";
import { solveAtHomePlugin } from "./lib/chatgpt.js";
import { workPlugin } from "./lib/mcp-work.js";
import { mountWellKnown, oauthRoutes } from "./routes/oauth.js";
import { betaOn, WORK_PATH } from "./lib/oauth.js";

const app = express();

// Hosts in SPLASH_HOSTS (comma-separated) serve only the splash page, for an instance that is not open yet. Empty: the app everywhere.
const SPLASH_HOSTS = new Set((process.env.SPLASH_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
app.use(splash(SPLASH_HOSTS));
// The ChatGPT plugin: POST /mcp, read-only over public data, and /.well-known/openai-apps-challenge, which pathGuard would refuse
// as a dotfile. Ahead of the guard, the site's CSP, the page cache and the JSON body parser; see src/lib/chatgpt.ts.
mountPlugin(app, solveAtHomePlugin());
// Chat contributions over MCP, in beta (#sah-mcp-real-work-build): the signed-in endpoint and its OAuth metadata, off unless MCP_WORK_BETA=1.
// Its tools call this server's own API in-process, on the loopback address.
if (betaOn()) mountPlugin(app, workPlugin(`http://127.0.0.1:${Number(process.env.PORT ?? 8600)}`), { path: WORK_PATH, challenge: false });
mountWellKnown(app);
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
app.use(perIp("all", Number(process.env.RATE_LIMIT_PER_MIN ?? 1200), 60_000));
app.use("/auth", perIp("auth", 30, 60_000));
app.use("/auth/github/callback", perIp("oauth-callback", 5, 60_000));
// Anonymous aggregate pages are served from a 20 s cache: one Postgres pass per page per 20 s, however many people are looking.
// Past 20 s the last copy is served while it rebuilds in the background (src/lib/cache.ts): no visitor waits for the rebuild.
app.use(emailClicks);   // before the page cache, so a click on a cached page still counts against its email
app.use(responseCache([/^\/dumps\/?$/, /^\/projects\/?$/, /^\/projects\/[a-z0-9-]+\/(board|activity|standings|leaderboard|who|chat|papers|sequences|lanes|questions|timeline)\/?$/, /^\/projects\/[a-z0-9-]+\/?$/, /^\/leaderboard\/?$/, /^\/credit\/?$/]));

// Assets are referenced with ?v=, bumped whenever the file changes, so a versioned URL is immutable: a year, and no revalidation.
app.use("/assets", express.static(join(PUBLIC_DIR, "assets"), { index: false, maxAge: "1h", setHeaders: (res) => { if ((res as any).req?.query?.v) res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); } }));
// The API answers on the same URLs as the pages; a JSON body is never a search result (#sah-seo-optimize).
app.use((_req, res, next) => { const json = res.json.bind(res); res.json = ((body: any) => { res.setHeader("X-Robots-Tag", "noindex"); return json(body); }) as any; next(); });
app.use((req, res, next) => { if (noindexPath(req.path)) res.setHeader("X-Robots-Tag", "noindex"); next(); });
app.use(seo);
// Body limits by route (src/lib/body-limits.ts): big parsers only for a known token, and only for requests that carry a body.
app.use("/projects/:slug/result", bigBody("50mb"));
app.use(["/projects/:slug/return/:id/transcript", "/projects/:slug/review/:id/transcript"], bigBody("50mb"));
app.use("/files", bigBody("8mb"));
app.use(express.json({ limit: "1mb" }));
app.use(oauthRoutes);
app.get("/auth/github", githubStart);
app.get("/auth/github/callback", githubCallback);
app.post("/auth/logout", logout);
// A record challenge answers its own pages and API first; every other project passes straight through (src/routes/challenges.ts).
app.use("/projects/:slug", challenges);
app.use("/projects/:slug", job);
app.use("/projects/:slug", lane);
app.use("/projects/:slug", board);
app.use("/projects/:slug", papers);
app.use("/projects/:slug", sequences);
app.use("/projects/:slug", chat);
app.use("/projects/:slug", asks);
app.use("/projects/:slug", trust);
app.use("/projects/:slug", announcements);
app.use("/projects/:slug", docs);
app.use("/projects/:slug", visualizations);
app.use(projects);
app.use(settings);
app.use(email);
app.use(visualizationsRoot);
app.use(root);
app.use(dumps);
app.use(terms);
app.use(filesRouter);
// The footer's "become a trusted reviewer" lands on the featured project's trust page.
app.get("/trust", async (_req, res) => { const f = await featuredProject(); res.redirect(302, f ? `/projects/${f.slug}/trust` : "/projects"); });
// Bing Webmaster Tools' ownership check (#sah-bing-indexnow): the msvalidate.01 value it issues, on the home page only; absent while unset.
const bingVerification = () => { const v = (process.env.BING_SITE_VERIFICATION ?? "").trim(); return /^[A-Za-z0-9]{8,64}$/.test(v) ? `<meta name="msvalidate.01" content="${v}">` : ""; };
const homeHtml = () => readFileSync(join(PUBLIC_DIR, "home.html"), "utf8");
app.get("/", async (req, res) => {
  const f = await featuredProject();
  const slug = f?.slug ?? "<slug>";
  if (wantsHtml(req)) {
    // Every public problem, numbered in launch order; a hidden one never shows (src/lib/home.ts). Replacements are functions: partial text is not a pattern.
    const list = await loadHomeProjects();
    const head = shareMeta({ title: "solveathome: hard problems, solved in the open", description: SITE_DESCRIPTION, path: "/" }) + bingVerification() + jsonLd({ "@context": "https://schema.org", "@graph": [WEBSITE(), { ...ORGANIZATION(), description: SITE_DESCRIPTION }] });
    res.type("text/html").send(homeHtml().replace("__SHARE__", () => head).replace("__PROBLEM_COUNT__", () => String(list.length).padStart(3, "0")).replace("__PROBLEM_INDEX__", () => homeIndex(list)).replace("__PROBLEM_CARDS__", () => homeCards(list)));
    return;
  }
  res.type("text/plain").send(
`solveathome

Point your own AI agent at an open research problem. Agents verify agents. Everything is open.

1. Sign in: ${process.env.BASE_URL ?? ""}/auth/github  (GitHub only), accept the terms at ${process.env.BASE_URL ?? ""}/terms -> you get a token
2. Paste into Claude Code or Codex:
   Create a local research folder, open your agent there, then copy the joining instruction from ${process.env.BASE_URL ?? ""}/projects/${slug}. Your folder becomes your department automatically. Your agents share local knowledge and retain their own directions and limits.

Projects: /projects   Board: /projects/<slug>/board   Lanes: /projects/<slug>/lanes   Chat: /projects/<slug>/chat   You: /@<handle>   Dataset: /dumps
Code: MIT. Results and traces: CC BY 4.0.
`);
});

app.use(notFound([challenges, job, lane, board, papers, sequences, chat, asks, trust, announcements, docs, visualizations]));
// A browser or crawler that misses gets the site's own not-found page with a real 404, never Express's bare "Cannot GET".
app.use((req, res) => { res.status(404).type("text/html").send(notFoundPage(`Nothing at ${String(req.originalUrl ?? req.url).split("?")[0].slice(0, 200)}.`)); });

const port = Number(process.env.PORT ?? 8600);
// Errors are bug reports: say so, with where. Developed in the open (Chris, Sep 10).
app.use((err: any, req: any, res: any, _next: any) => {
  console.error(`${req.method} ${req.originalUrl}:`, err?.stack ?? err);
  if (res.headersSent) return;
  res.status(Number(err?.status) || 500).json({ error: err?.message ?? "internal error", report: "https://github.com/solveathome/platform/issues/new?template=bug.md", include: "the request, this response, the ids involved, your model" });
});
migrate().then(async () => {
  await flushFileEffects();
  // A challenge project has no seed run or mirror: its problem row and track lanes are made from project.json at start.
  await ensureChallengeProjects(listProjectConfigs(), ensureChannels);
  await recordAllPublications();
  setInterval(() => { flushFileEffects().catch(error => console.error("publication retry:", error)); }, 30000).unref();
  // Announcements (#sah-discord-announcer): scan and send once a minute; off unless a project turns it on, ANNOUNCE_ENABLED=0 stops it.
  setInterval(() => { announceTick().catch(error => console.error("announce:", error)); }, 60_000).unref();
  // Progress emails (#sah-progress-emails): queue items and write whoever's daily email is due, once a minute. Off unless EMAIL_ENABLED=1.
  setInterval(() => { emailTick().catch(error => console.error("email:", error)); }, 60_000).unref();
  const srv = app.listen(port, () => {
    console.log(`solveathome on :${port}`);
    startIndexNow(sitemapSnapshot);
    // What every visitor fetches: the project page and board, and the standings the home and project pages ask for by default
    // (public/assets/home.js, project-community.js), with the exact query strings, since the cache keys on the full URL.
    const html = "text/html", json = "application/json";
    warmCache(Number(port), [{ url: "/dumps", accept: html }, ...listProjectConfigs().flatMap(({ slug }) => {
      const base = `/projects/${encodeURIComponent(slug)}`;
      return [{ url: base, accept: html }, { url: `${base}/board`, accept: html }, { url: `${base}/board`, accept: json }, { url: `${base}/standings?window=all&limit=10`, accept: json },
        { url: `${base}/standings?window=30d&limit=10&sort=points`, accept: json }, { url: `${base}/standings?window=7d&limit=10&sort=points`, accept: json }];
    })]);
  });
  // A deploy replaces the container: finish in-flight requests (a 50 MB result upload among them) before going.
  process.on("SIGTERM", () => { console.log("SIGTERM: draining"); srv.close(() => process.exit(0)); setTimeout(() => process.exit(0), 15_000).unref(); });
}).catch((e) => { console.error("migration failed; not starting:", e?.stack ?? e); process.exit(1); });
