// StreetWatch — Windy Webcams proxy.
//
// Why this lives on the server: the Windy API key must never reach the browser. The
// frontend asks StreetWatch for webcams near a point; StreetWatch asks Windy.
//
// Two constraints shape the caching:
//   1. Free-tier image URLs are signed with tokens that EXPIRE AFTER 10 MINUTES. Cache a
//      response for longer than that and we hand the user dead image links, so the TTL
//      here is deliberately short (5 min) rather than the hours a static catalogue allows.
//   2. Free tier serves low-resolution images only. That is a limitation to state, not to
//      paper over.
//
// Windy webcams are PUBLIC, operator-published cameras — the same category StreetWatch
// already carries. Nothing private, nothing unlisted.

const KEY = process.env.WINDY_KEY || "";
const BASE = "https://api.windy.com/webcams/api/v3/webcams";
const TTL_MS = 5 * 60 * 1000;          // must stay under the 10-min image token lifetime
const MAX_LIMIT = 50;                   // Windy's own per-request ceiling

const cache = new Map();                // key -> { at, payload }

function cacheKey(lat, lon, radiusKm, limit, offset) {
  // round to ~1km so nearby requests share an entry without smearing results
  return `${lat.toFixed(2)}:${lon.toFixed(2)}:${radiusKm}:${limit}:${offset}`;
}

function normalise(w) {
  const loc = w.location || {};
  const img = (w.images && w.images.current) || {};
  const player = w.player || {};
  return {
    id: String(w.webcamId ?? w.id ?? ""),
    title: w.title || null,
    status: w.status || null,                     // "active" | "inactive"
    lastUpdate: w.lastUpdatedOn || null,
    city: loc.city || null,
    region: loc.region || null,
    country: loc.country || null,
    lat: typeof loc.latitude === "number" ? loc.latitude : null,
    lon: typeof loc.longitude === "number" ? loc.longitude : null,
    thumb: img.thumbnail || img.preview || null,
    preview: img.preview || img.thumbnail || null,
    // Windy's own players. "live" exists only for streaming cams; "day" is the timelapse.
    live: player.live || null,
    day: player.day || null,
  };
}

// `offset` exists so the caller can page through the full set. A location like Heathrow has
// 851 cameras within 50km — capping at the first 12 with no way forward was a decision made
// for panel speed that quietly became a ceiling on what the user could see.
async function getWebcams(lat, lon, radiusKm = 50, limit = 12, offset = 0) {
  if (!KEY) {
    return {
      configured: false, count: 0, webcams: [],
      note: "Windy webcams are not configured on this instance (no WINDY_KEY set).",
    };
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { configured: true, error: "lat and lon required", count: 0, webcams: [] };
  }
  const r = Math.min(Math.max(Number(radiusKm) || 50, 1), 250);
  const n = Math.min(Math.max(Number(limit) || 12, 1), MAX_LIMIT);
  const off = Math.min(Math.max(Number(offset) || 0, 0), 2000);   // Windy paginates; stay sane

  const ck = cacheKey(lat, lon, r, n, off);
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.payload, cached: true };

  // `nearby` already returns results by proximity. An explicit sortKey=distance is NOT a
  // valid value and made Windy reject the whole request with HTTP 400.
  const url = `${BASE}?nearby=${lat.toFixed(4)},${lon.toFixed(4)},${r}` +
    `&limit=${n}&offset=${off}&include=images,location,player`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { "x-windy-api-key": KEY, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Surface the reason rather than an empty list that implies "no cameras here".
      // Include Windy's own message: discarding it once turned a one-line parameter bug
      // into guesswork, since "HTTP 400" alone says nothing about WHICH parameter.
      let upstream = "";
      try { upstream = (await res.text()).slice(0, 300); } catch { /* body already consumed */ }
      const detail = res.status === 401 ? "Windy rejected the API key"
        : res.status === 429 ? "Windy rate limit reached"
        : `Windy returned HTTP ${res.status}`;
      return { configured: true, error: detail, upstreamDetail: upstream || null, count: 0, webcams: [] };
    }
    const json = await res.json();
    const list = Array.isArray(json.webcams) ? json.webcams : [];
    const payload = {
      configured: true,
      source: "Windy Webcams",
      note: "Public operator-published webcams. Free tier serves low-resolution images; links expire after ~10 minutes and are refreshed on each request.",
      total: json.total ?? list.length,
      count: list.length,
      webcams: list.map(normalise).filter((w) => w.id),
    };
    cache.set(ck, { at: Date.now(), payload });
    // keep the cache small — this is a tiny service
    if (cache.size > 200) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
    return payload;
  } catch (e) {
    return {
      configured: true,
      error: e.name === "AbortError" ? "Windy request timed out" : "Windy unreachable",
      count: 0, webcams: [],
    };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { getWebcams, normalise, _cache: cache };
