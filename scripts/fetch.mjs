// Holt Daten der Kanäle aus channels.json über die YouTube Data API v3
// und schreibt docs/data/latest.json, history.json und video-history.json.
// Benötigt: Node 18+ und die Umgebungsvariable YOUTUBE_API_KEY.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'docs', 'data');
const KEY = process.env.YOUTUBE_API_KEY;
const API = 'https://www.googleapis.com/youtube/v3';
const DAY = 86400000;
const VIDEO_HISTORY_DAYS = 40; // so lange werden Video-Snapshots für Trend-Zahlen (7/28 Tage) aufbewahrt

if (!KEY) {
  console.error('Fehler: YOUTUBE_API_KEY ist nicht gesetzt.');
  process.exit(1);
}

async function yt(endpoint, params) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key: KEY })) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const readJson = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
};

// PT1H2M3S -> Sekunden
function parseDuration(iso = '') {
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const [d, h, mi, s] = [m[1], m[2], m[3], m[4]].map(x => Number(x || 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

async function resolveChannel(ref) {
  const params = { part: 'snippet,statistics,contentDetails' };
  if (ref.startsWith('@')) params.forHandle = ref;
  else params.id = ref;
  const data = await yt('channels', params);
  const ch = data.items?.[0];
  if (!ch) throw new Error(`Kanal nicht gefunden: ${ref}`);
  return ch;
}

// Holt Videos neueste zuerst, bis das Zeitfenster (horizonDays) abgedeckt ist oder maxVideos erreicht sind.
async function fetchVideos(uploadsId, maxVideos, horizonDays) {
  const cutoff = Date.now() - horizonDays * DAY;
  const ids = [];
  let pageToken;
  outer: while (ids.length < maxVideos) {
    const page = await yt('playlistItems', {
      part: 'contentDetails', playlistId: uploadsId, maxResults: 50, ...(pageToken && { pageToken }),
    });
    for (const item of page.items) {
      const pub = item.contentDetails.videoPublishedAt;
      if (pub && new Date(pub).getTime() < cutoff) break outer;
      ids.push(item.contentDetails.videoId);
      if (ids.length >= maxVideos) break outer;
    }
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await yt('videos', { part: 'snippet,statistics,contentDetails,liveStreamingDetails', id: ids.slice(i, i + 50).join(',') });
    for (const v of data.items) {
      const duration = parseDuration(v.contentDetails.duration);
      // Format: Livestream (auch als Aufzeichnung) > Short (bis 3 Min.) > Video
      const fmt = v.liveStreamingDetails ? 'live' : duration > 0 && duration <= 180 ? 'short' : 'video';
      videos.push({
        id: v.id,
        title: v.snippet.title,
        published: v.snippet.publishedAt,
        views: Number(v.statistics.viewCount ?? 0),
        likes: v.statistics.likeCount != null ? Number(v.statistics.likeCount) : null,
        comments: v.statistics.commentCount != null ? Number(v.statistics.commentCount) : null,
        duration,
        fmt,
      });
    }
  }
  return videos.sort((a, b) => b.published.localeCompare(a.published));
}

// Hängt den heutigen Snapshot an und berechnet Aufrufe-Zuwachs der letzten 1/7/28 Tage pro Video.
function applyVideoTrends(videos, vh, today) {
  for (const v of videos) {
    const arr = (vh[v.id] ??= []);
    const last = arr.at(-1);
    if (last && last[0] === today) last[1] = v.views; else arr.push([today, v.views]);
    for (const w of [1, 7, 28]) {
      // Snapshot, der mindestens w Tage alt ist (bis 3 Tage Toleranz, falls ein Lauf ausgefallen ist)
      const base = [...arr].reverse().find(([d]) => d <= today - w && d >= today - w - 3);
      if (base) v[`g${w}`] = v.views - base[1];
    }
  }
}

async function main() {
  const config = await readJson(path.join(ROOT, 'channels.json'), { channels: [] });
  const maxVideos = config.maxVideosPerChannel ?? 500;
  const horizonDays = config.historyDays ?? 400;
  const old = await readJson(path.join(DATA, 'latest.json'), { channels: [] });
  const history = await readJson(path.join(DATA, 'history.json'), {});
  const vh = await readJson(path.join(DATA, 'video-history.json'), {});
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const todayNum = Math.floor(now.getTime() / DAY);

  const channels = [];
  for (const ref of config.channels) {
    try {
      const ch = await resolveChannel(ref);
      const videos = await fetchVideos(ch.contentDetails.relatedPlaylists.uploads, maxVideos, horizonDays);
      applyVideoTrends(videos, vh, todayNum);
      const stats = ch.statistics;
      const entry = {
        id: ch.id,
        ref,
        title: ch.snippet.title,
        handle: ch.snippet.customUrl || ref,
        thumb: ch.snippet.thumbnails?.medium?.url || ch.snippet.thumbnails?.default?.url || '',
        created: ch.snippet.publishedAt,
        country: ch.snippet.country || null,
        subs: stats.hiddenSubscriberCount ? null : Number(stats.subscriberCount),
        views: Number(stats.viewCount),
        videoCount: Number(stats.videoCount),
        videos,
      };
      channels.push(entry);
      const series = (history[ch.id] ??= []);
      // YouTube aktualisiert die Gesamtaufrufe eines Kanals nur unregelmäßig. Deshalb wird der Aufrufe-Zuwachs
      // zusätzlich aus den einzelnen Videos berechnet (vg) und die echte Zeit seit dem letzten Snapshot gespeichert (h, Stunden).
      const prev = [...series].reverse().find(x => x.d !== today);
      const snap = { d: today, t: now.toISOString(), s: entry.subs, v: entry.views, n: entry.videoCount };
      if (prev) {
        const prevT = prev.t ? Date.parse(prev.t) : Date.parse(prev.d + 'T05:00:00Z');
        let vg = 0;
        for (const v of videos) {
          if (v.g1 != null) vg += v.g1;
          else if (Date.parse(v.published) > prevT && (vh[v.id] || []).every(([d]) => d === todayNum)) vg += v.views; // seitdem neu erschienen
        }
        snap.vg = vg;
        snap.h = Math.round(((now.getTime() - prevT) / 3600000) * 10) / 10;
      }
      const idx = series.findIndex(x => x.d === today);
      if (idx >= 0) series[idx] = snap; else series.push(snap);
      console.log(`✓ ${entry.title}: ${videos.length} Videos`);
    } catch (err) {
      console.error(`✗ ${ref}: ${err.message}`);
      const previous = old.channels?.find(c => c.ref === ref);
      if (previous) channels.push(previous); // alten Stand behalten
    }
  }

  if (!channels.length) {
    console.error('Keine Kanaldaten erhalten – bestehende Dateien bleiben unverändert.');
    process.exit(1);
  }

  // Alte Video-Snapshots aufräumen
  for (const id of Object.keys(vh)) {
    vh[id] = vh[id].filter(([d]) => d >= todayNum - VIDEO_HISTORY_DAYS);
    if (!vh[id].length) delete vh[id];
  }

  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(path.join(DATA, 'latest.json'), JSON.stringify({ updated: now.toISOString(), channels }));
  await fs.writeFile(path.join(DATA, 'history.json'), JSON.stringify(history));
  await fs.writeFile(path.join(DATA, 'video-history.json'), JSON.stringify(vh));
  console.log(`Fertig: ${channels.length} Kanäle.`);
}

main().catch(err => { console.error(err); process.exit(1); });
