// ais-proxy.js
// Zero-dependency live AIS (ship) proxy for the StreetWatch marine layer.
// Node >= 20 (built-in fetch; global WebSocket for the aisstream provider).
//
//   node ais-proxy.js
//   GET /api/vessels?lat=60.15&lon=24.95&radius=40   -> normalized live ships
//   GET /health
//
// Providers (env AIS_PROVIDER):
//   digitraffic  (default) keyless REST, real ships, BALTIC / Finnish waters only.
//   aisstream    GLOBAL, needs a free key:  AIS_PROVIDER=aisstream AISSTREAM_KEY=xxxx
//
// Why a proxy: browsers can't hold an authenticated AIS WebSocket or dodge CORS,
// and the global stream is a firehose. The proxy ingests once, keeps an in-memory
// fleet, and serves cheap normalized REST snapshots filtered by radius.

const http = require("http");

const PORT = process.env.PORT || 8788;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const PROVIDER = process.env.AIS_PROVIDER || "digitraffic";
const AISSTREAM_KEY = process.env.AISSTREAM_KEY || "";
const DT_USER = process.env.DIGITRAFFIC_USER || "streetwatch/ais-proxy 1.0";
const CACHE_MS = 5000;
const MAX_RADIUS_NM = 250;
const RAD = Math.PI / 180;

const clean = (s) => (s == null ? null : String(s).trim() || null);
const headingOk = (h) => (typeof h === "number" && h >= 0 && h < 360 ? h : null); // 511 = not available
const nmBetween = (aLat, aLon, bLat, bLon) => {
  const dx = (bLon - aLon) * Math.cos(((aLat + bLat) / 2) * RAD) * 60;
  const dy = (bLat - aLat) * 60;
  return Math.hypot(dx, dy);
};

// ---------------------------------------------------------------------------
//  Provider: Digitraffic (keyless REST, Baltic). Joins location + metadata.
// ---------------------------------------------------------------------------
let dtCache = { t: 0, fleet: [] };
function normalizeDigitraffic(locations, vessels) {
  const meta = {};
  const list = Array.isArray(vessels) ? vessels : (vessels && vessels.vessels) || [];
  list.forEach((v) => { if (v && v.mmsi != null) meta[v.mmsi] = { name: clean(v.name), type: v.shipType ?? v.type ?? null }; });
  const feats = (locations && locations.features) || [];
  return feats
    .filter((f) => f.geometry && Array.isArray(f.geometry.coordinates))
    .map((f) => {
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties || {};
      const m = meta[f.mmsi] || {};
      return {
        id: String(f.mmsi), name: m.name || null, typeCode: m.type ?? null, lat, lon,
        sogKt: typeof p.sog === "number" ? p.sog : null,
        cogDeg: typeof p.cog === "number" ? p.cog : null,
        headingDeg: headingOk(p.heading),
        navStatus: typeof p.navStat === "number" ? p.navStat : null,
      };
    })
    .filter((v) => typeof v.lat === "number" && typeof v.lon === "number");
}
async function digitrafficFleet() {
  if (Date.now() - dtCache.t < CACHE_MS) return dtCache.fleet;
  const headers = { "Digitraffic-User": DT_USER, Accept: "application/json" };
  const [locRes, vesRes] = await Promise.all([
    fetch("https://meri.digitraffic.fi/api/ais/v1/locations", { headers }),
    fetch("https://meri.digitraffic.fi/api/ais/v1/vessels", { headers }).catch(() => null),
  ]);
  if (!locRes.ok) throw new Error(`digitraffic ${locRes.status}`);
  const locations = await locRes.json();
  const vessels = vesRes && vesRes.ok ? await vesRes.json() : [];
  const fleet = normalizeDigitraffic(locations, vessels);
  dtCache = { t: Date.now(), fleet };
  return fleet;
}

// ---------------------------------------------------------------------------
//  Provider: aisstream.io (global WebSocket ingest -> in-memory fleet).
// ---------------------------------------------------------------------------
const store = new Map(); // mmsi -> vessel { ..., lastSeen }
function ingestAisstream(msg) {
  const md = msg.MetaData || {};
  const mmsi = md.MMSI || md.MMSI_String;
  if (!mmsi) return;
  const id = String(mmsi);
  const cur = store.get(id) || { id };
  cur.lastSeen = Date.now();
  if (md.ShipName) cur.name = clean(md.ShipName);
  if (msg.MessageType === "PositionReport") {
    const pr = (msg.Message && msg.Message.PositionReport) || {};
    cur.lat = typeof pr.Latitude === "number" ? pr.Latitude : (md.latitude ?? cur.lat);
    cur.lon = typeof pr.Longitude === "number" ? pr.Longitude : (md.longitude ?? cur.lon);
    if (typeof pr.Sog === "number") cur.sogKt = pr.Sog;
    if (typeof pr.Cog === "number") cur.cogDeg = pr.Cog;
    cur.headingDeg = headingOk(pr.TrueHeading);
    if (typeof pr.NavigationalStatus === "number") cur.navStatus = pr.NavigationalStatus;
  } else if (msg.MessageType === "ShipStaticData") {
    const sd = (msg.Message && msg.Message.ShipStaticData) || {};
    if (sd.Type != null) cur.typeCode = sd.Type;
  }
  store.set(id, cur);
}
function aisstreamFleet() {
  return Array.from(store.values()).filter((v) => typeof v.lat === "number" && typeof v.lon === "number");
}
function startAisstream() {
  if (!AISSTREAM_KEY) { console.warn("[aisstream] AISSTREAM_KEY not set — no data will arrive"); return; }
  if (typeof WebSocket === "undefined") { console.warn("[aisstream] needs Node >= 21 global WebSocket"); return; }
  let lastMsgAt = Date.now();
  let msgCount = 0, badCount = 0;
  setInterval(() => {
    console.log(`[aisstream] 60s: msgs=${msgCount} badParse=${badCount} fleet=${store.size}`);
    msgCount = 0; badCount = 0;
  }, 60000);
  const connect = () => {
    const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
    ws.addEventListener("open", () => {
      console.log("[aisstream] connected");
      lastMsgAt = Date.now();
      // NOTE: whole-globe bbox is a firehose; narrow it in production.
      ws.send(JSON.stringify({ APIKey: AISSTREAM_KEY, BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ["PositionReport", "ShipStaticData"] }));
    });
    ws.addEventListener("message", (ev) => {
      lastMsgAt = Date.now(); msgCount++;
      try {
        const m = JSON.parse(ev.data);
        if (m && m.error) { console.error("[aisstream] server error:", m.error); return; }
        ingestAisstream(m);
      } catch (e) { badCount++; }
    });
    ws.addEventListener("close", () => { console.warn("[aisstream] closed — reconnecting in 3s"); setTimeout(connect, 3000); });
    ws.addEventListener("error", () => { try { ws.close(); } catch {} });
    // Watchdog: a half-open socket emits nothing — if the firehose goes silent
    // for 2 minutes, the connection is dead. Force-close to trigger reconnect.
    const dog = setInterval(() => {
      if (Date.now() - lastMsgAt > 120000) {
        console.warn("[aisstream] silent for 2 min — forcing reconnect");
        clearInterval(dog);
        try { ws.close(); } catch {}
      }
    }, 30000);
    ws.addEventListener("close", () => clearInterval(dog));
  };
  connect();
  setInterval(() => { const cut = Date.now() - 10 * 60 * 1000; for (const [k, v] of store) if (v.lastSeen < cut) store.delete(k); }, 60000);
}

async function getFleet() { return PROVIDER === "aisstream" ? aisstreamFleet() : digitrafficFleet(); }

// Radius-filtered vessels around a point (used by the combined server).
async function getVessels(lat, lon, radius) {
  const fleet = await getFleet();
  const vessels = fleet
    .map((v) => ({ ...v, distNm: nmBetween(lat, lon, v.lat, v.lon) }))
    .filter((v) => v.distNm <= radius)
    .sort((a, b) => a.distNm - b.distNm);
  return { source: PROVIDER, updated: new Date().toISOString(), count: vessels.length, vessels };
}

// ---------------------------------------------------------------------------
//  HTTP
// ---------------------------------------------------------------------------
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
  if (u.pathname === "/health") return send(res, 200, { ok: true, provider: PROVIDER, fleet: PROVIDER === "aisstream" ? store.size : dtCache.fleet.length, ts: Date.now() });
  if (u.pathname === "/api/vessels") {
    const lat = parseFloat(u.searchParams.get("lat"));
    const lon = parseFloat(u.searchParams.get("lon"));
    let radius = parseInt(u.searchParams.get("radius") || "40", 10);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180)
      return send(res, 400, { error: "lat and lon required (lat -90..90, lon -180..180)" });
    if (!Number.isFinite(radius) || radius < 1) radius = 40;
    radius = Math.min(radius, MAX_RADIUS_NM);
    try {
      const fleet = await getFleet();
      const vessels = fleet
        .map((v) => ({ ...v, distNm: nmBetween(lat, lon, v.lat, v.lon) }))
        .filter((v) => v.distNm <= radius)
        .sort((a, b) => a.distNm - b.distNm);
      return send(res, 200, { query: { lat, lon, radius }, source: PROVIDER, updated: new Date().toISOString(), count: vessels.length, vessels });
    } catch (e) {
      return send(res, 502, { error: "upstream_unavailable", detail: String((e && e.message) || e) });
    }
  }
  return send(res, 404, { error: "not_found" });
}
function createServer() { return http.createServer(handler); }

if (require.main === module) {
  if (PROVIDER === "aisstream") startAisstream();
  createServer().listen(PORT, () => console.log(`AIS proxy on :${PORT} — provider=${PROVIDER}`));
}

module.exports = { normalizeDigitraffic, ingestAisstream, aisstreamFleet, getVessels, startAisstream, createServer, handler, store };
