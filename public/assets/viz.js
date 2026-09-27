/*
 * Visualizations (src/lib/visualizations.ts). This file is what every type shares: the project's event stream from
 * GET /projects/<slug>/timeline (history in pages, then new events every 30 s), a clock that plays, scrubs and follows the record
 * live, and the scrubber, which is itself a histogram of activity. A type registers one renderer:
 *
 *   SAViz.register('replay', {mount(ctx) { ...; return {frame(T, info), resize(), data()} }})
 *
 * ctx = {root, stage, stream, player, slug, theme()}. frame(T, info) gets the record time in epoch ms and must draw the record as it
 * stood at T from the events alone, so a scrub backwards is the same as a play forwards. Anything animated is timed on
 * info.clock, with info.at(t) the clock reading of an event at record time t: that clock never jumps at a cut.
 */
(function () {
  const LAG = 60_000;            // live runs a minute behind: a poll every 30 s then shows events as they happen, not in bursts
  const POLL = 30_000;
  const types = {};
  const register = (type, def) => { types[type] = def; };

  // Provider colours: one hue per maker, muted to the site's charcoal and paper. Unknown makers stay neutral.
  const PALETTE = {
    dark: {anthropic: '#d8a34a', openai: '#8ec5e0', google: '#4fbfa6', deepseek: '#6f8cf0', alibaba: '#b08ce8', xai: '#e07f9b', meta: '#7fb2f0', mistral: '#e8a06a', moonshot: '#c9c46a', unknown: '#9a9994', reject: '#e0685c', accept: '#efeee8'},
    light: {anthropic: '#a87414', openai: '#2f7fa8', google: '#138a70', deepseek: '#3a58c8', alibaba: '#7a4fc0', xai: '#b8406a', meta: '#3f75c0', mistral: '#b86628', moonshot: '#8a8420', unknown: '#8a8983', reject: '#c23b2f', accept: '#1a1a1a'},
  };
  const PROVIDER_NAMES = {anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', deepseek: 'DeepSeek', alibaba: 'Alibaba', xai: 'xAI', meta: 'Meta', mistral: 'Mistral', moonshot: 'Moonshot', unknown: 'Other'};
  // The client twin of providerFromModel in src/lib/model-id.ts.
  function provider(model) {
    const m = String(model || '').toLowerCase();
    if (/^claude/.test(m)) return 'anthropic';
    if (/^(gpt|o\d|chatgpt)|codex|astra/.test(m)) return 'openai';
    if (/^gemini|^gemma|^palm/.test(m)) return 'google';
    if (/^llama/.test(m)) return 'meta';
    if (/^(mistral|mixtral|codestral|magistral)/.test(m)) return 'mistral';
    if (/^deepseek/.test(m)) return 'deepseek';
    if (/^(qwen|qwq)/.test(m)) return 'alibaba';
    if (/^grok/.test(m)) return 'xai';
    if (/^kimi|^moonshot/.test(m)) return 'moonshot';
    return 'unknown';
  }
  const lightScheme = matchMedia('(prefers-color-scheme: light)');
  function theme() {
    const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
    return {bg: v('--bg'), fg: v('--fg'), mut: v('--mut'), line: v('--line'), soft: v('--soft'), mono: v('--mono'), colors: lightScheme.matches ? PALETTE.light : PALETTE.dark};
  }

  /** The event stream: all history in pages, then the tail every 30 s. Listeners hear 'data' after each page. */
  class Stream {
    constructor(slug) { this.slug = slug; this.events = []; this.lanes = []; this.start = null; this.total = 0; this.caughtUp = false; this.cursor = null; this.listeners = []; this.failed = false; }
    on(fn) { this.listeners.push(fn); }
    emit(kind) { for (const fn of this.listeners) fn(kind); }
    url(after) { return `/projects/${encodeURIComponent(this.slug)}/timeline${after ? `?after=${encodeURIComponent(after)}` : ''}`; }
    async page(after) {
      for (let attempt = 0; ; attempt++) {
        try { return await SA.json(this.url(after)); }
        catch (e) { if (attempt >= 3) throw e; await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); }
      }
    }
    async load() {
      const first = await this.page(null);
      this.start = first.start ? Date.parse(first.start) : (first.events[0]?.[0] ?? Date.now());
      this.total = first.total || first.events.length; this.lanes = first.lanes || [];
      this.append(first); this.emit('head');
      while (first.next && this.cursor) { const p = await this.page(this.cursor); this.append(p); if (!p.next) break; }
      this.caughtUp = true; this.emit('data');
      setInterval(() => this.poll(), POLL);
    }
    append(p) {
      if (p.events.length) { this.events.push(...p.events); }
      if (p.cursor) this.cursor = p.cursor;
      this.total = Math.max(this.total, this.events.length);
      this.emit('data');
    }
    async poll() {
      if (document.hidden) return;
      try { let p; do { p = await SA.json(this.url(this.cursor)); if (p.events.length) this.append(p); else if (p.cursor) this.cursor = p.cursor; } while (p.next); } catch { /* the next poll tries again */ }
    }
    /** The last moment the record covers: now (less the live lag) once all history is in, else the newest event loaded. */
    end() { const last = this.events.length ? this.events[this.events.length - 1][0] : this.start; return this.caughtUp ? Math.max(last, Date.now() - LAG) : last; }
    /** How many events happened at or before T. */
    count(T) { let lo = 0, hi = this.events.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (this.events[mid][0] <= T) lo = mid + 1; else hi = mid; } return lo; }
  }

  const DATE = new Intl.DateTimeFormat('en', {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'});
  const TIME = new Intl.DateTimeFormat('en', {hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC'});
  const SHORT = new Intl.DateTimeFormat('en', {month: 'short', day: 'numeric', timeZone: 'UTC'});
  /**
   * The playback axis (client, Sep 27: "we want those hours to not show this inactivity by just skipping over empty hours").
   * The record is cut into quarter hours of real time. A quarter plays when agents worked in it: at least one assignment,
   * result, review or decision, and at least a quarter of the events of the median working quarter (never fewer than three).
   * Every other quarter is left out, however many stray chat lines it holds. Quarter hours, not hours: at 1 h/s an hour-long
   * bin still played its quiet half. Runs of playing quarters are joined; a cut of an hour or more is a short beat (0.1 s of
   * playback, the picture held), a shorter one is seamless. Play runs on this axis, so the clock label, which keeps the real
   * date and time, jumps forward across a cut; a skipped quarter's events are not played, their results and chat are in place
   * after the cut. The scrubber does not (client, Sep 27: "we should still visually show the gaps in the timeline"): it is
   * drawn in real time with each cut (gaps()) hatched, and scrubbing into a gap shows the record as it stood there.
   */
  const BIN = 900_000, HOUR = 3600_000, BEAT = 100, QUIET_SHARE = 0.25, QUIET_MIN = 3;
  const WORK = new Set(['a', 'r', 'v', 'd']);
  class Axis {
    constructor(events, start, rate) {
      const beat = rate * BEAT, bins = new Map();
      for (const e of events) { const k = Math.floor(e[0] / BIN), x = bins.get(k) || {n: 0, work: 0}; x.n++; if (WORK.has(e[1])) x.work++; bins.set(k, x); }
      const counts = [...bins.values()].filter(x => x.work).map(x => x.n).sort((x, y) => x - y);
      const median = counts.length ? counts[counts.length >> 1] : 0;
      this.threshold = Math.max(QUIET_MIN, Math.ceil(median * QUIET_SHARE));
      const active = k => { const x = bins.get(k); return !!x && x.work > 0 && x.n >= this.threshold; };
      const lastT = events.length ? events[events.length - 1][0] : start, keys = [...bins.keys()].filter(active).sort((x, y) => x - y);
      const segs = [];
      for (const k of keys) {
        const t0 = Math.max(start, k * BIN), t1 = Math.min((k + 1) * BIN, lastT + 60_000);
        if (t1 <= t0) continue;
        const prev = segs[segs.length - 1];
        if (prev && prev.t1 >= t0) prev.t1 = t1; else segs.push({t0, t1});
      }
      let p = 0;
      this.segs = segs.map((sg, i) => { const seg = {...sg, p0: p}; p += sg.t1 - sg.t0 + (i < segs.length - 1 && segs[i + 1].t0 - sg.t1 >= HOUR ? beat : 0); return seg; });
      if (!this.segs.length) { this.segs = [{t0: start, t1: Math.max(start + HOUR, lastT), p0: 0}]; p = this.segs[0].t1 - start; }
      this.total = p;
      this.skipped = Math.round(((segs.length ? segs[segs.length - 1].t1 - segs[0].t0 : 0) - segs.reduce((a, sg) => a + sg.t1 - sg.t0, 0)) / HOUR);   // hours cut
    }
    seg(P) { let lo = 0, hi = this.segs.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.segs[m].p0 <= P) lo = m; else hi = m - 1; } return this.segs[lo]; }
    /** Real time at a point of the axis; inside a beat the picture holds at the end of the stretch before it. */
    real(P) { const s = this.seg(Math.max(0, Math.min(this.total, P))); return Math.min(s.t1, s.t0 + Math.max(0, P - s.p0)); }
    /** The axis point of a real time; a moment inside a cut lands at the start of the next stretch. */
    at(T) {
      const segs = this.segs; let lo = 0, hi = segs.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].t0 <= T) lo = m; else hi = m - 1; }
      const s = segs[lo];
      if (T < s.t0) return s.p0;
      if (T <= s.t1) return s.p0 + (T - s.t0);
      return lo + 1 < segs.length ? segs[lo + 1].p0 : this.total;
    }
    /** The quiet stretches in real time, [from, to] each: before the first stretch, between stretches, and after the last up to `end`. */
    gaps(start, end) {
      const out = [], segs = this.segs;
      if (segs[0].t0 > start) out.push([start, segs[0].t0]);
      for (let i = 1; i < segs.length; i++) out.push([segs[i - 1].t1, segs[i].t0]);
      if (end > segs[segs.length - 1].t1) out.push([segs[segs.length - 1].t1, end]);
      return out;
    }
    /** Whether a real moment is played (not inside a cut). */
    plays(T) { const P = this.at(T); return Math.abs(this.real(P) - T) < 1; }
  }

  /** The clock: play, pause, speed, scrub, live. It calls onFrame(T, info) every animation frame with T in real time. */
  class Player {
    constructor(root, stream, onFrame) {
      Object.assign(this, {root, stream, onFrame, T: null, P: 0, axis: null, playing: false, live: false, last: 0});
      const $ = s => root.querySelector(s);
      this.el = {player: $('[data-viz-player]'), play: $('[data-viz-play]'), speed: $('[data-viz-speed]'), live: $('[data-viz-live]'), scrub: $('[data-viz-scrub]'), hist: $('[data-viz-histogram]'), date: $('[data-viz-date]'), time: $('[data-viz-time]'), start: $('[data-viz-start]'), end: $('[data-viz-end]'), loading: $('[data-viz-loading]')};
      this.rate = Number(this.el.speed.value);
      this.el.play.onclick = () => this.toggle();
      this.el.speed.onchange = () => { this.rate = Number(this.el.speed.value); this.rebuild(); };
      this.el.live.onclick = () => this.goLive(!this.live);
      this.el.scrub.addEventListener('input', () => { this.live = false; this.el.live.setAttribute('aria-pressed', 'false'); const [a, b] = this.span(); this.seekT(a + (b - a) * Number(this.el.scrub.value) / 1000); });
      this.el.scrub.addEventListener('pointerdown', () => { this.wasPlaying = this.playing; this.setPlaying(false); });
      this.el.scrub.addEventListener('pointerup', () => { if (this.wasPlaying) this.setPlaying(true); });
      addEventListener('keydown', e => { if (e.key === ' ' && !/INPUT|SELECT|BUTTON|TEXTAREA|A/.test(document.activeElement?.tagName || '')) { e.preventDefault(); this.toggle(); } });
      new ResizeObserver(() => this.drawHistogram()).observe(this.el.hist);
      lightScheme.addEventListener('change', () => this.drawHistogram());
      requestAnimationFrame(t => this.tick(t));
    }
    /** A new axis for new events or a new speed; the moment on screen stays where it is. */
    rebuild() {
      if (!this.stream.caughtUp) return;
      this.axis = new Axis(this.stream.events, this.stream.start, this.rate);
      if (this.T !== null && !this.live) this.P = this.axis.at(this.T);
      this.histDirty = true;
    }
    seekP(P) { this.P = Math.max(0, Math.min(this.axis.total, P)); this.T = this.axis.real(this.P); }
    /** Scrubbing lands on a real moment, inside a gap too; play then resumes from the start of the next stretch. */
    seekT(T) { this.T = T; this.P = this.axis.at(T); }
    /** The scrubber's span in real time: launch to now. */
    span() { return [this.stream.start, Math.max(this.stream.start + HOUR, this.stream.end())]; }
    toggle() { if (this.live) this.goLive(false); this.setPlaying(!this.playing); }
    setPlaying(on) {
      if (on && !this.live && this.P >= this.axis.total - 1) this.seekP(0);   // play at the end starts over
      this.playing = on; this.el.play.textContent = on ? '❚❚' : '▶'; this.el.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
    }
    goLive(on) { this.live = on; this.el.live.setAttribute('aria-pressed', String(on)); if (on) { this.setPlaying(true); this.P = this.axis.total; this.T = this.stream.end(); } else this.P = this.axis.at(this.T); }
    tick(now) {
      const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0; this.last = now;
      if (this.T !== null && this.axis) {
        // Live follows the real clock past the last stretch; play walks the axis, where every step is active time.
        if (this.live) { this.T = this.stream.end(); this.P = this.axis.total; }
        else if (this.playing) {
          this.seekP(this.P + dt * this.rate * 1000);
          if (this.P >= this.axis.total && this.stream.caughtUp) this.goLive(true);
        }
        const [a, b] = this.span();
        if (document.activeElement !== this.el.scrub || this.playing) this.el.scrub.value = String(Math.round((this.T - a) / (b - a) * 1000));
        const d = new Date(this.T);
        const date = DATE.format(d), time = `${TIME.format(d)} UTC${this.live ? ' · live' : ''}`;
        if (this.el.date.textContent !== date) this.el.date.textContent = date;
        if (this.el.time.textContent !== time) this.el.time.textContent = time;
        this.drawPlayhead();
        // Animations run on the playback clock, not the record's (client, Sep 27: a cut must not fast-forward a fade): P crosses a
        // cut at the normal pace, so a fade under way plays out on the other side, and one starting after a cut starts in full.
        // Live has no axis ahead of it and runs on the real clock.
        const ax = this.axis, clock = this.live ? this.T : this.P, at = this.live ? (t => t) : (t => ax.at(t));
        this.onFrame(this.T, {rate: this.live ? 60 : this.rate, live: this.live, playing: this.playing, clock, at});
      }
      requestAnimationFrame(t => this.tick(t));
    }
    onData() {
      const s = this.stream;
      if (!s.caughtUp) return;
      this.rebuild();
      if (this.T === null) {
        this.el.player.hidden = false;
        const at = Date.parse(new URLSearchParams(location.search).get('t') || '');
        const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (Number.isFinite(at)) this.seekP(this.axis.at(at)); else this.seekP(0);
        if (!still && !Number.isFinite(at)) this.setPlaying(true);
      }
      this.el.start.textContent = SHORT.format(new Date(s.start)); this.el.end.textContent = 'now';
      this.el.loading.textContent = `${SA.number(s.events.length)} events`;
    }
    /** The scrubber's background, in real time: events per bucket, the part already played in full ink, and the gaps play skips hatched. */
    drawHistogram() {
      const c = this.el.hist, dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
      if (!w || !h || !this.axis) return;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const [a, b] = this.span(), n = Math.max(24, Math.min(240, Math.floor(w / 4))), counts = new Array(n).fill(0);
      for (const e of this.stream.events) { const i = Math.min(n - 1, Math.floor((e[0] - a) / (b - a) * n)); if (i >= 0) counts[i]++; }
      const max = Math.max(1, ...counts);
      this.bars = {n, counts, max, a, b, gaps: this.axis.gaps(a, b)}; this.histDirty = false; this.drawnAt = null; this.drawPlayhead(true);
    }
    drawPlayhead(force) {
      if (this.histDirty || (this.bars && this.span()[1] - this.bars.b > (this.bars.b - this.bars.a) / 500)) return this.drawHistogram();   // now moves on: redraw every 0.2% of the span
      if (!this.bars) return;
      const {n, counts, max, a, b, gaps} = this.bars, c = this.el.hist, ctx = c.getContext('2d'), dpr = devicePixelRatio || 1, w = c.width / dpr, h = c.height / dpr;
      const x = (this.T - a) / (b - a) * w;
      if (!force && this.drawnAt !== null && Math.abs(this.drawnAt - x) < 0.5) return;
      this.drawnAt = x;
      const th = theme(), bw = w / n, X = t => (t - a) / (b - a) * w;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      // Gaps: a soft band with fine diagonal hatching, full height, under the bars. Play jumps them; the scrubber still reaches them.
      ctx.save(); ctx.beginPath();
      for (const [g0, g1] of gaps) { const x0 = X(g0), x1 = X(g1); if (x1 - x0 >= 0.75) ctx.rect(x0, 0, x1 - x0, h); }
      ctx.clip(); ctx.fillStyle = th.soft; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = th.line; ctx.lineWidth = 1; ctx.beginPath();
      for (let d = -h; d < w; d += 5) { ctx.moveTo(d, h); ctx.lineTo(d + h, 0); }
      ctx.stroke(); ctx.restore();
      for (let i = 0; i < n; i++) {
        if (!counts[i]) continue;
        const bh = Math.max(1, Math.sqrt(counts[i] / max) * (h - 6));   // square root: a busy hour does not flatten a quiet day
        ctx.fillStyle = (i + 1) * bw <= x ? th.fg : th.mut; ctx.globalAlpha = (i + 1) * bw <= x ? 1 : .55;
        ctx.fillRect(i * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
      }
      ctx.globalAlpha = 1; ctx.fillStyle = th.fg; ctx.fillRect(Math.round(x) - 1, 0, 2, h);
    }
  }

  async function boot(root) {
    const type = types[root.dataset.type], stage = root.querySelector('[data-viz-stage]'), status = root.querySelector('[data-viz-status]');
    if (!type) { status.textContent = 'This visualization failed to load. Refresh to try again.'; return; }
    const stream = new Stream(root.dataset.slug);
    let renderer = null;
    const player = new Player(root, stream, (T, info) => renderer?.frame(T, info));
    // The type mounts once all history is in, so the page takes its final shape once instead of growing page by page.
    stream.on(kind => {
      if (!stream.caughtUp) { status.textContent = `Loading the record · ${Math.round(100 * stream.events.length / Math.max(1, stream.total))}%`; return; }
      if (!renderer) { status.remove(); renderer = type.mount({root, stage, stream, player, slug: root.dataset.slug, theme}); }
      renderer.data?.(kind); player.onData();
    });
    try { await stream.load(); }
    catch { if (!renderer) status.textContent = 'The record is temporarily unavailable. Refresh to try again.'; }
  }

  window.SAViz = {register, boot, provider, theme, PROVIDER_NAMES, Stream, Player, Axis};
})();
