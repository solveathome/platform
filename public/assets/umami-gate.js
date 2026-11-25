/* Runs before every Umami send (data-before-send="sahUmamiGate") and drops the sends of automated browsers, so the
 * statistics count people only. It never blocks a page: a crawler still gets every page, it is only not counted
 * (analytics count people, crawlers are welcome to read and index).
 *
 * The crawler this was written for (Nov 22 2026 onward) loads one deep page per visit from residential IPs in many
 * countries, as desktop Chrome on Windows with a 1920x1080 or 1280x1200 screen, en-US, no referrer. Its browser string
 * is older than the Chrome people run (Chrome 154 at 1920x1080; a rotating 122 to 154 at 1280x1200, while visitors
 * on Windows run 158). Screen alone is not enough: 1920x1080 is the most common real desktop screen, so that half
 * also needs the old browser build. A visitor who reaches a second page carries an in-site referrer and is counted. */
(function () {
  function chromeMajor(ua) {
    var m = /Chrome\/(\d+)\./.exec(ua);
    return m ? +m[1] : 0;
  }
  function isCrawler() {
    var n = navigator, ua = n.userAgent || "";
    if (n.webdriver || /HeadlessChrome|Lightpanda|PhantomJS/i.test(ua)) return true;
    // Desktop Chrome on Windows only: Edge, Opera and other Chromium browsers name themselves and are left alone.
    if (!/Windows NT 10\.0; Win64; x64/.test(ua) || /Edg\/|OPR\/|YaBrowser|Vivaldi|Brave/.test(ua) || !chromeMajor(ua)) return false;
    if (document.referrer || (n.language || "") !== "en-US") return false;
    var s = (screen.width || 0) + "x" + (screen.height || 0);
    var major = chromeMajor(ua);
    if (s === "1280x1200") return true;
    if (s === "1920x1080" && major < 155) return true;
    // A browser string that disagrees with the browser's own client hints is a rewritten one.
    var brands = n.userAgentData && n.userAgentData.brands;
    if (brands && (s === "1920x1080")) {
      for (var i = 0; i < brands.length; i++) if (brands[i].brand === "Chromium" && +brands[i].version !== major) return true;
    }
    return false;
  }
  var drop = false;
  try { drop = isCrawler(); } catch (e) { drop = false; }
  window.sahUmamiGate = function (type, payload) { return drop ? false : payload; };
})();
