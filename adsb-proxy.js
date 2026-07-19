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
const UPSTREAM = process.env.ADSB_UPSTREAM || "https://api.airplanes.live/v2/point";
const CACHE_MS = 4000;         // serve cached result for 4s (respects rate limits)
const MAX_RADIUS_NM = 250;     // upstream hard cap

const cache = new Map();       // key -> { t, data }
const inflight = new Map();    // key -> Promise  (coalesce concurrent identical calls)

// Normalize the ADS-B Exchange v2 aircraft objects into a clean, stable schema.
function normalize(upstream) {
  const list = Array.isArray(upstream && upstream.ac) ? upstream.ac : [];
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
  return { source: "airplanes.live", updated: new Date().toISOString(), count: aircraft.length, aircraft };
}

async function fetchAircraft(lat, lon, radius) {
  const key = `${lat.toFixed(2)}:${lon.toFixed(2)}:${radius}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.data;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const url = `${UPSTREAM}/${lat}/${lon}/${radius}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "streetwatch-adsb-proxy/1.0" },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const data = normalize(await res.json());
    cache.set(key, { t: Date.now(), data });
    return data;
  })();

  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
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

module.exports = { normalize, fetchAircraft, createServer, handler };
