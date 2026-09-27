/*
 * Visualizations (src/lib/visualizations.ts). This file is what every type shares: the project's event stream from
 * GET /projects/<slug>/timeline (history in pages, then new events every 30 s), a clock that plays, scrubs and follows the record
 * live, and the scrubber, which is itself a histogram of activity. A type registers one renderer:
 *
 *   SAViz.register('replay', {mount(ctx) { ...; return {frame(T, info), resize(), data()} }})
 *
 * ctx = {root, stage, stream, player, slug, theme()}. frame(T) gets the record time in epoch ms and must draw the record as it
 * stood at T from the events alone, so a scrub backwards is the same as a play forwards.
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
   * The playback axis (client, Sep 27: "empty slots in the timeline should just be skipped like the hours did not exist").
   * Events closer than two seconds of playback form one stretch; each stretch is kept with a short margin either side and the
   * quiet between stretches is cut. Play, the scrubber and its histogram run on this axis, so no position on it is dead time;
   * the clock label still shows the real date and time. It depends on the speed (two seconds of playback is 20 minutes at
   * 10 min/s, 12 hours at 6 h/s) and is rebuilt when the speed changes or new events arrive.
   */
  const GAP = 2000, PAD = 400;   // ms of playback: a longer silence is cut; a stretch keeps 0.4 s either side, so a cut is a 0.8 s beat
  class Axis {
    constructor(events, start, rate) {
      const gap = rate * GAP, pad = rate * PAD, segs = [];
      let cur = null;
      for (const e of events) {
        if (cur && e[0] - cur.last <= gap) { cur.last = e[0]; continue; }
        cur = {first: e[0], last: e[0]}; segs.push(cur);
      }
      let p = 0;
      this.segs = segs.map((c, i) => {
        const t0 = Math.max(start, c.first - pad, i ? segs[i - 1].last + pad : -Infinity), t1 = c.last + pad, seg = {t0, t1, p0: p};
        p += t1 - t0; return seg;
      });
      if (!this.segs.length) this.segs = [{t0: start, t1: start + 3600_000, p0: 0}], p = 3600_000;
      this.total = p;
    }
    seg(P) { let lo = 0, hi = this.segs.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.segs[m].p0 <= P) lo = m; else hi = m - 1; } return this.segs[lo]; }
    /** Real time at a point of the axis. */
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
      this.el.scrub.addEventListener('input', () => { this.live = false; this.el.live.setAttribute('aria-pressed', 'false'); this.seekP(this.axis.total * Number(this.el.scrub.value) / 1000); });
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
        if (document.activeElement !== this.el.scrub || this.playing) this.el.scrub.value = String(Math.round(this.P / this.axis.total * 1000));
        const d = new Date(this.T);
        const date = DATE.format(d), time = `${TIME.format(d)} UTC${this.live ? ' · live' : ''}`;
        if (this.el.date.textContent !== date) this.el.date.textContent = date;
        if (this.el.time.textContent !== time) this.el.time.textContent = time;
        this.drawPlayhead();
        this.onFrame(this.T, {rate: this.live ? 60 : this.rate, live: this.live, playing: this.playing});
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
      this.el.start.textContent = SHORT.format(new Date(this.axis.segs[0].t0)); this.el.end.textContent = 'now';
      this.el.loading.textContent = `${SA.number(s.events.length)} events`;
    }
    /** The scrubber's background: events per bucket along the playback axis, the part already played in full ink, a tick where quiet was cut. */
    drawHistogram() {
      const c = this.el.hist, dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
      if (!w || !h || !this.axis) return;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const ax = this.axis, n = Math.max(24, Math.min(240, Math.floor(w / 4))), counts = new Array(n).fill(0);
      for (const e of this.stream.events) { const i = Math.min(n - 1, Math.floor(ax.at(e[0]) / ax.total * n)); if (i >= 0) counts[i]++; }
      const max = Math.max(1, ...counts);
      this.bars = {n, counts, max, cuts: ax.segs.slice(1).map(sg => sg.p0 / ax.total)}; this.histDirty = false; this.drawnAt = null; this.drawPlayhead(true);
    }
    drawPlayhead(force) {
      if (this.histDirty) return this.drawHistogram();
      if (!this.bars) return;
      const {n, counts, max, cuts} = this.bars, c = this.el.hist, ctx = c.getContext('2d'), dpr = devicePixelRatio || 1, w = c.width / dpr, h = c.height / dpr;
      const x = this.P / this.axis.total * w;
      if (!force && this.drawnAt !== null && Math.abs(this.drawnAt - x) < 0.5) return;
      this.drawnAt = x;
      const th = theme(), bw = w / n;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < n; i++) {
        if (!counts[i]) continue;
        const bh = Math.max(1, Math.sqrt(counts[i] / max) * (h - 6));   // square root: a busy hour does not flatten a quiet day
        ctx.fillStyle = (i + 1) * bw <= x ? th.fg : th.line;
        ctx.fillRect(i * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
      }
      ctx.fillStyle = th.fg; ctx.fillRect(Math.round(x) - 1, 0, 2, h);
      // A short tick under the base where a quiet stretch was cut.
      ctx.fillStyle = th.mut; ctx.globalAlpha = .7;
      for (const f of cuts) ctx.fillRect(Math.round(f * w), h - 3, 1, 3);
      ctx.globalAlpha = 1;
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
