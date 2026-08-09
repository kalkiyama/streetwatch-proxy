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
const airfields = require("./airfields.js");
const archive = require("./archive.js");
const webcams = require("./webcams-proxy.js");
const cyber = require("./cyber-proxy.js");
const ai = require("./claude-proxy.js");
const geometry = require("./geometry.js");
const advisories = require("./airspace-advisories.js");

// Escalating per-IP gate for /api/ai/* (passcode-lock pattern):
//   phase 0  normal        — up to 8 fresh generations per rolling 10 minutes
//   phase 1  hold          — 9th within the window: everything AI waits 5 minutes
//   phase 2  cache-only    — after the hold, until 24h from the breach OR next UTC midnight,
//                            whichever comes first, this address gets previously generated
//                            analyses (cache) but no NEW model calls
// The computed figures (SQL) are never gated — only the language-model call is. Cache hits
// cost nothing, so an address in phase 2 still has a fully working, honest app.
// Daily unique-visitor estimate for /metrics. Privacy design: the raw IP is hashed with a
// salt that ROTATES at UTC midnight and is never persisted, so yesterday's hashes cannot be
// linked to today's and no stored value can be reversed to an address. This yields a COUNT,
// not a log. Honest caveat carried in /metrics itself: NAT and mobile churn make any IP-based
// figure approximate.
const crypto = require("crypto");
let uniqDay = "";
let uniqSalt = "";
let uniqSet = new Set();
function noteVisitor(ip) {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== uniqDay) { uniqDay = day; uniqSalt = crypto.randomBytes(16).toString("hex"); uniqSet = new Set(); }
  if (uniqSet.size < 200000) {
    uniqSet.add(crypto.createHash("sha256").update(uniqSalt + ip).digest("base64").slice(0, 12));
  }
}

const AI_WIN_MS = 10 * 60 * 1000;
const AI_MAX = 8;
const AI_HOLD_MS = 5 * 60 * 1000;
const AI_DAY_MS = 24 * 60 * 60 * 1000;
const aiIp = new Map();   // ip -> { hits: [], holdUntil: 0, cacheOnlyUntil: 0 }

function nextUtcMidnight(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function aiGate(ip) {
  const now = Date.now();
  let st = aiIp.get(ip) || { hits: [], holdUntil: 0, cacheOnlyUntil: 0 };
  st.hits = st.hits.filter((t) => now - t < AI_WIN_MS);

  if (now < st.holdUntil) {
    aiIp.set(ip, st);
    return { mode: "hold", waitSec: Math.ceil((st.holdUntil - now) / 1000) };
  }
  if (now < st.cacheOnlyUntil) {
    aiIp.set(ip, st);
    return { mode: "cacheOnly", untilIso: new Date(st.cacheOnlyUntil).toISOString() };
  }
  if (st.hits.length >= AI_MAX) {
    st.holdUntil = now + AI_HOLD_MS;
    st.cacheOnlyUntil = Math.min(now + AI_DAY_MS, nextUtcMidnight(now));
    aiIp.set(ip, st);
    return { mode: "hold", waitSec: Math.ceil(AI_HOLD_MS / 1000) };
  }
  st.hits.push(now);
  aiIp.set(ip, st);
  if (aiIp.size > 5000) {
    for (const [k, v] of aiIp)
      if (now > v.cacheOnlyUntil && now > v.holdUntil && (!v.hits.length || now - v.hits[v.hits.length - 1] > AI_WIN_MS)) aiIp.delete(k);
  }
  return { mode: "ok" };
}

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

  if (p === "/api/drones/operations") {
    const u = new URL(req.url, "http://localhost");
    const site = u.searchParams.get("site");
    const days = u.searchParams.get("days");
    const rows = await archive.operations({ site, days, limit: u.searchParams.get("limit") });
    if (!rows) return send(res, 503, { error: "archive_disabled", detail: "No archive configured on this instance." }, origin);
    const summary = site ? await archive.operationsSummary({ site, days }) : null;
    // With no site, return the RANKING rather than a flat event list — the panel shows which bases
    // are busiest first, and the reader drills into one.
    const ranked = site ? null : await archive.operationsRanked({ days, limit: 20 });
    const run = await archive.opsLastRun();
    // WHEN THE DATA ACTUALLY ENDS, which is not now. An arrival is confirmed only once the
    // observation clock has run 4h past it and the site has been polled again — up to 40h on the
    // cold tier. So "last 7 days" is a QUERY window, not a coverage window, and the client needs
    // both to say something true.
    const fresh = await archive.operationsFreshness();
    return send(res, 200, {
      source: "StreetWatch archive",
      // SCOPE, in the payload, because the number is smaller than a reader expects and the reason
      // matters: local circuit training never leaves the radius, so those flights never end a
      // track here and are not counted. Whiting Field shows ~11 a week against hundreds of real
      // daily movements. Unlabelled, that reads as a broken tool rather than a different question.
      measures: "arrivals from and departures to elsewhere — not total movements",
      basis: "inferred from where tracks end and begin, never an observed landing",
      lastComputed: run ? run.ran_at : null,
      confirmedThrough: fresh ? fresh.newest : null,
      recordedSince: fresh ? fresh.oldest : null,
      lag: "operations are retrospective — an event is confirmed only after the site has been polled again, typically about a day",
      site: site || null,
      summary,
      sites: ranked,
      count: rows.length,
      operations: rows,
    }, origin);
  }

  if (p === "/api/drones/history") {
    const u = new URL(req.url, "http://localhost");
    const kind = u.searchParams.get("kind");
    const rows = await archive.history({
      days: u.searchParams.get("days"),
      kind: kind === "uav" || kind === "military" ? kind : null,
      limit: u.searchParams.get("limit"),
      // Search by aircraft identity — ICAO hex or callsign. The app's search box has only ever
      // searched the FEED CATALOG, so a callsign from the drone list matched nothing.
      q: u.searchParams.get("q"),
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
      uniqueApiVisitorsToday: uniqSet.size,
      uniqueVisitorsNote: "distinct IPs hitting the API today, salted-hash counted, salt rotates at UTC midnight, raw IPs never stored; NAT and mobile churn make this approximate",
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
        // Which upstream is actually answering, and how often we have had to switch. A silent
        // failover changes coverage — a different receiver network sees different aircraft — so
        // it must be observable rather than invisible.
        activeSource: a.activeSource || null,
        failovers: a.failovers || 0,
        bySource: a.bySource || {},
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

  // AI endpoints get their own per-IP budget on top of the global rate limit. The global
  // limit protects the process; this protects the model budget — the daily cap is 500 calls,
  // which a page of users (or one scripted clicker) could exhaust in minutes. Identical
  // requests are served from cache upstream and do not consume model calls, so this only
  // bites genuinely new generations.
  {
    const fwd0 = req.headers["x-forwarded-for"];
    noteVisitor((typeof fwd0 === "string" && fwd0.split(",")[0].trim()) || req.socket.remoteAddress || "?");
  }

  let aiOpts = {};
  if (p.startsWith("/api/ai/") && p !== "/api/ai/status") {
    const fwd = req.headers["x-forwarded-for"];
    const ip = (typeof fwd === "string" && fwd.split(",")[0].trim()) || req.socket.remoteAddress || "?";
    const gate = aiGate(ip);
    if (gate.mode === "hold") {
      return send(res, 429, {
        error: "rate_limited",
        note: `You have generated several analyses in a short time. AI generation is paused for ${Math.ceil(gate.waitSec / 60)} minute(s) for your address. Computed figures remain available everywhere.`,
      }, origin);
    }
    if (gate.mode === "cacheOnly") {
      aiOpts = { cacheOnly: true, cacheOnlyUntil: gate.untilIso };
    }
  }

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
    const r = await ai.narrateTrack({ geo, contact: t.contact }, aiOpts);
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
    const r = await ai.parseSearch(q, aiOpts);
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
    const r = await ai.writeDigest(data, aiOpts);
    return send(res, 200, {
      ...data,
      briefing: r.ok ? r.text : null,
      briefingStatus: r.ok ? (r.cached ? "cached" : "generated") : r.reason,
      note: !r.ok && r.reason === "cache_only"
        ? `AI generation is paused for your address until ${aiOpts.cacheOnlyUntil} (heavy recent use). Previously generated analyses and all computed figures remain available.`
        : undefined,
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
    const r = top.length ? await ai.describeCorrelations({ windowDays: days, pairs: top }, aiOpts) : { ok: false, reason: "no_pairs" };
    return send(res, 200, {
      windowDays: days, pairs: top, count: pairs.length,
      summary: r.ok ? r.text : null,
      summaryStatus: r.ok ? (r.cached ? "cached" : "generated") : r.reason,
      note: !r.ok && r.reason === "cache_only"
        ? `AI generation is paused for your address until ${aiOpts.cacheOnlyUntil} (heavy recent use). Computed pairs above are unaffected.`
        : undefined,
      disclosure: "Co-occurrences in time and space only, computed from two independent public datasets. No causal link is implied or observable. Both datasets are incomplete: aircraft with transponders off and vessels outside AIS coverage do not appear.",
    }, origin);
  }

  // CYBER — three sources, and each response carries WHAT ITS NUMBERS MEAN rather than leaving the
  // client to imply something stronger. See cyber-proxy.js for why that matters: an unlabelled arc
  // between two countries is the one thing every competitor's map gets wrong.
  if (p === "/api/cyber/flows" || p === "/api/cyber/outages" || p === "/api/cyber/kev") {
    const u = new URL(req.url, "http://localhost");
    // KEV needs no key — it is US government public domain — so only the Cloudflare routes are
    // gated. Returning 503 with a REASON beats an opaque error: a missing token is a deployment
    // fact, not a fault the caller can fix by retrying.
    if (p !== "/api/cyber/kev" && !cyber.configured())
      return send(res, 503, { error: "not_configured", detail: "CF_RADAR_TOKEN not set on this instance." }, origin);
    try {
      if (p === "/api/cyber/flows")
        return send(res, 200, await cyber.flows(Math.min(Number(u.searchParams.get("limit")) || 12, 50)), origin);
      if (p === "/api/cyber/outages")
        return send(res, 200, await cyber.outages(
          Math.min(Number(u.searchParams.get("days")) || 7, 90),
          Math.min(Number(u.searchParams.get("limit")) || 20, 50)), origin);
      return send(res, 200, await cyber.kev(Math.min(Number(u.searchParams.get("limit")) || 25, 100)), origin);
    } catch (e) {
      // The cache serves stale on upstream failure; reaching here means there was nothing cached
      // either. Say which source failed rather than a bare 502.
      return send(res, 502, { error: "upstream_unavailable", source: p.split("/").pop(), detail: e.message }, origin);
    }
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

  if (p === "/api/drones/multistop") {
    // Each route parses its own URL — `u` is block-scoped per handler branch, not shared.
    const u = new URL(req.url, "http://localhost");
    const days = Number(u.searchParams.get("days") || 7);
    const minStops = Number(u.searchParams.get("stops") || 2);
    try {
      const distNm = Number(u.searchParams.get("nm") || 10);
      const altFt = Number(u.searchParams.get("alt") || 4000);
      return send(res, 200, await archive.multiStop(days, minStops, 40, distNm, altFt), origin);
    } catch (e) {
      return send(res, 500, { error: "multistop_failed", detail: String(e && e.message || e) }, origin);
    }
  }

  if (p === "/api/airspace/advisories") {
    return send(res, 200, advisories.list(), origin);
  }

  if (p === "/api/drones/coverage") {
    const u = new URL(req.url, "http://localhost");
    const rows = await archive.coverage({
      days: u.searchParams.get("days"),
      cell: u.searchParams.get("cell"),
    });
    if (!rows) return send(res, 200, { error: "archive_unavailable" }, origin);
    return send(res, 200, {
      count: rows.length,
      cells: rows,
      maxPoints: rows.reduce((m, r) => Math.max(m, r.points), 1),
      note: "Where StreetWatch has actually recorded contacts. An empty area means no ADS-B reception, no monitored airspace nearby, or no traffic — this data cannot distinguish between them. Derived from observations only; nothing is modelled or predicted.",
    }, origin);
  }

  if (p === "/api/drones/heat") {
    const u = new URL(req.url, "http://localhost");
    const rows = await archive.heat({ days: u.searchParams.get("days"), siteCoords: siteCoordMap() });
    if (!rows) return send(res, 503, { error: "archive_disabled" }, origin);
    const sites = Object.fromEntries(droneSweep.SITES.map((x) => [x[0], { lat: x[2], lon: x[3] }]));
    const out = rows
      .filter((r) => sites[r.site])
      // Attach any WATCHED site close enough that a single approach could belong to either. Eglin
      // and Hurlburt are 9.3nm apart against a 10nm terminal radius, so their terminal areas
      // overlap outright — an aircraft between them is inside both and gets attributed to whichever
      // is marginally nearer. The reader has to be told that, not left to assume precision.
      .map((r) => ({ ...r, lat: sites[r.site].lat, lon: sites[r.site].lon,
                     nearbySites: droneSweep.neighboursOf ? droneSweep.neighboursOf(r.site) : [],
                     // The nearest REAL airfield to this watched point, from the 85,758-record
                     // reference set. A grid cell named "Deep sweep 30.5N 88.1W" tells a reader
                     // nothing; "Mobile Downtown Airport (KBFM), 5.8nm" tells them where they are.
                     // NOT the same claim as the site name: this is what is NEARBY, not what the
                     // contacts were attributed to. The UI must not present it as the operator.
                     nearestAirfield: airfields.describe(sites[r.site].lat, sites[r.site].lon) }));
    const max = out.reduce((m, r) => Math.max(m, r.contacts), 0) || 1;
    return send(res, 200, {
      archiveAgeHours: await archive.ageHours(),
      windowDays: Number(u.searchParams.get("days")) || 7,
      maxContacts: max,
      // maxima per radius so the client can scale colour correctly at whichever it displays
      maxByRadius: {
        // "field" ranks by aircraft actually low and close, so the colour can answer
        // "which bases are busy AT THE FIELD" instead of "which sit in busy airspace".
        field: Math.max(1, ...out.map((r) => r.terminal_contacts || 0)),
        25: Math.max(1, ...out.map((r) => r.c25 || 0)),
        100: Math.max(1, ...out.map((r) => r.c100 || 0)),
        250: max,
      },
      radiiNm: [25, 100, 250],
      note: "Intensity reflects ADS-B broadcasters observed by this sweep. Aircraft flying with transponders off are not counted.",
      count: out.length,
      // Radius metadata travels with the data so no surface can display a regional count
      // as if it were a base count. maxContacts lets the client scale colour logarithmically.
      // NOTE: maxContacts, maxByRadius and radiiNm were each declared TWICE in this object, and
      // the second maxByRadius omitted the `field` key. JavaScript keeps the LAST duplicate, so
      // the field maximum never reached the client and HeatMap fell back to the 250nm max —
      // scaling the "at the field" colour by a number ~65x too large and rendering every site
      // pale. Fixed Jul 31. Do not reintroduce a second declaration of any of these keys.
      // FROM archive.js, not typed again here. These were separate literals, so the radius the
      // client was TOLD could drift from the radius the query actually used.
      sweepRadiusNm: archive.SWEEP_NM,
      nearRadiusNm: archive.NEAR_NM,
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
  // The old hardcoded list was written early and never updated, so a 404 advertised five
  // routes while a dozen others worked — a small dishonesty in the error path itself.
  return send(res, 404, { error: "not_found", routes: ["/api/", "/api/ai/", "/api/ai/correlations", "/api/ai/digest", "/api/ai/search", "/api/ai/status", "/api/ai/track", "/api/aircraft", "/api/airspace/advisories", "/api/archive/stats", "/api/drones", "/api/drones/coverage", "/api/drones/heat", "/api/drones/history", "/api/drones/multistop", "/api/drones/operations", "/api/drones/track", "/api/subsupport", "/api/usv", "/api/vessels", "/api/cyber/flows",
      "/api/cyber/kev",
      "/api/cyber/outages",
      "/api/webcams", "/health", "/metrics"] }, origin);
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
  advisories.start();          // 6-hourly HEAD check on advisory source documents
}
module.exports = { createServer };
