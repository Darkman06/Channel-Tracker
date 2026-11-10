// Erzeugt erfundene Demo-Daten in docs/demo/ (Ansicht: <seite>/?demo)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'demo');
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const between = (a, b) => a + rnd() * (b - a);

const TOPICS = [
  'Ich habe 24 Stunden {x} getestet', 'Warum {x} alles verändert', 'Das hat niemand erwartet: {x}',
  '{x} im großen Vergleich', 'Ich habe {x} gebaut', 'Die Wahrheit über {x}', '{x} – Das musst du wissen',
  'Ich teste {x} für 30 Tage', 'So funktioniert {x} wirklich', 'Top 10 {x} 2026',
];
const THINGS = ['das Setup', 'KI-Tools', 'Gaming-Mäuse', 'Mikrofone', 'Streaming', 'Kameras', 'Schnitt-Workflows', 'Thumbnails', 'Retro-Konsolen', 'Smart Home'];

const channelDefs = [
  { id: 'UCdemo1', title: 'Pixel Pioneer', handle: '@pixelpioneer', subs: 1_240_000, perVid: 480_000, perWeek: 2 },
  { id: 'UCdemo2', title: 'Lena Live', handle: '@lenalive', subs: 312_000, perVid: 95_000, perWeek: 4 },
  { id: 'UCdemo3', title: 'Tech mit Tom', handle: '@techmittom', subs: 780_000, perVid: 210_000, perWeek: 1.5 },
];

const now = Date.now();
const channels = [];
const history = {};

for (const def of channelDefs) {
  const videos = [];
  let t = now - between(0.2, 1) * 86400000;
  for (let i = 0; i < 50; i++) {
    const isShort = rnd() < 0.3;
    const age = (now - t) / 86400000;
    const base = def.perVid * (isShort ? 0.6 : 1) * Math.exp((rnd() - 0.5) * 1.6) * (rnd() < 0.08 ? 4 : 1);
    const views = Math.round(base * Math.min(1, 0.25 + age / 12));
    const title = TOPICS[Math.floor(rnd() * TOPICS.length)].replace('{x}', THINGS[Math.floor(rnd() * THINGS.length)]);
    videos.push({
      id: `${def.id}-${i}`, title, published: new Date(t).toISOString(), views,
      likes: Math.round(views * between(0.02, 0.07)), comments: Math.round(views * between(0.001, 0.006)),
      duration: isShort ? Math.round(between(20, 58)) : Math.round(between(420, 1500)), isShort, thumb: '',
    });
    t -= (7 / def.perWeek) * 86400000 * between(0.4, 1.6);
  }
  const totalViews = def.subs * 140;
  channels.push({ id: def.id, ref: def.handle, title: def.title, handle: def.handle, thumb: '', subs: def.subs, views: totalViews, videoCount: 180, videos });

  // 45 Tage Verlauf, rückwärts gerechnet
  const series = [];
  let s = def.subs, v = totalViews;
  const growth = between(0.0006, 0.002);
  for (let d = 0; d < 45; d++) {
    series.unshift({ d: new Date(now - d * 86400000).toISOString().slice(0, 10), s: Math.round(s), v: Math.round(v), n: 180 - Math.floor(d / 4) });
    s /= 1 + growth * between(0.5, 1.5);
    v -= def.perVid * 0.4 * between(0.5, 1.5);
  }
  history[def.id] = series;
}

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'latest.json'), JSON.stringify({ updated: new Date().toISOString(), demo: true, channels }));
await fs.writeFile(path.join(OUT, 'history.json'), JSON.stringify(history));
console.log('Demo-Daten geschrieben:', OUT);
