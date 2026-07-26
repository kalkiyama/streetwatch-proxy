// adsb-proxy.js
// Zero-dependency live ADS-B proxy for the StreetWatch aviation layer.
// Node >= 18 (uses built-in fetch + http). No API key required.
//
//   node adsb-proxy.js
//   GET /api/aircraft?lat=51.47&lon=-0.45&radius=75   -> normalized live aircraft
//   GET /health                                        -> { ok: true }
//
// Env:
//   PORT           default 8787
//   ALLOW_ORIGIN   default "*"  (set to your app origin in production)
//   ADSB_UPSTREAM  default airplanes.live point endpoint
//
// Why a proxy: the browser cannot call the ADS-B API directly (CORS), and the
// upstream is rate-limited (~1 req/s). This server centralizes + caches calls,
// normalizes the ADS-B Exchange v2 schema into a clean shape, and adds CORS.

const http = require("http");

const PORT = process.env.PORT || 8787;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
// UPSTREAM RESILIENCE. One ADS-B source was the single point of failure for the entire aviation
// half of the product: if it rate-limits or goes down, the live map, the 1,108-airspace sweep and
// the archive all stop at once. These are community feeds that can and do change.
//
// Each entry carries its own URL TEMPLATE because the providers do not share a URL shape — only
// the response shape (all are readsb-derived, so normalize() handles them). A source whose payload
// normalize() cannot read is treated as a failure and we fall through, rather than serving nothing.
//
// Override with ADSB_UPSTREAMS as a comma-separated list of name|template pairs. The legacy
// ADSB_UPSTREAM (singular) still works and is used as the first entry if set.
const DEFAULT_UPSTREAMS = [
  { name: "airplanes.live", tpl: "https://api.airplanes.live/v2/point/{lat}/{lon}/{radius}" },
  { name: "adsb.lol",       tpl: "https://api.adsb.lol/v2/point/{lat}/{lon}/{radius}" },
  { name: "adsb.fi",        tpl: "https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{radius}" },
];

function parseUpstreams() {
  const raw = process.env.ADSB_UPSTREAMS;
  if (raw) {
    const list = raw.split(",").map((part) => {
      const [name, tpl] = part.split("|").map((x) => x && x.trim());
      return name && tpl ? { name, tpl } : null;
    }).filter(Boolean);
    if (list.length) return list;
  }
  const legacy = process.env.ADSB_UPSTREAM;
  if (legacy) {
    return [{ name: "configured", tpl: `${legacy}/{lat}/{lon}/{radius}` }, ...DEFAULT_UPSTREAMS];
  }
  return DEFAULT_UPSTREAMS;
}

const UPSTREAMS = parseUpstreams();
const UPSTREAM = UPSTREAMS[0].tpl;                       // kept for the startup log line
// 5s, not 8s. The upstream normally answers in ~570ms, so anything past a few seconds is already
// pathological and the caller is better served by failing over than by waiting. This same path
// serves both the background sweep and user-facing radar requests, so the budget has to suit the
// impatient one.
const UPSTREAM_TIMEOUT_MS = Number(process.env.ADSB_TIMEOUT_MS || 5000);
// Fresh window raised 4s -> 20s. The binding constraint is airplanes.live's ~1 req/s
// guidance: at 4s each distinct viewed airport cost 0.25 req/s (only ~4 concurrent
// airports before exceeding it); at 20s it is 0.05 req/s (~20 airports). Aircraft move
// ~2nm in 20s — imperceptible at 60-250nm radar scale.
const CACHE_MS = Number(process.env.ADSB_CACHE_MS || 20000);
// Stale-while-revalidate: past CACHE_MS but within STALE_MS, serve the old data
// immediately and refresh in the background. Users never wait on upstream unless the
// entry is truly dead. Staleness is bounded at 60s and marked on the payload.
const STALE_MS = Number(process.env.ADSB_STALE_MS || 60000);
const MAX_RADIUS_NM = 250;     // upstream hard cap

const cache = new Map();       // key -> { t, data }
const inflight = new Map();    // key -> Promise  (coalesce concurrent identical calls)

// Normalize the ADS-B Exchange v2 aircraft objects into a clean, stable schema.
// The providers carry the same readsb payload under DIFFERENT KEYS: airplanes.live and adsb.lol
// use `ac`, adsb.fi uses `aircraft`. Verified against all three live endpoints — the adsb.fi URL
// was right all along; only the key differed. One helper knows this so the validator and the
// parser can never disagree about what a usable payload looks like.
function contactList(payload) {
  if (!payload) return null;
  if (Array.isArray(payload.ac)) return payload.ac;
  if (Array.isArray(payload.aircraft)) return payload.aircraft;
  return null;
}

function normalize(upstream) {
  const list = contactList(upstream) || [];
  const aircraft = list
    .filter((a) => typeof a.lat === "number" && typeof a.lon === "number")
    .map((a) => {
      const onGround = a.alt_baro === "ground";
      const heading =
        typeof a.track === "number" ? a.track
        : typeof a.true_heading === "number" ? a.true_heading
        : null;
      return {
        id: String(a.hex || "").trim(),
        callsign: String(a.flight || "").trim() || null,
        registration: String(a.r || "").trim() || null,
        typeCode: String(a.t || "").trim() || null,
        lat: a.lat,
        lon: a.lon,
        altFt: onGround ? 0 : (typeof a.alt_baro === "number" ? a.alt_baro : null),
        onGround,
        groundSpeedKt: typeof a.gs === "number" ? Math.round(a.gs) : null,
        headingDeg: heading,
        verticalRateFpm: typeof a.baro_rate === "number" ? a.baro_rate : null,
        squawk: a.squawk || null,
        category: a.category || null,            // ADS-B emitter category (A1 light … B6 UAV)
        isDrone: a.category === "B6",            // B6 = unmanned aerial vehicle
        desc: String(a.desc || "").trim() || null,        // e.g. "BOEING 737-800"
        operator: String(a.ownOp || "").trim() || null,   // owner / operator
        year: a.year ? String(a.year) : null,
        military: Number.isFinite(a.dbFlags) ? Boolean(a.dbFlags & 1) : null, // dbFlags bit 0 = military
        emergency: a.emergency && a.emergency !== "none" ? String(a.emergency) : null,
        seenPosSec: typeof a.seen_pos === "number" ? a.seen_pos : null,
      };
    });
  // `source` is overwritten by the caller with whichever upstream actually answered.
  return { source: null, updated: new Date().toISOString(), count: aircraft.length, aircraft };
}

// metrics, exported for /metrics
const stats = {
  requests: 0, cacheHits: 0, staleServed: 0, coalesced: 0,
  upstreamCalls: 0, upstreamErrors: 0, upstreamMsTotal: 0,
  // Which source actually served each response. A silent failover changes COVERAGE — a different
  // receiver network sees different aircraft — so "nothing visible here" means something different
  // depending on who answered. That has to be visible, not hidden.
  bySource: {}, activeSource: null, failovers: 0,
  upstreamWindow: [],           // timestamps of the last minute of upstream calls
  recentMs: [],                 // durations of the last 20 calls — a cumulative average
                                // hides recovery after cold-start (4s TLS handshakes kept
                                // the lifetime avg looking bad long after calls got fast)
};

function upstreamRate() {
  const cutoff = Date.now() - 60000;
  stats.upstreamWindow = stats.upstreamWindow.filter((t) => t > cutoff);
  return stats.upstreamWindow.length;
}

function refresh(key, lat, lon, radius) {
  const p = (async () => {
    const t0 = Date.now();
    stats.upstreamCalls++;
    stats.upstreamWindow.push(t0);
    let lastErr = null;
    try {
      for (let i = 0; i < UPSTREAMS.length; i++) {
        const src = UPSTREAMS[i];
        const url = src.tpl
          .replace("{lat}", lat).replace("{lon}", lon).replace("{radius}", radius);
        // Without a timeout a hung upstream hangs the request forever and the fallback never runs,
        // which would make this whole list decorative.
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
        try {
          const res = await fetch(url, {
            signal: ctl.signal,
            headers: { Accept: "application/json", "User-Agent": "streetwatch-adsb-proxy/1.0" },
          });
          if (!res.ok) throw new Error(`${src.name} ${res.status}`);
          const payload = await res.json();
          // A 200 that parses as JSON is NOT success. adsb.fi returns 200 with a different shape
          // and no `ac` array, which normalize() would quietly turn into "zero aircraft" — worse
          // than an error, because empty reads as "nothing is there" rather than "this source is
          // broken". That is the absence-is-not-evidence failure arriving through the back door.
          // Require the shape we actually consume, or fall through to the next source.
          if (!contactList(payload)) {
            throw new Error(`${src.name} unexpected payload shape (no ac[]/aircraft[])`);
          }
          const data = normalize(payload);
          data.source = src.name;
          const b = stats.bySource[src.name] || (stats.bySource[src.name] = { ok: 0, err: 0 });
          b.ok++;
          if (stats.activeSource && stats.activeSource !== src.name) stats.failovers++;
          stats.activeSource = src.name;
          cache.set(key, { t: Date.now(), data });
          return data;
        } catch (e) {
          lastErr = e;
          const b = stats.bySource[src.name] || (stats.bySource[src.name] = { ok: 0, err: 0 });
          b.err++;
          // fall through to the next source
        } finally {
          clearTimeout(timer);
        }
      }
      stats.upstreamErrors++;
      throw lastErr || new Error("all upstreams failed");
    } finally {
      const ms = Date.now() - t0;
      stats.upstreamMsTotal += ms;
      stats.recentMs.push(ms);
      if (stats.recentMs.length > 20) stats.recentMs.shift();
    }
  })();
  inflight.set(key, p);
  p.finally(() => inflight.delete(key)).catch(() => {});
  return p;
}

async function fetchAircraft(lat, lon, radius) {
  const key = `${lat.toFixed(2)}:${lon.toFixed(2)}:${radius}`;
  stats.requests++;
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.t : Infinity;

  if (age < CACHE_MS) { stats.cacheHits++; return hit.data; }        // fresh

  if (age < STALE_MS) {
    // stale-but-usable: serve now, refresh in the background
    stats.staleServed++;
    if (!inflight.has(key)) refresh(key, lat, lon, radius);
    return { ...hit.data, stale: true, ageSec: Math.round(age / 1000) };
  }

  if (inflight.has(key)) { stats.coalesced++; return inflight.get(key); }
  return refresh(key, lat, lon, radius);
}

function send(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const u = new URL(req.url, "http://localhost");

  if (u.pathname === "/health") return send(res, 200, { ok: true, ts: Date.now() });

  if (u.pathname === "/api/aircraft") {
    const lat = parseFloat(u.searchParams.get("lat"));
    const lon = parseFloat(u.searchParams.get("lon"));
    let radius = parseInt(u.searchParams.get("radius") || "50", 10);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180)
      return send(res, 400, { error: "lat and lon required (lat -90..90, lon -180..180)" });
    if (!Number.isFinite(radius) || radius < 1) radius = 50;
    radius = Math.min(radius, MAX_RADIUS_NM);
    try {
      const data = await fetchAircraft(lat, lon, radius);
      return send(res, 200, { query: { lat, lon, radius }, ...data });
    } catch (e) {
      return send(res, 502, { error: "upstream_unavailable", detail: String((e && e.message) || e) });
    }
  }

  return send(res, 404, { error: "not_found" });
}

function createServer() { return http.createServer(handler); }

if (require.main === module) {
  createServer().listen(PORT, () => console.log(`ADS-B proxy on :${PORT} -> ${UPSTREAM}`));
}

module.exports = { stats, upstreamRate, normalize, contactList, fetchAircraft, createServer, handler };
