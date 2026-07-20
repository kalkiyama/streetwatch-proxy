// server.js — StreetWatch combined proxy (hardened).
// One service, both radars: /api/aircraft (ADS-B) + /api/vessels (AIS).
// Node >= 20.  Run: node server.js
//
// Security features:
//   - Per-IP rate limiting            (env RATE_LIMIT, default 120 req/min)
//   - Origin allow-listing for CORS   (env ALLOW_ORIGIN, comma-separated)
//   - Strict input validation + radius clamp
//
// Point BOTH frontend URLs at this one service:
//   const BACKEND_URL     = "https://your-service.onrender.com";
//   const AIS_BACKEND_URL = "https://your-service.onrender.com";

const http = require("http");
const adsb = require("./adsb-proxy.js");
const ais = require("./ais-proxy.js");
const droneSweep = require("./drone-sweep.js");
const archive = require("./archive.js");

const PORT = process.env.PORT || 8080;
const ORIGINS = (process.env.ALLOW_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean);
const WINDOW_MS = 60000;
const LIMIT = parseInt(process.env.RATE_LIMIT || "120", 10); // requests per IP per minute
const MAX_RADIUS = 250;

// ---- per-IP rate limiter (fixed window, in-memory) ----
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let e = hits.get(ip);
  if (!e || e.reset < now) {
    // Bound memory: if the table is saturated (spoofed-IP flood), drop expired
    // entries first; if still full, fail closed for unknown IPs this window.
    if (hits.size >= MAX_TRACKED_IPS) {
      for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      if (hits.size >= MAX_TRACKED_IPS) return true;
    }
    e = { count: 0, reset: now + WINDOW_MS }; hits.set(ip, e);
  }
  e.count++;
  return e.count > LIMIT;
}
const sweep = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, WINDOW_MS);
if (sweep.unref) sweep.unref();
const MAX_TRACKED_IPS = 20000; // hard cap: prevents memory exhaustion via IP-spoofed floods
const clientIp = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";

// ---- CORS: echo only allow-listed origins (or * if configured) ----
function corsHeaders(origin) {
  const h = { "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "600" };
  if (ORIGINS.includes("*")) h["Access-Control-Allow-Origin"] = "*";
  else if (origin && ORIGINS.includes(origin)) { h["Access-Control-Allow-Origin"] = origin; h["Vary"] = "Origin"; }
  return h;
}
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",           // no MIME sniffing
  "X-Frame-Options": "DENY",                      // no framing this API
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-site",
  "Strict-Transport-Security": "max-age=31536000", // HTTPS only
};
function send(res, status, obj, origin) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...corsHeaders(origin) });
  res.end(JSON.stringify(obj));
}

async function handler(req, res) {
  const origin = req.headers.origin;
  if (req.method === "OPTIONS") return send(res, 204, {}, origin);
  const p = new URL(req.url, "http://localhost").pathname;
  if (p === "/health") return send(res, 200, { ok: true, services: ["aircraft", "vessels", "drones"], ts: Date.now() }, origin);

  // Rate-limit every /api/* route (health stays free for uptime pings).
  if (p.startsWith("/api/") && rateLimited(clientIp(req)))
    return send(res, 429, { error: "rate_limited", retryAfterSec: 60 }, origin);

  if (p === "/api/drones") {
    const u = new URL(req.url, "http://localhost");
    let mins = parseInt(u.searchParams.get("mins") || "15", 10);
    if (!Number.isFinite(mins) || mins < 1) mins = 15;
    mins = Math.min(mins, 24 * 60);
    return send(res, 200, droneSweep.getDrones(mins * 60000), origin);
  }

  if (p === "/api/drones/track") {
    const u = new URL(req.url, "http://localhost");
    const id = (u.searchParams.get("id") || "").replace(/[^0-9a-fA-F]/g, "").slice(0, 12);
    if (!id) return send(res, 400, { error: "id required" }, origin);
    const live = droneSweep.getTrack(id);
    if (live) return send(res, 200, { ...live, source: "live" }, origin);
    const rows = await archive.track(id);                 // fall back to the durable record
    if (rows && rows.length)
      return send(res, 200, { id, source: "archive", track: rows.map((r) => [r.lat, r.lon, +new Date(r.ts)]), points: rows }, origin);
    return send(res, 404, { error: "unknown_contact" }, origin);
  }

  if (p === "/api/drones/history") {
    const u = new URL(req.url, "http://localhost");
    const kind = u.searchParams.get("kind");
    const rows = await archive.history({
      days: u.searchParams.get("days"),
      kind: kind === "uav" || kind === "military" ? kind : null,
      limit: u.searchParams.get("limit"),
    });
    if (!rows) return send(res, 503, { error: "archive_disabled", detail: "No archive configured on this instance." }, origin);
    return send(res, 200, { source: "StreetWatch archive", retainDays: archive.RETAIN_DAYS, count: rows.length, contacts: rows }, origin);
  }

  if (p === "/api/subsupport") {
    const u = new URL(req.url, "http://localhost");
    return send(res, 200, await ais.getSubSupportFleet(
      Number(u.searchParams.get("lat")), Number(u.searchParams.get("lon"))), origin);
  }

  if (p === "/api/usv") {
    const u = new URL(req.url, "http://localhost");
    const lat = Number(u.searchParams.get("lat"));
    const lon = Number(u.searchParams.get("lon"));
    return send(res, 200, await ais.getUsvFleet(lat, lon), origin);
  }

  if (p === "/api/drones/heat") {
    const u = new URL(req.url, "http://localhost");
    const rows = await archive.heat({ days: u.searchParams.get("days") });
    if (!rows) return send(res, 503, { error: "archive_disabled" }, origin);
    const sites = Object.fromEntries(droneSweep.SITES.map((x) => [x[0], { lat: x[2], lon: x[3] }]));
    const out = rows
      .filter((r) => sites[r.site])
      .map((r) => ({ ...r, lat: sites[r.site].lat, lon: sites[r.site].lon }));
    const max = out.reduce((m, r) => Math.max(m, r.contacts), 0) || 1;
    return send(res, 200, {
      windowDays: Number(u.searchParams.get("days")) || 7,
      maxContacts: max,
      note: "Intensity reflects ADS-B broadcasters observed by this sweep. Aircraft flying with transponders off are not counted.",
      count: out.length,
      sites: out.map((r) => ({ ...r, intensity: Number((r.contacts / max).toFixed(3)) })),
    }, origin);
  }

  if (p === "/api/archive/stats") return send(res, 200, await archive.stats(), origin);

  if (p === "/api/aircraft" || p === "/api/vessels") {
    const u = new URL(req.url, "http://localhost");
    const lat = parseFloat(u.searchParams.get("lat"));
    const lon = parseFloat(u.searchParams.get("lon"));
    let radius = parseInt(u.searchParams.get("radius") || "50", 10);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180)
      return send(res, 400, { error: "lat and lon required (lat -90..90, lon -180..180)" }, origin);
    if (!Number.isFinite(radius) || radius < 1) radius = 50;
    radius = Math.min(radius, MAX_RADIUS);
    try {
      const data = p === "/api/aircraft" ? await adsb.fetchAircraft(lat, lon, radius) : await ais.getVessels(lat, lon, radius);
      return send(res, 200, { query: { lat, lon, radius }, ...data }, origin);
    } catch (e) {
      console.error("[proxy] upstream error:", (e && e.message) || e); // logged, not exposed
      return send(res, 502, { error: "upstream_unavailable" }, origin);
    }
  }
  return send(res, 404, { error: "not_found", routes: ["/api/aircraft", "/api/vessels", "/api/drones", "/api/drones/track", "/health"] }, origin);
}

function createServer() { return http.createServer(handler); }

if (require.main === module) {
  if ((process.env.AIS_PROVIDER || "digitraffic") === "aisstream") ais.startAisstream();
  createServer().listen(PORT, () => console.log(`StreetWatch proxy on :${PORT} — origins=${ORIGINS.join(",")} limit=${LIMIT}/min`));
droneSweep.start();
}
module.exports = { createServer };
