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

  /** The clock: play, pause, speed, scrub, live. It calls onFrame(T, info) every animation frame. */
  class Player {
    constructor(root, stream, onFrame) {
      Object.assign(this, {root, stream, onFrame, T: null, playing: false, live: false, last: 0});
      const $ = s => root.querySelector(s);
      this.el = {player: $('[data-viz-player]'), play: $('[data-viz-play]'), speed: $('[data-viz-speed]'), live: $('[data-viz-live]'), scrub: $('[data-viz-scrub]'), hist: $('[data-viz-histogram]'), date: $('[data-viz-date]'), time: $('[data-viz-time]'), start: $('[data-viz-start]'), end: $('[data-viz-end]'), loading: $('[data-viz-loading]')};
      this.rate = Number(this.el.speed.value);
      this.el.play.onclick = () => this.toggle();
      this.el.speed.onchange = () => { this.rate = Number(this.el.speed.value); };
      this.el.live.onclick = () => this.goLive(!this.live);
      this.el.scrub.addEventListener('input', () => { this.live = false; this.seek(this.fromSlider(Number(this.el.scrub.value))); });
      this.el.scrub.addEventListener('pointerdown', () => { this.wasPlaying = this.playing; this.setPlaying(false); });
      this.el.scrub.addEventListener('pointerup', () => { if (this.wasPlaying) this.setPlaying(true); });
      addEventListener('keydown', e => { if (e.key === ' ' && !/INPUT|SELECT|BUTTON|TEXTAREA|A/.test(document.activeElement?.tagName || '')) { e.preventDefault(); this.toggle(); } });
      new ResizeObserver(() => this.drawHistogram()).observe(this.el.hist);
      lightScheme.addEventListener('change', () => this.drawHistogram());
      requestAnimationFrame(t => this.tick(t));
    }
    span() { return [this.stream.start, Math.max(this.stream.start + 3600_000, this.stream.end())]; }
    fromSlider(v) { const [a, b] = this.span(); return a + (b - a) * v / 1000; }
    toggle() { if (this.live) this.goLive(false); this.setPlaying(!this.playing); }
    setPlaying(on) {
      if (on && !this.live && this.T >= this.span()[1] - 1000) this.T = this.span()[0];   // play at the end starts over
      this.playing = on; this.el.play.textContent = on ? '❚❚' : '▶'; this.el.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
    }
    goLive(on) { this.live = on; this.el.live.setAttribute('aria-pressed', String(on)); if (on) { this.setPlaying(true); this.T = this.span()[1]; } }
    seek(T) { const [a, b] = this.span(); this.T = Math.min(b, Math.max(a, T)); }
    tick(now) {
      const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0; this.last = now;
      if (this.T !== null) {
        const [a, b] = this.span();
        if (this.live) this.T = b;
        else if (this.playing) {
          // Quiet hours pass eight times faster: when nothing happens in the next three seconds of playback, skip ahead.
          const next = this.stream.events[this.stream.count(this.T)];
          const quiet = !next || next[0] - this.T > this.rate * 3000;
          this.T += dt * this.rate * 1000 * (quiet ? 8 : 1);
          if (this.T >= b) { this.T = b; if (this.stream.caughtUp) this.goLive(true); }
        }
        if (this.T < a) this.T = a;
        if (document.activeElement !== this.el.scrub || this.playing) this.el.scrub.value = String(Math.round((this.T - a) / (b - a) * 1000));
        const d = new Date(this.T);
        const date = DATE.format(d), time = `${TIME.format(d)} UTC${this.live ? ' · live' : ''}`;
        if (this.el.date.textContent !== date) this.el.date.textContent = date;
        if (this.el.time.textContent !== time) this.el.time.textContent = time;
        this.drawPlayhead();
        this.onFrame(this.T, {rate: this.live ? 60 : this.rate, live: this.live, playing: this.playing, start: a, end: b});
      }
      requestAnimationFrame(t => this.tick(t));
    }
    onData() {
      const s = this.stream;
      if (this.T === null && s.start != null) {
        this.el.player.hidden = false;
        const at = Date.parse(new URLSearchParams(location.search).get('t') || '');
        const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.T = Number.isFinite(at) ? at : s.start;
        if (!still && !Number.isFinite(at)) this.setPlaying(true);
      }
      const [a, b] = this.span();
      this.el.start.textContent = SHORT.format(new Date(a)); this.el.end.textContent = s.caughtUp ? 'now' : SHORT.format(new Date(b));
      this.el.loading.textContent = s.caughtUp ? `${SA.number(s.events.length)} events` : `Loading history · ${Math.round(100 * s.events.length / Math.max(1, s.total))}%`;
      this.histDirty = true;
    }
    /** The scrubber's background: events per bucket over the whole span, the part already played drawn in full ink. */
    drawHistogram() {
      const c = this.el.hist, dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) return;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const n = Math.max(24, Math.min(240, Math.floor(w / 4))), [a, b] = this.span(), counts = new Array(n).fill(0);
      for (const e of this.stream.events) { const i = Math.floor((e[0] - a) / (b - a) * n); if (i >= 0 && i < n) counts[i]++; }
      const max = Math.max(1, ...counts);
      this.bars = {n, counts, max, a, b}; this.histDirty = false; this.drawnAt = null; this.drawPlayhead(true);
    }
    drawPlayhead(force) {
      if (this.histDirty) return this.drawHistogram();
      if (!this.bars) return;
      const {n, counts, max, a, b} = this.bars, c = this.el.hist, ctx = c.getContext('2d'), dpr = devicePixelRatio || 1, w = c.width / dpr, h = c.height / dpr;
      const x = (this.T - a) / (b - a) * w;
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
      // Day ticks along the base so the span reads as days.
      ctx.fillStyle = th.mut;
      for (let d = Math.ceil(a / 86400000) * 86400000; d < b; d += 86400000) ctx.fillRect(Math.round((d - a) / (b - a) * w), h - 3, 1, 3);
    }
  }

  async function boot(root) {
    const type = types[root.dataset.type], stage = root.querySelector('[data-viz-stage]'), status = root.querySelector('[data-viz-status]');
    if (!type) { status.textContent = 'This visualization failed to load. Refresh to try again.'; return; }
    const stream = new Stream(root.dataset.slug);
    let renderer = null;
    const player = new Player(root, stream, (T, info) => renderer?.frame(T, info));
    stream.on(kind => {
      if (kind === 'head' && !renderer) { status.remove(); renderer = type.mount({root, stage, stream, player, slug: root.dataset.slug, theme}); }
      renderer?.data?.(kind); player.onData();
    });
    try { await stream.load(); }
    catch { if (!renderer) status.textContent = 'The record is temporarily unavailable. Refresh to try again.'; }
  }

  window.SAViz = {register, boot, provider, theme, PROVIDER_NAMES, Stream, Player};
})();
