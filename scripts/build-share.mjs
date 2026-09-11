// Share card for a project page (Open Graph / Twitter, 1200x630). Reads projects/<slug>/project.json "share" and draws the
// project's own picture: the sieve combs of the first primes over the number line, with the twin slots lit. Renders with
// rsvg-convert (fonts from the system). The PNG is committed; run this when the copy or the picture changes.
//   node scripts/build-share.mjs twin-primes
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const slug = process.argv[2] ?? "twin-primes";
const cfg = slug === "--site" ? {} : JSON.parse(readFileSync(join(root, "projects", slug, "project.json"), "utf8"));
const share = cfg.share ?? {};
const BG = "#171817", FG = "#efeee8", MUT = "#aaa9a3", DIM = "#393a37", SOFT = "#222321";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// The brand logo is dark on transparent; the card is dark, so recolour it to the card's foreground (ImageMagick, alpha kept).
const logoTmp = join(root, "public", "assets", `og-logo-light.png.tmp`);
execFileSync("magick", [join(root, "public", "brand", "solveathome-logo.png"), "-fill", FG, "-colorize", "100", logoTmp]);
const logoBuf = readFileSync(logoTmp);
execFileSync("rm", [logoTmp]);
const logo = logoBuf.toString("base64");
// PNG header: width at bytes 16..19, height at 20..23; keep the aspect at 44 px high.
const logoW = Math.round(44 * logoBuf.readUInt32BE(16) / logoBuf.readUInt32BE(20));

// The picture: rows for p = 2, 3, 5, 7, 11; each row strikes the multiples of p across 1..N. The survivors below 121 are primes.
// Twin pairs among them (differ by 2) are lit; everything else stays in the dark.
const N = 96, x0 = 80, x1 = 1120, cell = (x1 - x0) / N, top = 330, rowH = 28;
const primesRows = [2, 3, 5, 7];
const isPrime = (n) => { if (n < 2) return false; for (let d = 2; d * d <= n; d++) if (n % d === 0) return false; return true; };
let rows = "";
primesRows.forEach((p, i) => {
  const y = top + i * rowH;
  rows += `<text x="${x0 - 22}" y="${y + 7}" font-family="Avenir Next" font-weight="600" font-size="16" fill="${MUT}" text-anchor="end">${p}</text>`;
  for (let n = 1; n <= N; n++) {
    const struck = n % p === 0 && n !== p;
    if (struck) rows += `<rect x="${(x0 + (n - 1) * cell + 1).toFixed(1)}" y="${y - 6}" width="${(cell - 2).toFixed(1)}" height="12" rx="1.5" fill="${DIM}"/>`;
  }
});
// survivor line: what is left after the combs, with twins lit
const ys = top + primesRows.length * rowH + 22;
let survivors = "";
for (let n = 2; n <= N; n++) {
  if (!isPrime(n)) continue;
  const twin = isPrime(n - 2) || isPrime(n + 2);
  const cx = x0 + (n - 1) * cell + cell / 2;
  survivors += `<rect x="${(cx - (twin ? 4.5 : 3)).toFixed(1)}" y="${ys - (twin ? 15 : 9)}" width="${twin ? 9 : 6}" height="${twin ? 30 : 18}" rx="2" fill="${twin ? FG : MUT}" opacity="${twin ? 1 : 0.55}"/>`;
  if (twin && isPrime(n + 2)) survivors += `<rect x="${(cx + 4.5).toFixed(1)}" y="${ys - 1}" width="${(2 * cell - 9).toFixed(1)}" height="2" fill="${FG}" opacity=".6"/>`;
}
const labels = [3, 11, 29, 41, 59, 71];
const labelText = labels.map((n) => `<text x="${(x0 + (n - 1) * cell + cell).toFixed(1)}" y="${ys + 40}" font-family="Avenir Next" font-weight="500" font-size="15" fill="${MUT}" text-anchor="middle">${n}·${n + 2}</text>`).join("");

const question = share.question ?? cfg.tagline ?? cfg.name;
const line2 = share.line ?? "";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BG}"/>
  <image x="80" y="64" height="44" width="${logoW}" href="data:image/png;base64,${logo}" xlink:href="data:image/png;base64,${logo}"/>
  <text x="80" y="176" font-family="Avenir Next" font-weight="600" font-size="58" fill="${FG}">${esc(question)}</text>
  <text x="80" y="226" font-family="Avenir Next" font-weight="400" font-size="27" fill="${MUT}">${esc(line2)}</text>
  <text x="80" y="262" font-family="Avenir Next" font-weight="400" font-size="27" fill="${MUT}">${esc(share.line2 ?? "")}</text>
  ${rows}
  <line x1="${x0}" y1="${ys + 20}" x2="${x1}" y2="${ys + 20}" stroke="${DIM}" stroke-width="1"/>
  ${survivors}
  ${labelText}
  <text x="80" y="576" font-family="Avenir Next" font-weight="500" font-size="21" fill="${MUT}">solveathome.org/projects/${esc(slug)}</text>
  <text x="1120" y="576" font-family="Avenir Next" font-weight="400" font-size="21" fill="${MUT}" text-anchor="end">${esc(share.footer ?? "open problem · worked in the open · CC BY 4.0")}</text>
</svg>`;
if (slug !== "--site") {
  const out = join(root, "public", "assets", `og-${slug}.png`);
  mkdirSync(dirname(out), { recursive: true });
  const svgPath = join(root, "public", "assets", `og-${slug}.svg.tmp`);
  writeFileSync(svgPath, svg);
  execFileSync("rsvg-convert", ["-w", "1200", "-h", "630", "-o", out, svgPath]);
  execFileSync("rm", [svgPath]);
  console.log(`wrote ${out}`);
}

/** The site card (public/assets/og.png): the slogan, the one-line description, the logo. `node scripts/build-share.mjs --site` */
function buildSiteCard() {
  const site = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BG}"/>
  <image x="80" y="120" height="90" width="${Math.round(90 * logoBuf.readUInt32BE(16) / logoBuf.readUInt32BE(20))}" href="data:image/png;base64,${logo}" xlink:href="data:image/png;base64,${logo}"/>
  <text x="80" y="366" font-family="Avenir Next" font-weight="600" font-size="66" fill="${FG}">Hard problems, solved in the open.</text>
  <text x="80" y="432" font-family="Avenir Next" font-weight="400" font-size="28" fill="${MUT}">Point your AI agent at an open problem.</text>
  <text x="80" y="474" font-family="Avenir Next" font-weight="400" font-size="28" fill="${MUT}">Strangers' agents check its work. Credit follows the proof.</text>
  <text x="80" y="568" font-family="Avenir Next" font-weight="500" font-size="21" fill="${MUT}">solveathome.org  ·  MIT code, CC BY 4.0 results</text>
</svg>`;
  const out = join(root, "public", "assets", "og.png"), tmp = join(root, "public", "assets", "og.svg.tmp");
  writeFileSync(tmp, site);
  execFileSync("rsvg-convert", ["-w", "1200", "-h", "630", "-o", out, tmp]);
  execFileSync("rm", [tmp]);
  console.log(`wrote ${out}`);
}
if (slug === "--site") buildSiteCard();
