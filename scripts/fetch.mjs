// Holt Daten der Kanäle aus channels.json über die YouTube Data API v3
// und schreibt docs/data/latest.json + docs/data/history.json.
// Benötigt: Node 18+ und die Umgebungsvariable YOUTUBE_API_KEY.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'docs', 'data');
const KEY = process.env.YOUTUBE_API_KEY;
const API = 'https://www.googleapis.com/youtube/v3';

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
  const [, d = 0, h = 0, mi = 0, s = 0] = m.map(x => (x === undefined ? 0 : Number(x)));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

const bestThumb = t => t?.maxres?.url || t?.standard?.url || t?.high?.url || t?.medium?.url || t?.default?.url || '';

async function resolveChannel(ref) {
  const params = { part: 'snippet,statistics,contentDetails' };
  if (ref.startsWith('@')) params.forHandle = ref;
  else params.id = ref;
  const data = await yt('channels', params);
  const ch = data.items?.[0];
  if (!ch) throw new Error(`Kanal nicht gefunden: ${ref}`);
  return ch;
}

async function fetchVideos(uploadsId, limit) {
  const ids = [];
  let pageToken;
  while (ids.length < limit) {
    const page = await yt('playlistItems', {
      part: 'contentDetails', playlistId: uploadsId,
      maxResults: Math.min(50, limit - ids.length), ...(pageToken && { pageToken }),
    });
    ids.push(...page.items.map(i => i.contentDetails.videoId));
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await yt('videos', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(',') });
    for (const v of data.items) {
      const duration = parseDuration(v.contentDetails.duration);
      videos.push({
        id: v.id,
        title: v.snippet.title,
        published: v.snippet.publishedAt,
        views: Number(v.statistics.viewCount ?? 0),
        likes: v.statistics.likeCount != null ? Number(v.statistics.likeCount) : null,
        comments: v.statistics.commentCount != null ? Number(v.statistics.commentCount) : null,
        duration,
        isShort: duration > 0 && duration <= 180,
        thumb: bestThumb(v.snippet.thumbnails),
      });
    }
  }
  return videos.sort((a, b) => b.published.localeCompare(a.published));
}

async function main() {
  const config = await readJson(path.join(ROOT, 'channels.json'), { channels: [] });
  const limit = config.videosPerChannel ?? 50;
  const old = await readJson(path.join(DATA, 'latest.json'), { channels: [] });
  const history = await readJson(path.join(DATA, 'history.json'), {});
  const today = new Date().toISOString().slice(0, 10);

  const channels = [];
  for (const ref of config.channels) {
    try {
      const ch = await resolveChannel(ref);
      const videos = await fetchVideos(ch.contentDetails.relatedPlaylists.uploads, limit);
      const stats = ch.statistics;
      const entry = {
        id: ch.id,
        ref,
        title: ch.snippet.title,
        handle: ch.snippet.customUrl || ref,
        thumb: ch.snippet.thumbnails?.medium?.url || ch.snippet.thumbnails?.default?.url || '',
        subs: stats.hiddenSubscriberCount ? null : Number(stats.subscriberCount),
        views: Number(stats.viewCount),
        videoCount: Number(stats.videoCount),
        videos,
      };
      channels.push(entry);
      const series = (history[ch.id] ??= []);
      const snap = { d: today, s: entry.subs, v: entry.views, n: entry.videoCount };
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

  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(path.join(DATA, 'latest.json'), JSON.stringify({ updated: new Date().toISOString(), channels }));
  await fs.writeFile(path.join(DATA, 'history.json'), JSON.stringify(history));
  console.log(`Fertig: ${channels.length} Kanäle.`);
}

main().catch(err => { console.error(err); process.exit(1); });
