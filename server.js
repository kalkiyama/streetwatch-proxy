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
const webcams = require("./webcams-proxy.js");
const ai = require("./claude-proxy.js");
const geometry = require("./geometry.js");

// site name -> centre, used wherever a distance-from-site has to be computed
function siteCoordMap() {
  const m = {};
  (droneSweep.SITES || []).forEach((x) => { m[x[0]] = { lat: x[2], lon: x[3] }; });
  return m;
}

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

  // Operational visibility. Without this, "are we near the upstream limit" is guesswork.
  // Exposes counters only — no user data, no coordinates, no keys.
  if (p === "/metrics") {
    const a = adsb.stats || {};
    const mem = process.memoryUsage();
    return send(res, 200, {
      uptimeSec: Math.round(process.uptime()),
      memoryMB: { rss: +(mem.rss / 1048576).toFixed(1), heapUsed: +(mem.heapUsed / 1048576).toFixed(1) },
      aircraft: {
        requests: a.requests || 0,
        cacheHits: a.cacheHits || 0,
        staleServed: a.staleServed || 0,
        coalesced: a.coalesced || 0,
        cacheHitRatio: a.requests ? +(((a.cacheHits + a.staleServed + a.coalesced) / a.requests)).toFixed(3) : null,
        upstreamCalls: a.upstreamCalls || 0,
        upstreamErrors: a.upstreamErrors || 0,
        upstreamCallsLastMin: adsb.upstreamRate ? adsb.upstreamRate() : null,
        upstreamAvgMs: a.upstreamCalls ? Math.round(a.upstreamMsTotal / a.upstreamCalls) : null,
        upstreamRecentAvgMs: a.recentMs && a.recentMs.length
          ? Math.round(a.recentMs.reduce((x, y) => x + y, 0) / a.recentMs.length) : null,
      },
      sweep: droneSweep.getDrones ? (() => { const s = droneSweep.getDrones(60).sweep;
        return { sites: s.sites, passSize: s.passSize, hotSites: s.hotSites, cycles: s.cycles, errors: s.errors }; })() : null,
      archive: archive.stats ? "use /api/drones/archive-stats" : null,
    }, origin);
  }

  // ---- AI endpoints -------------------------------------------------------
  // Every one of these computes the facts first and asks Claude only for English.
  // Responses always carry the computed data alongside the prose so a reader can
  // check the words against the numbers.

  if (p === "/api/ai/status") return send(res, 200, ai.status(), origin);

  if (p === "/api/ai/track") {
    const u = new URL(req.url, "http://localhost");
    const icao = String(u.searchParams.get("icao") || "").slice(0, 12);
    if (!icao) return send(res, 400, { error: "icao required" }, origin);
    const t = await archive.track(icao, Number(u.searchParams.get("days") || 90));
    if (!t || !t.points || t.points.length < 3) {
      return send(res, 200, { icao, geometry: null, narrative: null,
        note: "Not enough recorded positions to describe a flight profile." }, origin);
    }
    const geo = geometry.analyse(t.points.map((x) => ({ lat: x.lat, lon: x.lon, ts: x.ts, altFt: x.alt_ft })));
    const r = await ai.narrateTrack({ geo, contact: t.contact });
    return send(res, 200, {
      icao, contact: t.contact,
      geometry: geo,                                  // the measured facts
      narrative: r.ok ? r.text : null,                // the model's English
      narrativeStatus: r.ok ? (r.cached ? "cached" : "generated") : r.reason,
      disclosure: "Flight profile measured from recorded ADS-B positions. The written summary is an AI-generated interpretation of those measurements; the measurements themselves are shown above and were computed, not inferred.",
    }, origin);
  }

  if (p === "/api/ai/search") {
    const u = new URL(req.url, "http://localhost");
    const q = String(u.searchParams.get("q") || "").slice(0, 400);
    if (!q) return send(res, 400, { error: "q required" }, origin);
    const r = await ai.parseSearch(q);
    return send(res, 200, r.ok
      ? { query: q, filter: r.filter, cached: !!r.cached,
          disclosure: "Your words were interpreted into the filter shown; the results themselves come from the catalogue and archive, not from a language model." }
      : { query: q, filter: null, error: r.reason }, origin);
  }

  if (p === "/api/ai/digest") {
    const u = new URL(req.url, "http://localhost");
    const days = Math.min(Math.max(Number(u.searchParams.get("days") || 7), 1), 90);
    // Pass site coordinates so the archive can compute a tight-radius count alongside the
    // 250nm sweep figure — without them, a regional count gets reported as a base count.
    const data = await archive.digestData({ days, siteCoords: siteCoordMap() });
    if (!data) return send(res, 200, { error: "archive_unavailable" }, origin);
    const r = await ai.writeDigest(data);
    return send(res, 200, {
      ...data,
      briefing: r.ok ? r.text : null,
      briefingStatus: r.ok ? (r.cached ? "cached" : "generated") : r.reason,
      disclosure: "Counts computed from StreetWatch's public archive of ADS-B observations. The briefing is an AI-generated summary of those counts. Aircraft flying with transponders off are not represented, and a change in counts can reflect changes in observation as much as changes in activity.",
    }, origin);
  }

  if (p === "/api/ai/correlations") {
    const u = new URL(req.url, "http://localhost");
    const days = Math.min(Math.max(Number(u.searchParams.get("days") || 7), 1), 30);
    // Co-occurrence is COMPUTED here: air activity per airspace vs current marine
    // contacts of interest, paired by great-circle distance.
    // Every one of these can be unavailable — no database configured, AIS provider down.
    // A correlation endpoint that throws on a missing input is worse than one that says
    // plainly it has nothing to correlate.
    const heat = await archive.heat({ days , siteCoords: siteCoordMap() }).catch(() => null);
    if (!heat) return send(res, 200, { windowDays: days, pairs: [], count: 0, summary: null,
      error: "archive_unavailable",
      disclosure: "Correlation requires the archive, which is not available on this instance." }, origin);
    const subs = await ais.getSubSupportFleet().catch(() => ({ vessels: [] }));
    const usvs = await ais.getUsvFleet().catch(() => ({ vessels: [] }));
    const marine = [
      ...(subs.vessels || []).map((v) => ({ ...v, kind: "submarine support vessel" })),
      ...(usvs.vessels || []).map((v) => ({ ...v, kind: "sea drone" })),
    ];
    const SITES = droneSweep.SITES;
    const pairs = [];
    const heatSites = Array.isArray(heat) ? heat : (heat.sites || []);
    heatSites.forEach((h) => {
      const site = SITES.find((x) => x[0] === h.site);
      if (!site) return;
      marine.forEach((v) => {
        if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return;
        const dNm = Math.hypot((site[2] - v.lat) * 60,
          (site[3] - v.lon) * 60 * Math.cos(site[2] * Math.PI / 180));
        if (dNm <= 150) pairs.push({ site: h.site, airContacts: h.contacts,
          vessel: v.name || v.id, vesselKind: v.kind, distanceNm: Math.round(dNm), daysApart: 0 });
      });
    });
    pairs.sort((a, b) => a.distanceNm - b.distanceNm);
    const top = pairs.slice(0, 6);
    const r = top.length ? await ai.describeCorrelations({ windowDays: days, pairs: top }) : { ok: false, reason: "no_pairs" };
    return send(res, 200, {
      windowDays: days, pairs: top, count: pairs.length,
      summary: r.ok ? r.text : null,
      summaryStatus: r.ok ? (r.cached ? "cached" : "generated") : r.reason,
      disclosure: "Co-occurrences in time and space only, computed from two independent public datasets. No causal link is implied or observable. Both datasets are incomplete: aircraft with transponders off and vessels outside AIS coverage do not appear.",
    }, origin);
  }

  if (p === "/api/webcams") {
    const u = new URL(req.url, "http://localhost");
    return send(res, 200, await webcams.getWebcams(
      Number(u.searchParams.get("lat")),
      Number(u.searchParams.get("lon")),
      Number(u.searchParams.get("radius") || 50),
      Number(u.searchParams.get("limit") || 12),
      Number(u.searchParams.get("offset") || 0)), origin);
  }

  if (p === "/api/usv") {
    const u = new URL(req.url, "http://localhost");
    const lat = Number(u.searchParams.get("lat"));
    const lon = Number(u.searchParams.get("lon"));
    return send(res, 200, await ais.getUsvFleet(lat, lon), origin);
  }

  if (p === "/api/drones/heat") {
    const u = new URL(req.url, "http://localhost");
    const rows = await archive.heat({ days: u.searchParams.get("days"), siteCoords: siteCoordMap() });
    if (!rows) return send(res, 503, { error: "archive_disabled" }, origin);
    const sites = Object.fromEntries(droneSweep.SITES.map((x) => [x[0], { lat: x[2], lon: x[3] }]));
    const out = rows
      .filter((r) => sites[r.site])
      .map((r) => ({ ...r, lat: sites[r.site].lat, lon: sites[r.site].lon }));
    const max = out.reduce((m, r) => Math.max(m, r.contacts), 0) || 1;
    return send(res, 200, {
      windowDays: Number(u.searchParams.get("days")) || 7,
      maxContacts: max,
      // maxima per radius so the client can scale colour correctly at whichever it displays
      maxByRadius: {
        25: Math.max(1, ...out.map((r) => r.c25 || 0)),
        100: Math.max(1, ...out.map((r) => r.c100 || 0)),
        250: max,
      },
      radiiNm: [25, 100, 250],
      note: "Intensity reflects ADS-B broadcasters observed by this sweep. Aircraft flying with transponders off are not counted.",
      count: out.length,
      // Radius metadata travels with the data so no surface can display a regional count
      // as if it were a base count. maxContacts lets the client scale colour logarithmically.
      sweepRadiusNm: 250,
      nearRadiusNm: 25,
      maxContacts: max,
      // maxima per radius so the client can scale colour correctly at whichever it displays
      maxByRadius: {
        25: Math.max(1, ...out.map((r) => r.c25 || 0)),
        100: Math.max(1, ...out.map((r) => r.c100 || 0)),
        250: max,
      },
      radiiNm: [25, 100, 250],
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
  ais.startProviders();      // aisstream (WS) / hybrid (Kystverket TCP) / digitraffic (pull, no-op)
  createServer().listen(PORT, () => console.log(`StreetWatch proxy on :${PORT} — origins=${ORIGINS.join(",")} limit=${LIMIT}/min`));

  // Seed the sweep's adaptive tiers from the archive BEFORE starting, so a redeploy does not
  // demote every productive airspace back to the slowest rotation. Starting the sweep is not
  // gated on this succeeding — worst case it begins cold, exactly as it used to.
  // Order matters: the archive must be connected before tiers can be seeded from it.
  // droneSweep.start() also calls archive.init(), which is idempotent.
  archive.init()
    .catch((e) => console.warn("[boot] archive init failed:", e.message))
    .then(() => droneSweep.seedTiersFromArchive(archive))
    .catch((e) => console.warn("[boot] tier seed failed:", e.message))
    .finally(() => droneSweep.start());
}
module.exports = { createServer };
