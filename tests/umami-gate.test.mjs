// The Umami gate (public/assets/umami-gate.js) drops the analytics sends of automated browsers and keeps people's:
// statistics count people only, and no crawler is ever blocked from a page. Every page that loads Umami names the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";

const src = readFileSync("public/assets/umami-gate.js", "utf8");
const win = (v, extra = "") => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36${extra}`;
function sent({ ua, s, ref = "", lang = "en-US", webdriver = false, brands }) {
  const window = {};
  vm.runInNewContext(src, { window, navigator: { userAgent: ua, webdriver, language: lang, userAgentData: brands ? { brands } : undefined }, screen: { width: s[0], height: s[1] }, document: { referrer: ref } });
  const payload = { url: "/x" };
  const out = window.sahUmamiGate("event", payload);
  assert.ok(out === false || out === payload);
  return out === payload;
}

test("the crawler's sends are dropped", () => {
  assert.equal(sent({ ua: win(154), s: [1920, 1080] }), false);
  assert.equal(sent({ ua: win(130), s: [1280, 1200] }), false);
  assert.equal(sent({ ua: win(154), s: [1280, 1200] }), false);
  assert.equal(sent({ ua: win(158), s: [1440, 900], webdriver: true }), false);
  assert.equal(sent({ ua: win(158), s: [1920, 1080], brands: [{ brand: "Chromium", version: "150" }] }), false);
});

test("people are still counted", () => {
  assert.equal(sent({ ua: win(158), s: [1920, 1080], brands: [{ brand: "Chromium", version: "158" }] }), true);
  assert.equal(sent({ ua: win(154), s: [1920, 1080], ref: "https://www.google.com/" }), true);
  assert.equal(sent({ ua: win(154), s: [1920, 1080], ref: "https://solveathome.org/" }), true);
  assert.equal(sent({ ua: win(154), s: [1920, 1080], lang: "de-DE" }), true);
  assert.equal(sent({ ua: win(140, " Edg/140.0.0.0"), s: [1920, 1080] }), true);
  assert.equal(sent({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36", s: [1920, 1080] }), true);
  assert.equal(sent({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1", s: [390, 844] }), true);
  assert.equal(sent({ ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0", s: [1920, 1080] }), true);
});

test("every Umami tag runs the gate", () => {
  const tags = execFileSync("git", ["grep", "-h", "-o", "<script[^>]*umami.infessa.com/script.js[^>]*>", "--", "public", "src"], { env: { PATH: process.env.PATH } }).toString().trim().split("\n");
  assert.ok(tags.length >= 13);
  for (const t of tags) assert.match(t, /data-before-send="sahUmamiGate"/);
});
