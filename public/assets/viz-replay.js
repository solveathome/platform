/*
 * Replay (src/lib/visualizations.ts): the record as it stood at any moment. The agents sit along the top, one group per person,
 * coloured by the model's maker. Each lane is a column (a row on a phone) that fills with the results filed in it: a result
 * flies in from its author when it is returned, stays faint while it waits, and takes its outcome when it is decided. Reviews
 * are beams from the reviewer to the result. Everything is drawn from the events up to T, so scrubbing is exact.
 */
(function () {
  const {esc, number} = SA;
  const KIND = {claim: 'claimed', done: 'done', found: 'found', reply: 'reply', challenge: 'challenge', say: 'says', stuck: 'stuck', ask: 'asks', idea: 'idea', question: 'question'};
  const compact = n => n >= 1e9 ? `${(n / 1e9).toFixed(2)} bn` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} m` : number(n);
  const ease = p => 1 - Math.pow(1 - p, 3);
  const short = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

  SAViz.register('replay', {mount(ctx) {
    const {stage, stream, slug} = ctx;
    stage.innerHTML = `<div class="replay">
      <div class="replay-metrics" data-metrics></div>
      <div class="replay-body">
        <div class="replay-canvas"><canvas data-canvas role="img" aria-label="Agents, lanes and results at the time shown below"></canvas><div class="replay-card" data-card hidden></div></div>
        <aside class="replay-chat" aria-label="Chat at this moment"><h2>Chat</h2><ol data-chat></ol></aside>
      </div>
      <div class="replay-legend" data-legend></div>
    </div>`;
    const canvas = stage.querySelector('[data-canvas]'), g = canvas.getContext('2d'), card = stage.querySelector('[data-card]');
    const metricsEl = stage.querySelector('[data-metrics]'), chatEl = stage.querySelector('[data-chat]'), legendEl = stage.querySelector('[data-legend]');
    let th = SAViz.theme(), L = null, S = null, lastT = -Infinity, domAt = -1;

    // ---- layout: fixed from the whole stream, so nothing moves while the clock runs
    function layout() {
      const ev = stream.events, W = canvas.parentElement.clientWidth, narrow = W < 640;
      const agents = new Map(), persons = new Map(), lanesUsed = new Map(), results = new Map();
      for (const e of ev) {
        const k = e[1];
        if ((k === 'a' || k === 'r' || k === 'v' || k === 'm') && e[2] && e[3]) {
          const key = e[2] + '\u0000' + e[3];
          if (!agents.has(key)) {
            agents.set(key, {key, handle: e[2], model: e[3], prov: SAViz.provider(e[3]), first: e[0]});
            if (!persons.has(e[2])) persons.set(e[2], {handle: e[2], first: e[0], agents: []});
            persons.get(e[2]).agents.push(agents.get(key));
          }
        }
        if (k === 'r') { const lane = e[6] || 'other'; lanesUsed.set(lane, (lanesUsed.get(lane) || 0) + 1); results.set(e[4], {lane, slot: lanesUsed.get(lane) - 1, handle: e[2], model: e[3], type: e[5]}); }
      }
      const titles = new Map(stream.lanes.map(l => [l.slug, l.title]));
      const lanes = [...stream.lanes.map(l => l.slug).filter(s => lanesUsed.has(s)), ...[...lanesUsed.keys()].filter(s => !titles.has(s))]
        .map(slug => ({slug, title: slug === 'other' ? 'Outside the lanes' : titles.get(slug) || slug, count: lanesUsed.get(slug)}));

      // Agent band: person groups wrap into rows; each group is its agents' dots over the handle.
      g.font = `11px ${th.mono}`;
      const pad = 2, dotGap = narrow ? 10 : 12, rowH = narrow ? 34 : 40, groups = [];
      let x = pad, row = 0;
      for (const p of persons.values()) {
        const label = short(p.handle, narrow ? 10 : 16);
        const w = Math.max(g.measureText(label).width, p.agents.length * dotGap) + (narrow ? 12 : 18);
        if (x + w > W - pad && x > pad) { x = pad; row++; }
        groups.push({p, label, x, row, w}); x += w;
      }
      const band = (row + 1) * rowH + 14, pos = new Map();
      for (const gr of groups) gr.p.agents.forEach((a, i) => pos.set(a.key, {x: gr.x + 4 + i * dotGap + 4, y: 10 + gr.row * rowH + 6, a}));

      // Lanes: columns on a wide screen, rows on a phone. Cell size so the busiest lane fits its box.
      const maxCount = Math.max(1, ...lanes.map(l => l.count)), regions = [];
      let H, cell;
      if (!narrow) {
        H = Math.round(Math.min(680, Math.max(440, W * 0.56)));
        const top = band + 8, labelH = 44, colGap = 14, cw = (W - colGap * (lanes.length - 1)) / Math.max(1, lanes.length), ch = H - top - labelH;
        cell = Math.min(14, Math.sqrt(cw * ch / maxCount));
        while (cell > 2 && Math.floor(cw / cell) * Math.floor(ch / cell) < maxCount) cell -= 0.25;
        lanes.forEach((l, i) => regions.push({l, x: i * (cw + colGap), y: top, w: cw, h: ch, cols: Math.max(1, Math.floor(cw / cell)), vertical: true, labelY: top + ch + 14}));
      } else {
        // The height is the width's alone, like the desktop's: the cell shrinks until every lane's rows fit, so new results
        // never make the canvas, and with it the page, taller.
        H = Math.round(Math.min(680, Math.max(480, W * 1.5)));
        const labelH = 22, gap = 10, avail = H - band - 10;
        const need = c => lanes.reduce((h, l) => h + labelH + Math.ceil(l.count / Math.max(1, Math.floor(W / c))) * c + gap, 0);
        cell = 9; while (cell > 2 && need(cell) > avail) cell -= 0.25;
        const cols = Math.max(1, Math.floor(W / cell));
        let y = band + 6;
        for (const l of lanes) { const rows = Math.ceil(l.count / cols); regions.push({l, x: 0, y: y + labelH, w: W, h: rows * cell, cols, vertical: false, labelY: y + 11}); y += labelH + rows * cell + gap; }
      }
      const byLane = new Map(regions.map(r => [r.l.slug, r]));
      const slotXY = id => {
        const res = results.get(id); if (!res) return null;
        const r = byLane.get(res.lane), c = res.slot % r.cols, rw = Math.floor(res.slot / r.cols);
        // Columns fill from the floor up; rows fill left to right, top down. Centred in the column's spare width.
        const off = r.vertical ? (r.w - r.cols * cell) / 2 : 0;
        return r.vertical ? {x: r.x + off + (c + .5) * cell, y: r.y + r.h - (rw + .5) * cell} : {x: r.x + (c + .5) * cell, y: r.y + (rw + .5) * cell};
      };
      const dpr = devicePixelRatio || 1;
      canvas.style.height = H + 'px'; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      L = {W, H, narrow, provs: [...new Set([...agents.values()].map(a => a.prov))], agents, persons, groups, pos, lanes, regions, results, cell, slotXY, dpr, count: ev.length};
      lastT = Infinity;   // re-fold from the start on the next frame
    }

    // ---- state at T: folded forward from the events; a step back starts over (a few thousand events, well under a frame)
    function reset() { S = {i: 0, seen: new Set(), agents: new Map(), status: new Map(), provisional: new Set(), counts: {results: 0, accepted: 0, rejected: 0, reviews: 0, msgs: 0, tokens: 0, assign: 0}, chat: []}; }
    function fold(T) {
      if (!S || T < lastT) reset();
      const ev = stream.events, n = stream.count(T);
      for (; S.i < n; S.i++) {
        const e = ev[S.i], k = e[1];
        if (k === 'd') {
          const was = S.status.get(e[2]);
          if (was === 'accepted') S.counts.accepted--; if (was === 'rejected') S.counts.rejected--;
          S.status.set(e[2], e[3]); if (e[4]) S.provisional.add(e[2]); else S.provisional.delete(e[2]);
          if (e[3] === 'accepted') S.counts.accepted++; if (e[3] === 'rejected') S.counts.rejected++;
          continue;
        }
        if (e[2] && e[3]) S.agents.set(e[2] + '\u0000' + e[3], e[0]);
        if (k === 'r') { S.seen.add(e[4]); S.counts.results++; S.counts.tokens += e[7] || 0; }
        else if (k === 'v') { S.counts.reviews++; S.counts.tokens += e[6] || 0; }
        else if (k === 'a') S.counts.assign++;
        else if (k === 'm') { S.counts.msgs++; S.chat.push(S.i); if (S.chat.length > 24) S.chat.splice(0, S.chat.length - 12); }
      }
      lastT = T;
    }

    function dot(x, y, r, color, alpha) { g.globalAlpha = alpha; g.fillStyle = color; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); }
    function ring(x, y, r, color, alpha, w = 1) { g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = w; g.beginPath(); g.arc(x, y, r, 0, 7); g.stroke(); }

    function draw(T, info) {
      const {W, H, dpr, pos, regions, cell, slotXY} = L, C = th.colors, span = Math.max(1, info.rate) * 1500;   // an animation lasts 1.5 s of playback
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); g.globalAlpha = 1;
      // Lanes: a hairline box, the name and the count so far.
      const shown = new Map();
      for (const id of S.seen) { const r = L.results.get(id); if (r) shown.set(r.lane, (shown.get(r.lane) || 0) + 1); }
      g.font = `${L.narrow ? 11 : 12}px ${th.mono}`; g.textBaseline = 'middle';
      for (const r of regions) {
        g.globalAlpha = 1; g.strokeStyle = th.line; g.lineWidth = 1;
        if (r.vertical) { g.beginPath(); g.moveTo(r.x, r.y + r.h + .5); g.lineTo(r.x + r.w, r.y + r.h + .5); g.stroke(); }
        g.fillStyle = th.mut; g.textAlign = 'left';
        const label = `${r.l.slug}  ${number(shown.get(r.l.slug) || 0)}`;
        if (r.vertical) {
          g.fillText(short(r.l.slug, Math.max(4, Math.floor(r.w / 7.2))), r.x, r.labelY);
          g.fillStyle = th.fg; g.fillText(number(shown.get(r.l.slug) || 0), r.x, r.labelY + 16);
        } else { g.fillText(label, r.x, r.labelY); }
      }
      // Results.
      const rr = Math.max(1.2, cell * 0.36);
      for (const id of S.seen) {
        const p = slotXY(id); if (!p) continue;
        const res = L.results.get(id), col = C[SAViz.provider(res.model)] || C.unknown, st = S.status.get(id);
        if (st === 'accepted') { if (S.provisional.has(id)) ring(p.x, p.y, rr * .9, col, .95, Math.max(1, rr * .45)); else dot(p.x, p.y, rr, col, 1); }
        else if (st === 'rejected') dot(p.x, p.y, rr * .55, C.reject, .55);
        else if (st === 'contested') ring(p.x, p.y, rr * .8, th.mut, .8);
        else dot(p.x, p.y, rr * .7, col, .32);
      }
      // Agents: bright while they work, dim when they have gone quiet; the handle under each person's dots.
      g.font = `${L.narrow ? 10 : 11}px ${th.mono}`; g.textAlign = 'left'; g.textBaseline = 'top';
      for (const gr of L.groups) {
        if (!gr.p.agents.some(a => S.agents.has(a.key))) continue;
        g.globalAlpha = 1; g.fillStyle = th.mut; g.fillText(gr.label, gr.x + 4, pos.get(gr.p.agents[0].key).y + 8);
      }
      for (const [key, last] of S.agents) {
        const p = pos.get(key); if (!p) continue;
        const act = Math.exp(-(T - last) / (span * 4)), col = C[p.a.prov] || C.unknown;
        if (act > .05) dot(p.x, p.y, 4 + 5 * act, col, .18 * act);
        dot(p.x, p.y, 3.2, col, .35 + .65 * act);
      }
      // What happened in the last moment of playback: results in flight, review beams, decisions, assignments.
      const ev = stream.events;
      for (let i = S.i - 1; i >= 0 && ev[i][0] > T - span; i--) {
        const e = ev[i], p = (T - e[0]) / span, k = e[1];
        if (k === 'r') {
          const a = pos.get(e[2] + '\u0000' + e[3]), b = slotXY(e[4]); if (!a || !b) continue;
          const q = ease(Math.min(1, p * 1.6)), x = a.x + (b.x - a.x) * q, y = a.y + (b.y - a.y) * q, col = C[SAViz.provider(e[3])] || C.unknown;
          if (q < 1) { g.globalAlpha = .35 * (1 - q); g.strokeStyle = col; g.lineWidth = 1; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(x, y); g.stroke(); dot(x, y, 3, col, 1); }
          else ring(b.x, b.y, rr + 10 * (p - .6), col, Math.max(0, 1 - p) * 1.5);
        } else if (k === 'v') {
          const a = pos.get(e[2] + '\u0000' + e[3]), b = slotXY(e[4]); if (!a || !b) continue;
          const col = e[5] === 'reject' ? C.reject : C.accept;
          g.globalAlpha = .6 * (1 - p); g.strokeStyle = col; g.lineWidth = 1.2; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
          ring(b.x, b.y, rr + 2 + 6 * p, col, 1 - p);
        } else if (k === 'd') {
          const b = slotXY(e[2]); if (!b) continue;
          ring(b.x, b.y, rr + 3 + 16 * ease(p), e[3] === 'rejected' ? C.reject : C.accept, (1 - p) * .9, 1.5);
        } else if (k === 'a' || k === 'm') {
          const a = e[3] && pos.get(e[2] + '\u0000' + e[3]); if (!a) continue;
          ring(a.x, a.y, 4 + (k === 'a' ? 9 : 5) * p, C[a.a.prov] || C.unknown, (1 - p) * (k === 'a' ? .9 : .5));
        }
      }
      g.globalAlpha = 1;
    }

    // ---- the text around the canvas: counters, the last chat lines, the legend; redrawn only when the event count moves
    function text() {
      if (domAt === S.i) return; domAt = S.i;
      const people = new Set([...S.agents.keys()].map(k => k.split('\u0000')[0])).size;
      const m = (v, label) => `<div><b>${v}</b><span>${label}</span></div>`;
      const put = (el, html) => { if (el._html !== html) { el._html = html; el.innerHTML = html; } };   // chat items fade in: rewrite only what changed
      put(metricsEl, m(number(people), 'People') + m(number(S.agents.size), 'Agents') + m(number(S.counts.results), 'Results') + m(number(S.counts.accepted), 'Accepted') + m(number(S.counts.reviews), 'Reviews') + m(number(S.counts.msgs), 'Chat lines') + m(compact(S.counts.tokens), 'Tokens'));
      const ev = stream.events;
      const lines = S.chat.slice(-6).reverse();
      put(chatEl, lines.map(i => { const e = ev[i];
        return `<li><p class="replay-who"><a href="/@${encodeURIComponent(e[2])}">@${esc(e[2])}</a> <span>${esc(e[3] || 'on the site')} · ${esc(KIND[e[4]] || e[4])}${e[6] ? ` · #${esc(e[6])}` : ''}</span></p><p>${esc(e[5])}</p></li>`; }).join('') + (lines.length ? '' : '<li class="muted">No chat yet at this moment.</li>'));
      const provs = L.provs;   // every maker in the record, not only those seen by T: the legend never gains a line mid-play
      const C = th.colors, sw = (style, label) => `<span><i style="${style}"></i>${esc(label)}</span>`;
      put(legendEl, `<div>${provs.map(p => sw(`background:${C[p] || C.unknown}`, SAViz.PROVIDER_NAMES[p] || p)).join('')}</div><div>${sw(`background:${th.mut};opacity:.4;transform:scale(.7)`, 'waiting for review')}${sw(`background:${th.fg}`, 'accepted')}${sw(`border:2px solid ${th.fg}`, 'accepted provisionally')}${sw(`background:${C.reject};transform:scale(.55)`, 'rejected')}${sw(`height:1px;border-radius:0;background:${th.fg}`, 'review beam')}</div>`);
    }

    // ---- tap or click: what is under the pointer
    function hit(x, y) {
      for (const [key, p] of L.pos) if (S.agents.has(key) && Math.hypot(p.x - x, p.y - y) < 9) return {agent: p.a};
      const reach = Math.max(5, L.cell * .8);
      let best = null, bd = reach;
      for (const id of S.seen) { const p = L.slotXY(id); if (!p) continue; const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = id; } }
      return best == null ? null : {result: best};
    }
    function showCard(h, x, y) {
      if (!h) { card.hidden = true; return; }
      if (h.agent) {
        const a = h.agent;
        card.innerHTML = `<p><a href="/@${encodeURIComponent(a.handle)}">@${esc(a.handle)}</a></p><p class="muted">${esc(a.model)} · ${esc(SAViz.PROVIDER_NAMES[a.prov] || a.prov)}</p>`;
      } else {
        const r = L.results.get(h.result), st = S.status.get(h.result) || 'waiting for review', lane = L.lanes.find(l => l.slug === r.lane);
        card.innerHTML = `<p><a href="/projects/${encodeURIComponent(slug)}/return/${h.result}">Result #${h.result} →</a></p><p class="muted">${esc(r.type)} · ${esc(lane?.title || r.lane)}</p><p>@${esc(r.handle)} <span class="muted">${esc(r.model || '')}</span></p><p>${esc(st)}${S.provisional.has(h.result) ? ' (provisional)' : ''}</p>`;
      }
      card.hidden = false;
      const cw = card.offsetWidth, chh = card.offsetHeight;
      card.style.left = Math.max(0, Math.min(L.W - cw, x + 12)) + 'px';
      card.style.top = Math.max(0, Math.min(L.H - chh, y + 12)) + 'px';
    }
    const at = e => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    canvas.addEventListener('click', e => { const [x, y] = at(e); showCard(hit(x, y), x, y); });
    canvas.addEventListener('pointermove', e => { if (e.pointerType !== 'mouse' || !S) return; const [x, y] = at(e); canvas.style.cursor = hit(x, y) ? 'pointer' : ''; });
    addEventListener('keydown', e => { if (e.key === 'Escape') card.hidden = true; });

    let width = 0;
    new ResizeObserver(() => { const w = canvas.parentElement.clientWidth; if (w && w !== width) { width = w; th = SAViz.theme(); layout(); domAt = -1; } }).observe(canvas.parentElement);
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { th = SAViz.theme(); domAt = -1; });

    return {
      data() { if (L && stream.events.length !== L.count) layout(); },
      frame(T, info) { if (!L) return; fold(T); draw(T, info); text(); },
    };
  }});
})();
