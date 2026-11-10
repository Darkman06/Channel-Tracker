// Sternenhimmel: Sterne, feine Sternbild-Linien und ein paar funkelnde Sterne.
(() => {
  const cv = document.getElementById('sky');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  let seed = 11;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  let lastW = 0, lastH = 0;

  function draw() {
    const w = innerWidth, h = innerHeight, dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed = 11;

    // Sterne
    const n = Math.round((w * h) / 2800);
    for (let i = 0; i < n; i++) {
      const x = rnd() * w, y = rnd() * h, r = rnd() ** 3 * 1.2 + 0.25;
      ctx.globalAlpha = 0.25 + rnd() * 0.65;
      ctx.fillStyle = rnd() < 0.16 ? '#bcd0ff' : '#ffffff';
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
    }

    // Sternbilder: kleine Gruppen heller Punkte, mit den nächsten Nachbarn verbunden
    const groups = Math.max(4, Math.round((w * h) / 120000));
    for (let g = 0; g < groups; g++) {
      const cx = rnd() * w, cy = rnd() * h, k = 5 + Math.floor(rnd() * 4), spread = 70 + rnd() * 70;
      const pts = Array.from({ length: k }, () => ({ x: cx + (rnd() - 0.5) * spread * 2.2, y: cy + (rnd() - 0.5) * spread * 1.4 }));
      const seen = new Set();
      ctx.strokeStyle = 'rgba(190, 215, 255, .30)'; ctx.lineWidth = 1; ctx.globalAlpha = 1;
      pts.forEach((p, i) => {
        pts.map((q, j) => ({ j, d: Math.hypot(p.x - q.x, p.y - q.y) })).filter(o => o.j !== i).sort((a, b) => a.d - b.d).slice(0, 2).forEach(o => {
          const key = i < o.j ? i + '-' + o.j : o.j + '-' + i;
          if (seen.has(key)) return; seen.add(key);
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(pts[o.j].x, pts[o.j].y); ctx.stroke();
        });
      });
      ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(170, 205, 255, .95)'; ctx.shadowBlur = 8;
      pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 1.7, 0, 6.2832); ctx.fill(); });
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
    lastW = w; lastH = h;
  }

  // Funkelnde Sterne (CSS-Animation, ruhig und wenige)
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 10; i++) {
    const s = document.createElement('span');
    s.className = 'glint';
    s.style.cssText = `left:${(rnd() * 96 + 2).toFixed(1)}vw;top:${(rnd() * 90 + 4).toFixed(1)}vh;--s:${Math.round(12 + rnd() * 16)}px;--d:${(2.5 + rnd() * 3).toFixed(1)}s;--delay:-${(rnd() * 5).toFixed(1)}s`;
    host.appendChild(s);
  }
  document.body.appendChild(host);

  draw();
  let t;
  addEventListener('resize', () => {
    clearTimeout(t);
    // Mobil ändert sich die Höhe beim Scrollen (Adressleiste): nur bei echter Größenänderung neu zeichnen
    t = setTimeout(() => { if (Math.abs(innerWidth - lastW) > 40 || Math.abs(innerHeight - lastH) > 160) draw(); }, 200);
  });
})();
