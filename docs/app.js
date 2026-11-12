(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  // Kanalfarben, geprüft auf Kontrast und Farbfehlsichtigkeit vor dem dunklen Hintergrund (feste Reihenfolge)
  const COLORS = ['#ee5a6f', '#4b8df2', '#bb841f', '#22ad7f', '#9276e8', '#c9773a', '#2ba4bd', '#d9649b'];
  const DEMO = new URLSearchParams(location.search).has('demo');
  const BASE = DEMO ? 'demo/' : 'data/';
  const PAGE = 24;
  const DAY = 86400000;
  const FMT_LABEL = { video: 'Video', short: 'Short', live: 'Live' };

  // Linien und Punkte in Diagrammen bekommen einen leichten Leuchteffekt
  if (window.Chart) {
    Chart.defaults.font.family = '"Figtree", system-ui, sans-serif';
    Chart.register({
      id: 'glow',
      beforeDatasetDraw(chart, args) {
        if (chart.config.type === 'bar') return;
        const ds = chart.data.datasets[args.index];
        chart.ctx.save(); chart.ctx.shadowColor = ds.borderColor; chart.ctx.shadowBlur = 10;
      },
      afterDatasetDraw(chart) { if (chart.config.type !== 'bar') chart.ctx.restore(); },
    });
  }

  const state = { channels: [], history: {}, sel: new Set(), shown: PAGE, charts: {}, period: 28, tab: 'overview', saved: {}, byId: new Map(), wallShown: 24 };
  const BERLIN = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

  // ---------- Hilfsfunktionen ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const de = (n, d = 0) => n.toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d });
  function fmt(n) {
    if (n == null || !isFinite(n)) return '–';
    const a = Math.abs(n);
    if (a >= 1e6) return de(n / 1e6, a >= 1e7 ? 1 : 2) + ' Mio.';
    if (a >= 1e4) return de(n / 1e3, a >= 1e5 ? 0 : 1) + ' Tsd.';
    return de(n);
  }
  const sg = n => (n > 0 ? '+' : '') + fmt(n);
  const sg1 = n => (n > 0 ? '+' : '') + (Math.abs(n) < 100 ? de(n, 1) : fmt(n));
  const pct = (x, d = 1) => (x == null || !isFinite(x) ? '–' : de(x * 100, d) + ' %');
  const sgp = (x, d = 1) => (x == null || !isFinite(x) ? '–' : (x > 0 ? '+' : '') + pct(x, d));
  const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sum = a => a.reduce((x, y) => x + y, 0);
  const days = iso => (Date.now() - new Date(iso)) / DAY;
  const dnum = d => Date.parse(d + 'T00:00:00Z') / DAY;
  const thumbUrl = v => (DEMO ? '' : `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`);
  function ago(d) {
    if (d < 1) return 'heute';
    if (d < 2) return 'gestern';
    if (d < 30) return `vor ${Math.floor(d)} Tagen`;
    if (d < 365) return `vor ${Math.floor(d / 30)} Mon.`;
    return `vor ${Math.floor(d / 365)} J.`;
  }
  function dur(s) {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  }
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // ---------- Daten laden ----------
  async function load() {
    try {
      const [latest, history] = await Promise.all([
        fetch(BASE + 'latest.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw 0; return r.json(); }),
        fetch(BASE + 'history.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : {})).catch(() => ({})),
      ]);
      state.history = history;
      state.channels = latest.channels.map((c, i) => enrich(c, i));
      state.sel = new Set(state.channels.map(c => c.id));
      state.byId = new Map(state.channels.flatMap(c => c.videos.map(v => [v.id, v])));
      $('#updated').textContent = 'Stand: ' + new Date(latest.updated).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
      if (latest.demo) { const b = $('#banner'); b.hidden = false; b.textContent = 'Das sind erfundene Demo-Daten. Deine echten Kanäle siehst du ohne „?demo“ in der Adresse.'; }
      init();
    } catch {
      $('#empty').hidden = false;
      $('#empty').innerHTML = `<h2>Noch keine Daten</h2>
        <p>Der erste Abruf ist noch nicht gelaufen. Starte in deinem GitHub-Repository unter <b>Actions → „Daten aktualisieren“ → Run workflow</b> und lade die Seite nach etwa einer Minute neu.</p>
        <p><a href="?demo">Demo-Ansicht öffnen</a></p>`;
      $$('.tab').forEach(t => (t.hidden = true));
      $('#tabs').hidden = true; $('#periodBar').hidden = true;
    }
  }

  // Berechnet alle Kennzahlen, die nur von den Videodaten eines Kanals abhängen.
  function enrich(c, i) {
    c.color = COLORS[i % COLORS.length];
    for (const v of c.videos) {
      v.fmt ||= v.isShort ? 'short' : 'video'; // ältere Datenstände kennen nur isShort
      v.age = days(v.published);
      v.perDay = v.views / Math.max(v.age, 1);
      v.like = v.likes != null && v.views ? v.likes / v.views : null;
      v.eng = v.likes != null && v.views ? (v.likes + (v.comments || 0)) / v.views : null;
      v.ch = c;
      const parts = BERLIN.formatToParts(new Date(v.published));
      v.wd = WD[parts.find(p => p.type === 'weekday').value];
      v.hr = +parts.find(p => p.type === 'hour').value % 24;
    }
    c.med = {}; c.cnt = {};
    for (const f of ['video', 'short', 'live']) {
      const all = c.videos.filter(v => v.fmt === f);
      const mature = all.filter(v => v.age >= 14); // sehr junge Videos würden den Median drücken
      c.cnt[f] = all.length;
      c.med[f] = all.length ? median((mature.length >= 5 ? mature : all).map(v => v.views)) : null;
    }
    for (const v of c.videos) { const m = c.med[v.fmt]; v.outlier = m && c.cnt[v.fmt] >= 5 ? v.views / m : 0; }
    // Start-Werte: Median-Aufrufe nach 24 Std. / 3 / 7 Tagen je Format (ab 3 Videos)
    c.early = {};
    for (const f of ['video', 'short', 'live']) {
      c.early[f] = {};
      for (const k of ['e1', 'e3', 'e7']) { const xs = c.videos.filter(v => v.fmt === f && v[k] != null).map(v => v[k]); c.early[f][k] = xs.length >= 3 ? median(xs) : null; }
    }

    const vids = c.videos.filter(v => v.fmt === 'video');
    const rated = c.videos.slice(0, 20).filter(v => v.likes != null);
    const rv = sum(rated.map(v => v.views));
    const oldest = c.videos.at(-1)?.age ?? 90;
    const win = Math.max(7, Math.min(90, oldest));
    c.avg10 = vids.length ? mean(vids.slice(0, 10).map(v => v.views)) : null;
    c.avgLen = vids.length ? mean(vids.map(v => v.duration)) : null;
    c.likeRate = rv ? sum(rated.map(v => v.likes)) / rv : null;
    c.engagement = rv ? sum(rated.map(v => v.likes + (v.comments || 0))) / rv : null;
    c.share = Object.fromEntries(['video', 'short', 'live'].map(f => [f, c.videos.length ? c.cnt[f] / c.videos.length : 0]));
    c.perWeek90 = c.videos.filter(v => v.age <= 90).length / (win / 7);
    c.viewsPerVideo = c.videoCount ? c.views / c.videoCount : null;
    return c;
  }

  // Videos, die in den letzten P Tagen erschienen sind (bisher erzielte Aufrufe, nicht Aufrufe im Zeitraum).
  function periodStats(c, P) {
    const vs = c.videos.filter(v => v.age <= P);
    const views = sum(vs.map(v => v.views));
    const withLikes = vs.filter(v => v.likes != null);
    const lv = sum(withLikes.map(v => v.views));
    return {
      count: vs.length,
      by: { video: vs.filter(v => v.fmt === 'video').length, short: vs.filter(v => v.fmt === 'short').length, live: vs.filter(v => v.fmt === 'live').length },
      views, avg: vs.length ? views / vs.length : null,
      best: vs.reduce((b, v) => (!b || v.views > b.views ? v : b), null),
      likeRate: lv ? sum(withLikes.map(v => v.likes)) / lv : null,
      perWeek: vs.length / (P / 7),
    };
  }

  // Kanalwachstum aus den täglichen Snapshots. Ist der Verlauf kürzer als P, gilt der Wert für die vorhandenen Tage (partial).
  function histGain(c, P) {
    const h = state.history[c.id] || [];
    if (h.length < 2) return null;
    const last = h.at(-1), lastN = dnum(last.d), target = lastN - P;
    let base = null;
    for (const x of h) if (dnum(x.d) <= target) base = x;
    const partial = !base;
    if (!base) base = h[0];
    const span = lastN - dnum(base.d);
    if (span < 1) return null;
    const out = { span, partial, views: last.v - base.v, subs: last.s != null && base.s != null ? last.s - base.s : null };
    out.viewsDay = out.views / span;
    // Bevorzugt: Aufrufe-Zuwachs aus den einzelnen Videos (zuverlässiger als die Kanal-Gesamtzahl) mit echter Zeitspanne
    const seg = h.slice(h.indexOf(base) + 1);
    const vidSum = part => (part.length && part.every(x => x.vg != null) ? { views: sum(part.map(x => x.vg)), hours: sum(part.map(x => x.h ?? 24)) } : null);
    const vs = vidSum(seg);
    if (vs) { out.views = vs.views; out.viewsDay = vs.views / Math.max(vs.hours / 24, 1 / 24); out.fromVideos = true; }
    out.subsDay = out.subs != null ? out.subs / span : null;
    out.subsPct = out.subs != null && base.s ? out.subs / base.s : null;
    if (!partial) {
      let b2 = null;
      for (const x of h) if (dnum(x.d) <= target - P) b2 = x;
      if (b2) {
        const pv = vidSum(h.slice(h.indexOf(b2) + 1, h.indexOf(base) + 1));
        const prev = vs ? pv?.views : base.v - b2.v;
        out.deltaViews = prev > 0 ? out.views / prev - 1 : null;
      }
    }
    return out;
  }
  const sumG = (c, w) => { const a = c.videos.filter(v => v['g' + w] != null); return a.length ? sum(a.map(v => v['g' + w])) : null; };

  // ---------- Tabs ----------
  function init() {
    $$('#tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $$('#periods button').forEach(b => b.addEventListener('click', () => {
      state.period = +b.dataset.p;
      $$('#periods button').forEach(x => x.classList.toggle('on', x === b));
      renderCurrent();
    }));
    initSaved();
    initIdeas();
    buildVideoFilters();
    $('#metric').addEventListener('change', renderGrowth);
    $('#cformat').addEventListener('change', renderContent);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderCurrent);
    renderVideos();
    showTab('overview');
  }
  function showTab(t) {
    state.tab = t;
    $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    $$('.tab').forEach(s => (s.hidden = s.id !== t));
    $('#periodBar').hidden = !(t === 'overview' || t === 'growth');
    renderCurrent();
    scrollTo({ top: 0 });
  }
  function renderCurrent() {
    if (state.tab === 'overview') renderOverview();
    if (state.tab === 'growth') renderGrowth();
    if (state.tab === 'content') renderContent();
    if (state.tab === 'ideas') renderIdeas();
  }

  // ---------- Übersicht ----------
  function renderOverview() {
    const P = state.period;
    const ps = new Map(state.channels.map(c => [c.id, periodStats(c, P)]));
    const hg = new Map(state.channels.map(c => [c.id, histGain(c, P)]));

    $('#cards').innerHTML = state.channels.map(c => {
      const g = hg.get(c.id);
      return `<article class="card" style="--c:${c.color}">
        <div class="card-head">
          ${c.thumb ? `<img class="avatar" src="${esc(c.thumb)}" alt="" loading="lazy">` : `<div class="avatar">${esc(c.title[0])}</div>`}
          <div><div class="card-title">${esc(c.title)}</div><div class="muted small">${esc(c.handle)}</div></div>
        </div>
        <div class="kpis">
          <div class="kpi"><b>${fmt(c.subs)}</b><span>Abonnenten</span></div>
          <div class="kpi"><b class="${g?.subs > 0 ? 'pos' : ''}">${g?.subs != null ? sg(g.subs) : '–'}</b><span>Abos (${P} T.)${g?.partial ? ` · ${g.span} T. Daten` : ''}</span></div>
          <div class="kpi"><b>${g ? fmt(g.viewsDay) : '–'}</b><span>Aufrufe pro Tag</span></div>
          <div class="kpi"><b>${fmt(c.avg10)}</b><span>Ø Aufrufe/Video</span></div>
        </div></article>`;
    }).join('');

    const H = key => c => { const g = hg.get(c.id); return g && g[key] != null ? { n: g[key], note: g.partial ? g.span + ' T.' : null } : null; };
    const S = fn => c => fn(ps.get(c.id), c);
    const rows = [
      { sec: `Kanal-Entwicklung · letzte ${P} Tage`, collapse: 'Noch kein Verlauf gespeichert. Aufrufe, Abo-Zuwachs und die Veränderung zur Vorperiode erscheinen ab morgen, sobald der zweite Tagessnapshot vorliegt.' },
      { l: 'Aufrufe', get: H('views'), f: fmt, best: 1 },
      { l: 'Aufrufe pro Tag', get: H('viewsDay'), f: fmt, best: 1 },
      { l: 'Veränderung zur Vorperiode', get: H('deltaViews'), f: v => sgp(v, 0), best: 1 },
      { l: 'Abonnenten netto', get: H('subs'), f: sg, best: 1 },
      { l: 'Abos pro Tag', get: H('subsDay'), f: sg1, best: 1 },
      { l: 'Abo-Wachstum', get: H('subsPct'), f: v => sgp(v, 2), best: 1 },
      { sec: `Neue Videos · veröffentlicht in den letzten ${P} Tagen` },
      { l: 'Veröffentlichte Videos', get: S(p => p.count), f: de, best: 1 },
      { l: 'Davon Videos / Shorts / Live', get: S(p => ({ n: null, text: `${p.by.video} / ${p.by.short} / ${p.by.live}` })) },
      { l: 'Videos pro Woche', get: S(p => p.perWeek), f: v => de(v, 1), best: 1 },
      { l: 'Aufrufe dieser Videos (bisher)', get: S(p => p.views), f: fmt, best: 1 },
      { l: 'Ø Aufrufe je Video', get: S(p => p.avg), f: fmt, best: 1 },
      { l: 'Bestes Video', get: S(p => (p.best ? { n: p.best.views, text: `<span title="${esc(p.best.title)}">${fmt(p.best.views)}</span>` } : null)), f: fmt, best: 1 },
      { l: 'Like-Rate', get: S(p => p.likeRate), f: v => pct(v, 2), best: 1 },
      { sec: 'Trend · Aufrufe aller abgerufenen Videos', collapse: 'Die Trendwerte pro Video erscheinen nach 1 Tag (24 Stunden), 7 Tagen und 28 Tagen.' },
      { l: 'Letzte 24 Stunden', get: c => sumG(c, 1), f: fmt, best: 1 },
      { l: 'Letzte 7 Tage', get: c => sumG(c, 7), f: fmt, best: 1 },
      { l: 'Letzte 28 Tage', get: c => sumG(c, 28), f: fmt, best: 1 },
      { sec: 'Kanal gesamt' },
      { l: 'Abonnenten', get: c => c.subs, f: fmt, best: 1 },
      { l: 'Gesamtaufrufe', get: c => c.views, f: fmt, best: 1 },
      { l: 'Videos gesamt', get: c => c.videoCount, f: de },
      { l: 'Ø Aufrufe pro Video (gesamt)', get: c => c.viewsPerVideo, f: fmt, best: 1 },
      { l: 'Kanal seit', get: c => (c.created ? { n: null, text: new Date(c.created).toLocaleDateString('de-DE', { month: 'short', year: 'numeric' }) } : null) },
      { l: 'Median Aufrufe · Video', get: c => (c.cnt.video ? c.med.video : null), f: fmt, best: 1 },
      { l: 'Median Aufrufe · Short', get: c => (c.cnt.short ? c.med.short : null), f: fmt, best: 1 },
      { l: 'Median Aufrufe · Livestream', get: c => (c.cnt.live ? c.med.live : null), f: fmt, best: 1 },
      { l: 'Like-Rate (letzte 20)', get: c => c.likeRate, f: v => pct(v, 2), best: 1 },
      { l: 'Engagement (Likes + Komm.)', get: c => c.engagement, f: v => pct(v, 2), best: 1 },
      { l: 'Ø Länge Video', get: c => c.avgLen, f: dur },
      { l: 'Anteil Videos / Shorts / Live', get: c => ({ n: null, text: `${de(c.share.video * 100)} / ${de(c.share.short * 100)} / ${de(c.share.live * 100)} %` }) },
      { l: 'Uploads pro Woche (90 T.)', get: c => c.perWeek90, f: v => de(v, 1), best: 1 },
    ];
    const noHist = ![...hg.values()].some(Boolean);
    $('#overviewNote').textContent = noHist ? ''
      : 'Kursive Werte: Der gespeicherte Verlauf ist noch kürzer als der gewählte Zeitraum, die Zahl gilt für die angegebenen Tage. Aufrufe und Abos entstehen aus den täglichen Snapshots. Die Aufrufe im Zeitraum werden aus den einzelnen Videos (bis ca. 400 Tage alt) berechnet, weil YouTube die Gesamtaufrufe eines Kanals nur unregelmäßig aktualisiert. Abozahlen rundet YouTube, sie ändern sich deshalb nur in Stufen.';
    const cols = state.channels.length + 1;
    const evalRow = r => state.channels.map(c => {
      const v = r.get(c);
      if (v == null) return { n: null, html: '–' };
      const o = typeof v === 'object' ? v : { n: v };
      const html = o.text ?? (o.n == null ? '–' : r.f(o.n));
      return { n: o.n, partial: !!o.note, html: html + (o.note ? ` <small title="Verlauf erst ${o.note}">(${o.note})</small>` : '') };
    });
    const groups = [];
    for (const r of rows) { if (r.sec) groups.push({ head: r, items: [] }); else groups.at(-1).items.push(r); }
    const body = groups.map(g => {
      const head = `<tr class="sec"><td colspan="${cols}">${esc(g.head.sec)}</td></tr>`;
      const evaluated = g.items.map(r => ({ r, cells: evalRow(r) }));
      // Solange für eine Gruppe noch gar keine Werte vorliegen, steht dort nur ein Hinweis statt lauter Striche.
      if (g.head.collapse && evaluated.every(e => e.cells.every(x => x.n == null && x.html === '–'))) {
        return head + `<tr class="empty-row"><td colspan="${cols}">${esc(g.head.collapse)}</td></tr>`;
      }
      return head + evaluated.map(({ r, cells }) => {
        const nums = cells.map(x => x.n).filter(n => n != null);
        const best = r.best && state.channels.length > 1 && nums.length ? Math.max(...nums) : null;
        return `<tr><td>${esc(r.l)}</td>${cells.map(x => `<td class="${best != null && x.n === best ? 'best' : ''} ${x.partial ? 'partial' : ''}">${x.html}</td>`).join('')}</tr>`;
      }).join('');
    }).join('');
    $('#compare').innerHTML = `<thead><tr><th></th>${state.channels.map(c => `<th><span class="dot" style="background:${c.color}"></span>${esc(c.title)}</th>`).join('')}</tr></thead><tbody>${body}</tbody>`;

    $('#barTitle1').textContent = `Aufrufe der Videos aus den letzten ${P} Tagen`;
    const bar = (id, data) => drawChart(id, {
      type: 'bar',
      data: { labels: state.channels.map(c => c.title), datasets: [{ data, backgroundColor: state.channels.map(c => c.color), borderRadius: 8 }] },
      options: { ...chartBase(), plugins: { legend: { display: false } } },
    });
    bar('barChart1', state.channels.map(c => ps.get(c.id).views));
    bar('barChart2', state.channels.map(c => Math.round(c.avg10 || 0)));
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
    const q = $('#search').value.trim().toLowerCase(), f = $('#format').value, range = +$('#range').value;
    let sort = $('#sort').value;
    let list = state.channels.filter(c => state.sel.has(c.id)).flatMap(c => c.videos);
    if (q) list = list.filter(v => v.title.toLowerCase().includes(q));
    if (f !== 'all') list = list.filter(v => v.fmt === f);
    if (range) list = list.filter(v => v.age <= range);
    let hint = '';
    if (sort === 'trend7' && !list.some(v => v.g7 != null)) { hint = ' · Die 7-Tage-Trendwerte entstehen aus den täglichen Snapshots und erscheinen, sobald 7 Tage Daten vorliegen. Bis dahin sortiert nach Aufrufen pro Tag.'; sort = 'perday'; }
    const key = { outlier: v => v.outlier, trend7: v => v.g7 ?? -1, perday: v => v.perDay, views: v => v.views, recent: v => +new Date(v.published), engagement: v => v.eng ?? -1 }[sort];
    if (sort === 'outlier') { list = list.filter(v => v.age >= 3); hint = ' · ×-Wert = Aufrufe im Vergleich zum Median des Kanals (gleiches Format). Videos unter 3 Tagen sind ausgeblendet.'; }
    list.sort((a, b) => key(b) - key(a));

    $('#videoHint').textContent = `${list.length} Videos${hint}`;
    $('#videoList').innerHTML = list.slice(0, state.shown).map(v => {
      const th = thumbUrl(v);
      return `<div class="video" style="--c:${v.ch.color}"><a class="v-link" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener">
        <div class="thumb">${th ? `<img src="${th}" alt="" loading="lazy">` : ''}
          <span class="dur">${v.fmt === 'video' ? '' : FMT_LABEL[v.fmt] + ' · '}${dur(v.duration)}</span>
          ${v.outlier >= 1.5 && v.age >= 3 ? `<span class="badge">×${de(v.outlier, 1)}</span>` : ''}
        </div>
        <div class="v-body">
          <div class="v-title">${esc(v.title)}</div>
          <div class="v-ch">${esc(v.ch.title)}</div>
          <div class="v-meta">${fmt(v.views)} Aufrufe · ${ago(v.age)}</div>
          <div class="v-meta">${fmt(v.perDay)}/Tag${v.like != null ? ` · ${pct(v.like, 1)} Likes` : ''}${v.comments != null ? ` · ${fmt(v.comments)} Komm.` : ''}</div>
          ${v.g7 != null ? `<div class="v-meta pos">+${fmt(v.g7)} in 7 Tagen</div>` : ''}
        </div></a>${saveBtn(v.id)}</div>`;
    }).join('');
    $('#more').hidden = list.length <= state.shown;
  }

  // ---------- Wachstum ----------
  function renderGrowth() {
    const metric = $('#metric').value, P = state.period;
    const all = [...new Set(state.channels.flatMap(c => (state.history[c.id] || []).map(x => x.d)))].sort();
    const maxN = all.length ? dnum(all.at(-1)) : 0;
    const dates = all.filter(d => dnum(d) >= maxN - P);
    const rough = metric === 'subs' || metric === 'subsPct' || metric === 'subsDay' ? ' YouTube rundet Abozahlen (z. B. auf 750 Tsd.), deshalb springen Abo-Werte stufenweise.' : '';
    $('#growthHint').textContent = (all.length < 2
      ? 'Der Verlauf entsteht, weil die Seite jeden Tag einen Snapshot speichert. Ab dem zweiten Tag erscheint hier eine Kurve.'
      : `${dates.length} Tage im Zeitraum (Verlauf seit ${new Date(all[0]).toLocaleDateString('de-DE')}).`) + rough;

    const datasets = state.channels.map(c => {
      const h = state.history[c.id] || [];
      const map = new Map();
      const inWin = h.filter(x => dnum(x.d) >= maxN - P);
      const first = inWin.find(x => x.s != null)?.s;
      h.forEach((x, i) => {
        let v;
        if (metric === 'subs') v = x.s;
        else if (metric === 'views') v = x.v;
        else if (metric === 'subsPct') v = first && x.s != null ? (x.s / first - 1) * 100 : null;
        else {
          if (i === 0) return;
          const gap = dnum(x.d) - dnum(h[i - 1].d) || 1;
          v = metric === 'subsDay' ? (x.s != null && h[i - 1].s != null ? (x.s - h[i - 1].s) / gap : null) : (x.vg != null ? x.vg / Math.max((x.h ?? 24) / 24, 1 / 24) : (x.v - h[i - 1].v) / gap);
        }
        map.set(x.d, v);
      });
      return {
        label: c.title, borderColor: c.color, backgroundColor: c.color, tension: .25, borderWidth: 2.5, pointRadius: dates.length > 40 ? 0 : 3, spanGaps: true,
        data: dates.map(d => map.get(d) ?? null),
      };
    });
    const base = chartBase();
    const isPct = metric === 'subsPct';
    base.scales.y.ticks.callback = v => (isPct ? de(v, 1) + ' %' : fmt(v));
    base.scales.x.ticks.callback = function (i) { return new Date(this.getLabelForValue(i)).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }); };
    base.scales.x.ticks.maxTicksLimit = 8;
    drawChart('lineChart', {
      type: 'line', data: { labels: dates, datasets },
      options: { ...base, interaction: { mode: 'index', intersect: false }, plugins: { legend: { labels: { color: css('--text'), usePointStyle: true } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y == null ? '–' : isPct ? de(c.parsed.y, 2) + ' %' : de(c.parsed.y, Math.abs(c.parsed.y) < 100 ? 1 : 0)}` } } } },
    });

    const periods = [7, 28, 90, 365];
    const cell = (g, key, f) => (g && g[key] != null ? `<td class="${g.partial ? 'partial' : ''}" ${g.partial ? `title="Verlauf erst ${g.span} Tage"` : ''}>${f(g[key])}</td>` : '<td>–</td>');
    $('#gains').innerHTML = `<thead><tr><th></th>${periods.map(p => `<th>Aufrufe ${p} T.</th>`).join('')}${periods.map(p => `<th>Abos ${p} T.</th>`).join('')}</tr></thead><tbody>` +
      state.channels.map(c => {
        const gs = periods.map(p => histGain(c, p));
        return `<tr><td><span class="dot" style="background:${c.color}"></span>${esc(c.title)}</td>${gs.map(g => cell(g, 'views', sg)).join('')}${gs.map(g => cell(g, 'subs', sg)).join('')}</tr>`;
      }).join('') + '</tbody>';
  }

  // ---------- Content ----------
  const BUCKETS = {
    video: [[0, 300, '< 5 Min.'], [300, 600, '5–10 Min.'], [600, 1200, '10–20 Min.'], [1200, 2400, '20–40 Min.'], [2400, Infinity, '> 40 Min.']],
    short: [[0, 30, '< 30 Sek.'], [30, 45, '30–45 Sek.'], [45, 60, '45–60 Sek.'], [60, Infinity, '> 60 Sek.']],
    live: [[0, 3600, '< 1 Std.'], [3600, 7200, '1–2 Std.'], [7200, 14400, '2–4 Std.'], [14400, Infinity, '> 4 Std.']],
  };
  function renderContent() {
    const f = $('#cformat').value;
    const chs = state.channels.map(c => ({ c, vs: c.videos.filter(v => v.fmt === f) }));
    const base = chartBase();

    const times = chs.flatMap(({ vs }) => vs.map(v => +new Date(v.published)));
    const xMin = times.length ? Math.min(...times) - 7 * DAY : undefined, xMax = Date.now() + 7 * DAY;
    drawChart('scatterChart', {
      type: 'scatter',
      data: { datasets: chs.map(({ c, vs }) => ({ label: c.title, backgroundColor: c.color + 'cc', borderColor: c.color, pointRadius: 3.5, pointHoverRadius: 6, data: vs.filter(v => v.views > 0).map(v => ({ x: +new Date(v.published), y: v.views, t: v.title })) })) },
      options: {
        ...base,
        scales: {
          x: { type: 'linear', min: xMin, max: xMax, ticks: { color: css('--muted'), maxTicksLimit: 6, callback: v => new Date(v).toLocaleDateString('de-DE', { month: 'short', year: '2-digit' }) }, grid: { display: false } },
          y: { type: 'logarithmic', ticks: { color: css('--muted'), callback: v => (/^[125]/.test(String(v)) ? fmt(v) : '') }, grid: { color: css('--line') } },
        },
        plugins: { legend: { labels: { color: css('--text'), usePointStyle: true } }, tooltip: { callbacks: { label: ctx => `${ctx.raw.t} · ${fmt(ctx.raw.y)}` } } },
      },
    });

    const wd = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    drawChart('weekdayChart', {
      type: 'bar',
      data: { labels: wd, datasets: chs.map(({ c, vs }) => { const n = Array(7).fill(0); vs.forEach(v => n[(new Date(v.published).getDay() + 6) % 7]++); return { label: c.title, backgroundColor: c.color, borderRadius: 4, data: n.map(x => (vs.length ? (x / vs.length) * 100 : 0)) }; }) },
      options: { ...base, scales: { ...base.scales, y: { ...base.scales.y, ticks: { color: css('--muted'), callback: v => v + ' %' } } }, plugins: { legend: { labels: { color: css('--text'), usePointStyle: true } }, tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${de(ctx.parsed.y, 0)} % der Uploads` } } } },
    });

    const head = `<thead><tr><th></th>${state.channels.map(c => `<th><span class="dot" style="background:${c.color}"></span>${esc(c.title)}</th>`).join('')}</tr></thead>`;
    $('#lengthTable').innerHTML = head + '<tbody>' + BUCKETS[f].map(([lo, hi, label]) => {
      const cells = chs.map(({ vs }) => { const a = vs.filter(v => v.duration >= lo && v.duration < hi); return { n: a.length >= 3 ? median(a.map(v => v.views)) : null, cnt: a.length }; });
      const best = Math.max(...cells.map(x => x.n ?? -1));
      return `<tr><td>${label}</td>${cells.map(x => `<td class="${x.n != null && x.n === best && cells.length > 1 ? 'best' : ''}">${x.n != null ? `${fmt(x.n)} <small>(${x.cnt})</small>` : '–'}</td>`).join('')}</tr>`;
    }).join('') + '</tbody><tfoot></tfoot>';

    const tp = [
      ['Ø Titellänge (Zeichen)', vs => mean(vs.map(v => v.title.length)), v => de(v, 0)],
      ['Titel mit Zahl', vs => vs.filter(v => /\d/.test(v.title)).length / vs.length, v => pct(v, 0)],
      ['Titel mit Frage', vs => vs.filter(v => /\?/.test(v.title)).length / vs.length, v => pct(v, 0)],
      ['Titel mit Emoji', vs => vs.filter(v => /\p{Extended_Pictographic}/u.test(v.title)).length / vs.length, v => pct(v, 0)],
      ['Titel mit GROSSEM Wort', vs => vs.filter(v => /(^|[^\p{L}])[A-ZÄÖÜ]{3,}($|[^\p{L}])/u.test(v.title)).length / vs.length, v => pct(v, 0)],
      ['Analysierte Videos', vs => vs.length, v => de(v)],
    ];
    $('#titleTable').innerHTML = head + '<tbody>' + tp.map(([l, fn, ff]) => `<tr><td>${l}</td>${chs.map(({ vs }) => `<td>${vs.length ? ff(fn(vs)) : '–'}</td>`).join('')}</tr>`).join('') + '</tbody>';
    renderStart(f);
    renderSlots(f);
  }

  // ---------- Merkliste ----------
  const SAVE_KEY = 'ct-merkliste-v1';
  const loadSaved = () => { try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch { return {}; } };
  const persist = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(state.saved)); } catch { /* Speicher nicht verfügbar */ } };
  const STAR = on => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3.5l2.6 5.5 6 .8-4.4 4.1 1.1 5.9L12 17l-5.3 2.8 1.1-5.9-4.4-4.1 6-.8z" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  const saveLabel = on => (on ? 'Von der Merkliste entfernen' : 'Auf die Merkliste setzen');
  const saveBtn = id => { const on = !!state.saved[id]; return `<button type="button" class="save ${on ? 'on' : ''}" data-save="${esc(id)}" aria-pressed="${on}" title="${saveLabel(on)}" aria-label="${saveLabel(on)}">${STAR(on)}</button>`; };
  function toggleSave(id) {
    if (state.saved[id]) delete state.saved[id];
    else {
      const v = state.byId.get(id);
      if (!v) return;
      state.saved[id] = { id, title: v.title, ch: v.ch.title, color: v.ch.color, views: v.views, published: v.published, fmt: v.fmt, note: '', added: new Date().toISOString() };
    }
    persist();
    const on = !!state.saved[id];
    $$('[data-save]').filter(b => b.dataset.save === id).forEach(b => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); b.title = saveLabel(on); b.setAttribute('aria-label', saveLabel(on)); b.innerHTML = STAR(on); });
    if (state.tab === 'ideas') renderSaved();
  }
  function renderSaved() {
    const items = Object.values(state.saved).sort((a, b) => b.added.localeCompare(a.added));
    $('#savedCount').textContent = items.length ? `${items.length} ${items.length === 1 ? 'Video' : 'Videos'}` : '';
    $('#copySaved').disabled = $('#exportSaved').disabled = !items.length;
    $('#savedList').innerHTML = items.length ? items.map(s => {
      const live = state.byId.get(s.id);
      const url = `https://www.youtube.com/watch?v=${esc(s.id)}`;
      const x = live && live.outlier && live.age >= 3 ? ` · ×${de(live.outlier, 1)}` : '';
      return `<article class="saved" style="--c:${s.color}">
        <a class="saved-thumb" href="${url}" target="_blank" rel="noopener" tabindex="-1">${DEMO ? '' : `<img src="https://i.ytimg.com/vi/${esc(s.id)}/mqdefault.jpg" alt="" loading="lazy">`}</a>
        <div class="saved-body">
          <a class="v-title" href="${url}" target="_blank" rel="noopener">${esc(s.title)}</a>
          <div class="v-meta"><span class="v-ch">${esc(s.ch)}</span> · ${fmt(live ? live.views : s.views)} Aufrufe${x}</div>
          <textarea data-note="${esc(s.id)}" rows="2" placeholder="Was gefällt dir daran? Idee für dein Video …" aria-label="Notiz zu ${esc(s.title)}">${esc(s.note)}</textarea>
        </div>
        ${saveBtn(s.id)}
      </article>`;
    }).join('') : '<p class="muted empty-note">Markiere Videos mit dem Stern, dann landen sie hier. Zu jedem kannst du eine Notiz schreiben. Die Merkliste wird in diesem Browser gespeichert. Mit „Exportieren“ und „Importieren“ bringst du sie auf ein anderes Gerät.</p>';
  }
  function savedAsText() {
    return Object.values(state.saved).sort((a, b) => b.added.localeCompare(a.added))
      .map(s => `- [${s.title}](https://www.youtube.com/watch?v=${s.id}) – ${s.ch}${s.note.trim() ? `\n  - ${s.note.trim().replace(/\s*\n\s*/g, ' ')}` : ''}`).join('\n');
  }
  function flash(btn, text) { const old = btn.textContent; btn.textContent = text; setTimeout(() => (btn.textContent = old), 1800); }
  function initSaved() {
    state.saved = loadSaved();
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-save]');
      if (b) { e.preventDefault(); e.stopPropagation(); toggleSave(b.dataset.save); return; }
      const t = e.target.closest('[data-term]');
      if (t) { $('#search').value = t.dataset.term; $('#sort').value = 'outlier'; $('#format').value = 'all'; $('#range').value = '0'; state.shown = PAGE; showTab('videos'); renderVideos(); }
    });
    document.addEventListener('input', e => {
      const t = e.target.closest('[data-note]');
      if (t && state.saved[t.dataset.note]) { state.saved[t.dataset.note].note = t.value; persist(); }
    });
    $('#copySaved').addEventListener('click', async e => {
      const text = savedAsText(), btn = e.currentTarget;
      try { await navigator.clipboard.writeText(text); flash(btn, 'Kopiert'); }
      catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); flash(btn, 'Kopiert'); } catch { flash(btn, 'Kopieren nicht möglich'); } ta.remove(); }
    });
    $('#exportSaved').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state.saved, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'merkliste.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('#importSaved').addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        for (const [id, s] of Object.entries(data)) {
          if (!s || !s.title) continue;
          if (!state.saved[id]) state.saved[id] = { note: '', added: new Date().toISOString(), ...s, id };
          else if (!state.saved[id].note && s.note) state.saved[id].note = s.note;
        }
        persist(); renderSaved(); renderWall(); renderVideos();
      } catch { alert('Die Datei konnte nicht gelesen werden. Wähle eine merkliste.json, die du vorher exportiert hast.'); }
      e.target.value = '';
    });
  }

  // ---------- Ideen: Filter, Begriffe, Thumbnail-Wand ----------
  function ideaVideos() {
    const ch = $('#iChannel').value, f = $('#iFormat').value, r = +$('#iRange').value;
    return state.channels.filter(c => ch === 'all' || c.id === ch).flatMap(c => c.videos)
      .filter(v => (f === 'all' || v.fmt === f) && (!r || v.age <= r));
  }
  const STOP = new Set(('der die das und ich du er sie es wir ihr ein eine einen einem einer eines zu zum zur im in ins mit auf für von vom ist sind war nicht so wie was wer wo mal noch nur auch aber oder wenn dann den dem des am an als bei bis aus um über unter nach vor hat habe haben hab bin bist wird werden mein meine meinen meiner dein deine sein seine mich mir dich dir uns euch man kein keine ja nein jetzt hier da dass weil sich sehr mehr alle alles immer schon ganz wieder gegen ohne doch ' +
    'the a an and or of to in on for with is it this that i you he she we they my your his her our their me be are was were am do does did not no so but if at by from as up out about what how why who when all just can will get got have has had its it\'s i\'m im vs ft feat shorts short part teil ep episode').split(' '));
  function termsOf(title) {
    const w = (title.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) || []).map(x => x.replace(/’/g, "'"));
    const set = new Set();
    w.forEach((t, i) => {
      if (!STOP.has(t) && t.length >= 3 && !/^\d+$/.test(t)) set.add(t);
      const a = w[i - 1];
      if (a && !STOP.has(a) && !STOP.has(t) && a.length >= 2 && t.length >= 2) set.add(a + ' ' + t);
    });
    return set;
  }
  function renderTopics() {
    const vids = ideaVideos().filter(v => v.age >= 3 && v.outlier > 0);
    const byOut = [...vids].sort((a, b) => b.outlier - a.outlier);
    const topSet = new Set(byOut.slice(0, Math.max(1, Math.round(vids.length * 0.25))).map(v => v.id));
    const map = new Map();
    for (const v of vids) for (const t of termsOf(v.title)) { if (!map.has(t)) map.set(t, []); map.get(t).push(v); }
    const minN = Math.max(3, Math.round(vids.length * 0.01));
    let rows = [...map].filter(([, vs]) => vs.length >= minN).map(([t, vs]) => ({
      t, n: vs.length, med: median(vs.map(v => v.outlier)), top: vs.filter(v => topSet.has(v.id)).length / vs.length,
      chans: state.channels.filter(c => vs.some(v => v.ch === c)), best: vs.reduce((b, v) => (v.outlier > b.outlier ? v : b)),
    }));
    // Ein Wortpaar, das genauso oft vorkommt wie eines seiner Wörter, macht das Einzelwort überflüssig
    const pairs = rows.filter(r => r.t.includes(' '));
    rows = rows.filter(r => r.t.includes(' ') || !pairs.some(p => p.n === r.n && p.t.split(' ').includes(r.t)));
    const sort = $('#topicSort').value;
    rows.sort(sort === 'n' ? (a, b) => b.n - a.n || b.med - a.med : sort === 'weak' ? (a, b) => a.med - b.med : (a, b) => b.med - a.med || b.n - a.n);
    rows = rows.slice(0, 25);
    $('#topicHint').textContent = vids.length
      ? `${vids.length} Videos ausgewertet, Begriffe ab ${minN} Videos. ×-Wert 1,0 entspricht einem typischen Video des jeweiligen Kanals. „Im besten Viertel“ liegt im Schnitt bei 25 %, alles darüber spricht für den Begriff. Klick auf einen Begriff zeigt die Videos dazu.`
      : 'Für diese Auswahl gibt es noch keine Videos, die älter als 3 Tage sind.';
    $('#topicTable').innerHTML = rows.length ? `<thead><tr><th>Begriff</th><th>Videos</th><th>Median ×-Wert</th><th>Im besten Viertel</th><th>Kanäle</th><th>Bestes Video</th></tr></thead><tbody>` + rows.map(r => `<tr>
        <td><button type="button" class="term" data-term="${esc(r.t)}">${esc(r.t)}</button></td>
        <td>${de(r.n)}</td>
        <td class="${r.med >= 1.3 ? 'best' : r.med < 0.8 ? 'weak' : ''}">×${de(r.med, 2)}</td>
        <td class="${r.top >= 0.4 ? 'best' : r.top < 0.15 ? 'weak' : ''}">${pct(r.top, 0)}</td>
        <td class="dots">${r.chans.map(c => `<span class="dot" style="background:${c.color};color:${c.color}" title="${esc(c.title)}"></span>`).join('')}<span class="sr">${esc(r.chans.map(c => c.title).join(', '))}</span></td>
        <td class="best-video"><a href="https://www.youtube.com/watch?v=${esc(r.best.id)}" target="_blank" rel="noopener" title="${esc(r.best.title)}">×${de(r.best.outlier, 1)} · ${esc(r.best.title)}</a></td>
      </tr>`).join('') + '</tbody>' : '';
  }
  function renderWall() {
    const sort = $('#wallSort').value;
    let list = ideaVideos();
    if (sort === 'outlier') list = list.filter(v => v.age >= 3);
    const key = { outlier: v => v.outlier, views: v => v.views, recent: v => +new Date(v.published) }[sort];
    list.sort((a, b) => key(b) - key(a));
    $('#wall').innerHTML = list.slice(0, state.wallShown).map(v => `<div class="tile" style="--c:${v.ch.color}">
        <a href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener">
          <div class="tile-img">${DEMO ? '' : `<img src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg" alt="" loading="lazy">`}
            ${v.outlier && v.age >= 3 ? `<span class="badge">×${de(v.outlier, 1)}</span>` : ''}
            <span class="dur">${v.fmt === 'video' ? '' : FMT_LABEL[v.fmt] + ' · '}${dur(v.duration)}</span>
          </div>
          <div class="tile-cap">${esc(v.title)}</div>
          <div class="tile-meta"><span class="v-ch">${esc(v.ch.title)}</span> · ${fmt(v.views)} Aufrufe · ${ago(v.age)}</div>
        </a>${saveBtn(v.id)}</div>`).join('') || '<p class="muted">Keine Videos für diese Auswahl.</p>';
    $('#wallMore').hidden = list.length <= state.wallShown;
  }
  function renderIdeas() { renderSaved(); renderTopics(); renderWall(); }
  function initIdeas() {
    const opts = '<option value="all">Alle Kanäle</option>' + state.channels.map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');
    $('#iChannel').innerHTML = opts; $('#slotChannel').innerHTML = opts;
    ['iChannel', 'iFormat', 'iRange'].forEach(id => $('#' + id).addEventListener('change', () => { state.wallShown = 24; renderTopics(); renderWall(); }));
    $('#topicSort').addEventListener('change', renderTopics);
    $('#wallSort').addEventListener('change', () => { state.wallShown = 24; renderWall(); });
    $('#wallMore').addEventListener('click', () => { state.wallShown += 24; renderWall(); });
    $('#slotChannel').addEventListener('change', () => renderSlots($('#cformat').value));
  }

  // ---------- Content: Start neuer Videos ----------
  const STARTS = [['e1', 24, '24 Std.'], ['e3', 72, '3 Tage'], ['e7', 168, '7 Tage']];
  function renderStart(f) {
    const anyData = state.channels.some(c => c.videos.some(v => v.fmt === f && v.e1 != null));
    const lines = state.channels.map(c => ({ c, vals: STARTS.map(([k]) => c.early[f][k]) }));
    const hasCurve = lines.some(l => l.vals.some(x => x != null));
    $('#startHint').textContent = anyData
      ? 'Median-Aufrufe der Videos nach 24 Stunden, 3 und 7 Tagen (ab 3 Videos pro Kanal). In der Tabelle zeigt der ×-Wert, wie ein neues Video im Vergleich zu diesem Kanal-Median startet.'
      : 'Die Start-Werte entstehen aus den täglichen Snapshots. Sie erscheinen für Videos, die seit dem 10.11. veröffentlicht wurden: nach 24 Stunden der erste Wert, nach 7 Tagen alle drei. Für die Kanal-Kurve braucht es mindestens 3 solcher Videos pro Kanal.';
    $('#startBox').hidden = !hasCurve;
    if (hasCurve) {
      drawChart('startChart', {
        type: 'line',
        data: { labels: STARTS.map(s => s[2]), datasets: lines.map(({ c, vals }) => ({ label: c.title, data: vals, borderColor: c.color, backgroundColor: c.color, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, tension: .2, spanGaps: true })) },
        options: { ...chartBase(), interaction: { mode: 'index', intersect: false }, plugins: { legend: { labels: { color: css('--text'), usePointStyle: true } }, tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y == null ? '–' : fmt(ctx.parsed.y)}` } } } },
      });
    }
    const recent = state.channels.flatMap(c => c.videos).filter(v => v.fmt === f && v.age <= 21).sort((a, b) => a.age - b.age).slice(0, 15);
    $('#startWrap').hidden = !recent.length;
    $('#startTable').innerHTML = `<thead><tr><th>Neue Videos</th>${STARTS.map(s => `<th>${s[2]}</th>`).join('')}</tr></thead><tbody>` + recent.map(v => {
      const cells = STARTS.map(([k, h]) => {
        if (v[k] == null) return `<td class="muted" title="${v.age * 24 < h ? 'Das Video ist noch jünger' : 'Zu diesem Zeitpunkt gab es noch keinen Snapshot'}">${v.age * 24 < h ? '…' : '–'}</td>`;
        const m = v.ch.early[f][k], r = m ? v[k] / m : null;
        return `<td>${fmt(v[k])}${r != null ? ` <small class="${r >= 1.3 ? 'good' : r < 0.7 ? 'weak' : ''}">×${de(r, 1)}</small>` : ''}</td>`;
      }).join('');
      return `<tr><td><span class="dot" style="background:${v.ch.color};color:${v.ch.color}"></span><a class="tt" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener" title="${esc(v.ch.title)}: ${esc(v.title)}">${esc(v.title)}</a></td>${cells}</tr>`;
    }).join('') + '</tbody>';
  }

  // ---------- Content: Upload-Zeitpunkt ----------
  const SLOT_DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  function renderSlots(f) {
    const ch = $('#slotChannel').value;
    const vids = state.channels.filter(c => ch === 'all' || c.id === ch).flatMap(c => c.videos).filter(v => v.fmt === f && v.age >= 3 && v.outlier > 0);
    const grid = SLOT_DAYS.map(() => Array.from({ length: 8 }, () => []));
    vids.forEach(v => grid[v.wd][Math.floor(v.hr / 3)].push(v.outlier));
    $('#slotTable').innerHTML = `<thead><tr><th></th>${Array.from({ length: 8 }, (_, i) => `<th>${i * 3}–${i * 3 + 3}</th>`).join('')}</tr></thead><tbody>` + grid.map((row, d) => `<tr><td>${SLOT_DAYS[d]}</td>${row.map((xs, i) => {
      const slot = `${SLOT_DAYS[d]} ${i * 3}–${i * 3 + 3} Uhr`;
      if (!xs.length) return `<td class="cell empty" title="${slot}: keine Uploads"></td>`;
      if (xs.length < 2) return `<td class="cell few" title="${slot}: 1 Video, zu wenig für eine Aussage"><small>1</small></td>`;
      const m = median(xs), a = Math.max(0.08, Math.min(0.9, (m - 0.4) / 1.8));
      return `<td class="cell" style="background:rgba(94,160,255,${a.toFixed(2)});color:${a > 0.5 ? '#050a1e' : 'var(--text)'}" title="${slot}: ${xs.length} Videos, Median ×${de(m, 2)}">×${de(m, 1)}<small>${xs.length}</small></td>`;
    }).join('')}</tr>`).join('') + '</tbody>';
    $('#slotHint').textContent = vids.length ? `${vids.length} Videos ausgewertet, Uhrzeiten in deutscher Zeit.` : 'Für diese Auswahl gibt es keine Videos, die älter als 3 Tage sind.';
  }


  load();
})();
