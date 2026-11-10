(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const COLORS = ['#e5484d', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b', '#84cc16'];
  const DEMO = new URLSearchParams(location.search).has('demo');
  const BASE = DEMO ? 'demo/' : 'data/';
  const PAGE = 24;

  const state = { channels: [], history: {}, sel: new Set(), shown: PAGE, charts: {} };

  // ---------- Hilfsfunktionen ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const de = (n, d = 0) => n.toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d });
  function fmt(n) {
    if (n == null) return '–';
    const a = Math.abs(n);
    if (a >= 1e6) return de(n / 1e6, a >= 1e7 ? 1 : 2) + ' Mio.';
    if (a >= 1e4) return de(n / 1e3, a >= 1e5 ? 0 : 1) + ' Tsd.';
    return de(n);
  }
  const pct = (x, d = 1) => (x == null || !isFinite(x) ? '–' : de(x * 100, d) + ' %');
  const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const days = iso => (Date.now() - new Date(iso)) / 86400000;
  function ago(iso) {
    const d = days(iso);
    if (d < 1) return 'heute';
    if (d < 2) return 'gestern';
    if (d < 30) return `vor ${Math.floor(d)} Tagen`;
    if (d < 365) return `vor ${Math.floor(d / 30)} Mon.`;
    return `vor ${Math.floor(d / 365)} J.`;
  }
  function dur(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  }
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // ---------- Daten ----------
  async function load() {
    try {
      const [latest, history] = await Promise.all([
        fetch(BASE + 'latest.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw 0; return r.json(); }),
        fetch(BASE + 'history.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : {})).catch(() => ({})),
      ]);
      state.history = history;
      state.channels = latest.channels.map((c, i) => enrich(c, i));
      state.sel = new Set(state.channels.map(c => c.id));
      $('#updated').textContent = 'Stand: ' + new Date(latest.updated).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
      if (latest.demo) { const b = $('#banner'); b.hidden = false; b.textContent = 'Das sind erfundene Demo-Daten. Deine echten Kanäle siehst du ohne „?demo“ in der Adresse.'; }
      init();
    } catch {
      $('#empty').hidden = false;
      $('#empty').innerHTML = `<h2>Noch keine Daten</h2>
        <p>Der erste Abruf ist noch nicht gelaufen. Starte in deinem GitHub-Repository unter <b>Actions → „Daten aktualisieren“ → Run workflow</b> und lade die Seite nach etwa einer Minute neu.</p>
        <p><a href="?demo">Demo-Ansicht öffnen</a></p>`;
      $$('.tab').forEach(t => (t.hidden = true));
      $('#tabs').hidden = true;
    }
  }

  function enrich(c, i) {
    c.color = COLORS[i % COLORS.length];
    const long = c.videos.filter(v => !v.isShort), shorts = c.videos.filter(v => v.isShort);
    const recent = long.slice(0, 10);
    c.stats = {
      avg10: mean(recent.map(v => v.views)),
      medianLong: median(long.map(v => v.views)),
      medianShort: median(shorts.map(v => v.views)),
      uploads30: c.videos.filter(v => days(v.published) <= 30).length,
      perWeek: (() => { const span = c.videos.length > 1 ? days(c.videos.at(-1).published) : 0; return span > 0 ? (c.videos.length / span) * 7 : 0; })(),
      engagement: (() => { const r = c.videos.slice(0, 20).filter(v => v.likes != null); const vw = r.reduce((s, v) => s + v.views, 0); return vw ? r.reduce((s, v) => s + v.likes + (v.comments || 0), 0) / vw : null; })(),
      avgLen: mean(long.map(v => v.duration)),
      shortShare: c.videos.length ? shorts.length / c.videos.length : 0,
    };
    for (const v of c.videos) {
      const med = v.isShort ? c.stats.medianShort : c.stats.medianLong;
      v.outlier = med ? v.views / med : 0;
      v.eng = v.likes != null && v.views ? (v.likes + (v.comments || 0)) / v.views : null;
      v.ch = c;
    }
    return c;
  }

  function gain(c, windowDays) {
    const h = state.history[c.id] || [];
    if (h.length < 2) return null;
    const last = h.at(-1);
    const cutoff = new Date(last.d); cutoff.setDate(cutoff.getDate() - windowDays);
    const base = h.find(x => new Date(x.d) >= cutoff);
    if (!base || base === last) return null;
    const spanDays = (new Date(last.d) - new Date(base.d)) / 86400000;
    if (spanDays < windowDays * 0.8) return null;
    return { subs: last.s != null && base.s != null ? last.s - base.s : null, views: last.v - base.v, pct: base.s ? (last.s - base.s) / base.s : null };
  }

  // ---------- Tabs ----------
  function init() {
    $$('#tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    renderOverview();
    buildVideoFilters();
    renderVideos();
    $('#metric').addEventListener('change', renderGrowth);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { renderOverview(); renderGrowth(); });
  }
  function showTab(t) {
    $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    $$('.tab').forEach(s => (s.hidden = s.id !== t));
    if (t === 'growth') renderGrowth();
    if (t === 'overview') renderOverview();
    scrollTo({ top: 0 });
  }

  // ---------- Übersicht ----------
  function renderOverview() {
    $('#cards').innerHTML = state.channels.map(c => {
      const g = gain(c, 7);
      return `<article class="card" style="--c:${c.color}">
        <div class="card-head">
          ${c.thumb ? `<img class="avatar" src="${esc(c.thumb)}" alt="" loading="lazy">` : `<div class="avatar">${esc(c.title[0])}</div>`}
          <div><div class="card-title">${esc(c.title)}</div><div class="muted small">${esc(c.handle)}</div></div>
        </div>
        <div class="kpis">
          <div class="kpi"><b>${fmt(c.subs)}</b><span>Abonnenten</span></div>
          <div class="kpi"><b class="${g?.subs > 0 ? 'pos' : ''}">${g?.subs != null ? (g.subs >= 0 ? '+' : '') + fmt(g.subs) : '–'}</b><span>Abos (7 Tage)</span></div>
          <div class="kpi"><b>${fmt(c.stats.avg10)}</b><span>Ø Aufrufe/Video</span></div>
          <div class="kpi"><b>${de(c.stats.perWeek, 1)}</b><span>Videos pro Woche</span></div>
        </div></article>`;
    }).join('');

    const rows = [
      ['Abonnenten', c => c.subs, fmt, 1],
      ['Gesamtaufrufe', c => c.views, fmt, 1],
      ['Videos gesamt', c => c.videoCount, v => de(v), 0],
      ['Ø Aufrufe (letzte 10 Langvideos)', c => c.stats.avg10, fmt, 1],
      ['Median Aufrufe Langvideo', c => c.stats.medianLong, fmt, 1],
      ['Median Aufrufe Short', c => c.stats.medianShort, fmt, 1],
      ['Uploads (30 Tage)', c => c.stats.uploads30, v => de(v), 1],
      ['Videos pro Woche', c => c.stats.perWeek, v => de(v, 1), 1],
      ['Engagement (Likes+Komm./Aufrufe)', c => c.stats.engagement, v => pct(v, 2), 1],
      ['Ø Länge Langvideo', c => c.stats.avgLen, v => dur(Math.round(v)), 0],
      ['Shorts-Anteil', c => c.stats.shortShare, v => pct(v, 0), 0],
      ['Abos +7 Tage', c => gain(c, 7)?.subs, v => (v >= 0 ? '+' : '') + fmt(v), 1],
      ['Abos +30 Tage', c => gain(c, 30)?.subs, v => (v >= 0 ? '+' : '') + fmt(v), 1],
    ];
    $('#compare').innerHTML = `<thead><tr><th></th>${state.channels.map(c => `<th><span class="dot" style="background:${c.color}"></span>${esc(c.title)}</th>`).join('')}</tr></thead><tbody>` +
      rows.map(([label, get, f, highlight]) => {
        const vals = state.channels.map(get);
        const best = highlight ? Math.max(...vals.filter(v => v != null)) : null;
        return `<tr><td>${label}</td>${vals.map(v => `<td class="${highlight && v != null && v === best && state.channels.length > 1 ? 'best' : ''}">${v == null ? '–' : f(v)}</td>`).join('')}</tr>`;
      }).join('') + '</tbody>';

    drawChart('barChart', {
      type: 'bar',
      data: { labels: state.channels.map(c => c.title), datasets: [{ data: state.channels.map(c => Math.round(c.stats.avg10)), backgroundColor: state.channels.map(c => c.color), borderRadius: 8 }] },
      options: { ...chartBase(), plugins: { legend: { display: false } } },
    });
  }

  function chartBase() {
    const text = css('--muted'), grid = css('--line');
    return {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { ticks: { color: text }, grid: { display: false } }, y: { ticks: { color: text, callback: v => fmt(v) }, grid: { color: grid } } },
    };
  }
  function drawChart(id, cfg) {
    state.charts[id]?.destroy();
    state.charts[id] = new Chart($('#' + id), cfg);
  }

  // ---------- Videos ----------
  function buildVideoFilters() {
    $('#chips').innerHTML = state.channels.map(c => `<button class="chip on" data-id="${esc(c.id)}" style="--c:${c.color}">${esc(c.title)}</button>`).join('');
    $$('#chips .chip').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.id;
      state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id);
      b.classList.toggle('on', state.sel.has(id));
      state.shown = PAGE; renderVideos();
    }));
    ['search', 'format', 'range', 'sort'].forEach(id => $('#' + id).addEventListener('input', () => { state.shown = PAGE; renderVideos(); }));
    $('#more').addEventListener('click', () => { state.shown += PAGE; renderVideos(); });
  }

  function renderVideos() {
    const q = $('#search').value.trim().toLowerCase(), fmtSel = $('#format').value, range = +$('#range').value, sort = $('#sort').value;
    let list = state.channels.filter(c => state.sel.has(c.id)).flatMap(c => c.videos);
    if (q) list = list.filter(v => v.title.toLowerCase().includes(q));
    if (fmtSel === 'long') list = list.filter(v => !v.isShort);
    if (fmtSel === 'short') list = list.filter(v => v.isShort);
    if (range) list = list.filter(v => days(v.published) <= range);
    const key = { outlier: v => v.outlier, views: v => v.views, recent: v => +new Date(v.published), engagement: v => v.eng ?? -1 }[sort];
    // Sehr neue Videos haben noch kaum Aufrufe – für "Überperformer" erst ab 3 Tagen Alter.
    if (sort === 'outlier') list = list.filter(v => days(v.published) >= 3);
    list.sort((a, b) => key(b) - key(a));

    $('#videoHint').textContent = `${list.length} Videos` + (sort === 'outlier' ? ' · ×-Wert = Aufrufe im Vergleich zum Median des Kanals (gleiches Format). Videos unter 3 Tagen sind ausgeblendet.' : '');
    $('#videoList').innerHTML = list.slice(0, state.shown).map(v => `
      <a class="video" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener" style="--c:${v.ch.color}">
        <div class="thumb">${v.thumb ? `<img src="${esc(v.thumb)}" alt="" loading="lazy">` : ''}
          <span class="dur">${v.isShort ? 'Short · ' : ''}${dur(v.duration)}</span>
          ${v.outlier >= 1.5 ? `<span class="badge">×${de(v.outlier, 1)}</span>` : ''}
        </div>
        <div class="v-body">
          <div class="v-title">${esc(v.title)}</div>
          <div class="v-ch">${esc(v.ch.title)}</div>
          <div class="v-meta">${fmt(v.views)} Aufrufe · ${ago(v.published)}${v.eng != null ? ` · ${pct(v.eng, 1)} Eng.` : ''}</div>
        </div></a>`).join('');
    $('#more').hidden = list.length <= state.shown;
  }

  // ---------- Wachstum ----------
  function renderGrowth() {
    const metric = $('#metric').value;
    const dates = [...new Set(state.channels.flatMap(c => (state.history[c.id] || []).map(x => x.d)))].sort();
    $('#growthHint').textContent = dates.length < 2
      ? 'Der Verlauf entsteht, weil die Seite jeden Tag einen Snapshot speichert. Ab dem zweiten Tag erscheint hier eine Kurve.'
      : `${dates.length} Tage Verlauf (seit ${new Date(dates[0]).toLocaleDateString('de-DE')}).`;

    const datasets = state.channels.map(c => {
      const h = state.history[c.id] || [];
      const map = new Map(h.map(x => [x.d, x]));
      const first = h.find(x => x.s != null)?.s;
      return {
        label: c.title, borderColor: c.color, backgroundColor: c.color, tension: .25, pointRadius: dates.length > 40 ? 0 : 3, spanGaps: true,
        data: dates.map(d => { const x = map.get(d); if (!x) return null; return metric === 'views' ? x.v : metric === 'subsPct' ? (first ? (x.s / first - 1) * 100 : null) : x.s; }),
      };
    });
    const base = chartBase();
    const isPct = metric === 'subsPct';
    base.scales.y.ticks.callback = v => (isPct ? de(v, 1) + ' %' : fmt(v));
    base.scales.x.ticks.callback = function (i) { return new Date(this.getLabelForValue(i)).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }); };
    base.scales.x.ticks.maxTicksLimit = 8;
    drawChart('lineChart', {
      type: 'line', data: { labels: dates, datasets },
      options: { ...base, interaction: { mode: 'index', intersect: false }, plugins: { legend: { labels: { color: css('--text'), usePointStyle: true } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${isPct ? de(c.parsed.y, 2) + ' %' : de(c.parsed.y)}` } } } },
    });

    const fmtG = v => (v == null ? '–' : (v >= 0 ? '+' : '') + fmt(v));
    $('#gains').innerHTML = `<thead><tr><th></th><th>Abos 7 T.</th><th>Abos 30 T.</th><th>% 30 T.</th><th>Aufrufe 7 T.</th><th>Aufrufe 30 T.</th></tr></thead><tbody>` +
      state.channels.map(c => { const a = gain(c, 7), b = gain(c, 30); return `<tr><td><span class="dot" style="background:${c.color}"></span>${esc(c.title)}</td><td>${fmtG(a?.subs)}</td><td>${fmtG(b?.subs)}</td><td>${b?.pct != null ? pct(b.pct, 2) : '–'}</td><td>${fmtG(a?.views)}</td><td>${fmtG(b?.views)}</td></tr>`; }).join('') + '</tbody>';
  }

  load();
})();
