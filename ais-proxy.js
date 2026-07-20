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
// AIS_PROVIDER accepts a comma-separated list: "digitraffic,kystverket,aisstream".
// Render env vars are single key/value pairs, so combination is expressed in the value.
// "hybrid" is kept as an alias for digitraffic+kystverket so existing deployments and
// the current Render setting keep working unchanged.
const PROVIDER_RAW = process.env.AIS_PROVIDER || "digitraffic";
const PROVIDERS = new Set(
  (PROVIDER_RAW === "hybrid" ? "digitraffic,kystverket" : PROVIDER_RAW)
    .split(",").map((x) => x.trim()).filter(Boolean)
);
const PROVIDER = PROVIDER_RAW;   // kept for response payloads / logging
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
//  Provider: Kystverket (Norwegian Coastal Administration) — open AIS TCP feed.
//
//  Norway publishes raw NMEA AIVDM sentences on a public TCP socket, no key needed.
//  Coverage: Norwegian coast + Svalbard. Combined with digitraffic (Baltic) under
//  AIS_PROVIDER=hybrid this restores real northern-European marine data while
//  aisstream (global) remains dead — its TLS cert expired 2026-05-20 and two months
//  of open GitHub issues have gone unanswered.
//
//  The stream is raw ITU-R M.1371 six-bit armored payloads, so we decode the message
//  types that matter here: 1/2/3 (Class A position), 5 (Class A static, 2 parts),
//  18 (Class B position), 24 (Class B static).
// ---------------------------------------------------------------------------
const KV_HOST = process.env.KYSTVERKET_HOST || "153.44.253.27";
const KV_PORT = Number(process.env.KYSTVERKET_PORT || 5631);
const nordicStore = new Map();          // mmsi -> vessel, same shape as aisstream store
let kvState = { connected: false, lastMsgAt: 0, retries: 0 };
let kvCounters = { lines: 0, decoded: 0, skipped: 0, bad: 0 };

// six-bit armor: ASCII -> 6-bit value
function sixbitVal(ch) {
  let v = ch.charCodeAt(0) - 48;
  if (v > 40) v -= 8;
  return v;
}
function payloadBits(payload) {
  let bits = "";
  for (const ch of payload) bits += sixbitVal(ch).toString(2).padStart(6, "0");
  return bits;
}
const uint = (b, from, len) => parseInt(b.slice(from, from + len) || "0", 2);
function sint(b, from, len) {
  const raw = uint(b, from, len);
  return raw >= 1 << (len - 1) ? raw - (1 << len) : raw;   // two's complement
}
function sixbitText(b, from, len) {
  let out = "";
  for (let i = from; i + 6 <= from + len; i += 6) {
    const v = uint(b, i, 6);
    out += String.fromCharCode(v < 32 ? v + 64 : v);
  }
  return out.replace(/@/g, " ").trim();
}

function decodeAivdmPayload(bits) {
  const type = uint(bits, 0, 6);
  const mmsi = uint(bits, 8, 30);
  if (!mmsi) return null;

  if (type >= 1 && type <= 3) {
    const lon = sint(bits, 61, 28) / 600000;
    const lat = sint(bits, 89, 27) / 600000;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;   // "not available" sentinels
    const sog = uint(bits, 50, 10);
    const cog = uint(bits, 116, 12);
    const hdg = uint(bits, 128, 9);
    return { kind: "pos", mmsi, lat, lon,
      navStatus: uint(bits, 38, 4),
      sogKt: sog === 1023 ? null : sog / 10,
      cogDeg: cog === 3600 ? null : cog / 10,
      headingDeg: hdg === 511 ? null : hdg };
  }
  if (type === 18) {
    const lon = sint(bits, 57, 28) / 600000;
    const lat = sint(bits, 85, 27) / 600000;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const sog = uint(bits, 46, 10);
    const cog = uint(bits, 112, 12);
    const hdg = uint(bits, 124, 9);
    return { kind: "pos", mmsi, lat, lon,
      sogKt: sog === 1023 ? null : sog / 10,
      cogDeg: cog === 3600 ? null : cog / 10,
      headingDeg: hdg === 511 ? null : hdg };
  }
  if (type === 5) {
    const a = uint(bits, 240, 9), bb = uint(bits, 249, 9);
    const c = uint(bits, 258, 6), d = uint(bits, 264, 6);
    const draught = uint(bits, 294, 8);
    return { kind: "static", mmsi,
      callSign: sixbitText(bits, 70, 42) || null,
      name: sixbitText(bits, 112, 120) || null,
      typeCode: uint(bits, 232, 8) || null,
      lengthM: a + bb || null, beamM: c + d || null,
      draughtM: draught ? draught / 10 : null,
      destination: sixbitText(bits, 302, 120) || null };
  }
  if (type === 24) {
    const part = uint(bits, 38, 2);
    if (part === 0) return { kind: "static", mmsi, name: sixbitText(bits, 40, 120) || null };
    const a = uint(bits, 132, 9), bb = uint(bits, 141, 9);
    const c = uint(bits, 150, 6), d = uint(bits, 156, 6);
    return { kind: "static", mmsi,
      typeCode: uint(bits, 40, 8) || null,
      callSign: sixbitText(bits, 90, 42) || null,
      lengthM: a + bb || null, beamM: c + d || null };
  }
  return null;                                             // type we do not need
}

function applyDecoded(dec) {
  const id = String(dec.mmsi);
  const cur = nordicStore.get(id) || { id };
  cur.lastSeen = Date.now();
  if (dec.kind === "pos") {
    cur.lat = dec.lat; cur.lon = dec.lon;
    if (dec.sogKt != null) cur.sogKt = dec.sogKt;
    if (dec.cogDeg != null) cur.cogDeg = dec.cogDeg;
    cur.headingDeg = headingOk(dec.headingDeg);
    if (dec.navStatus != null) cur.navStatus = dec.navStatus;
  } else {
    if (dec.name) cur.name = clean(dec.name);
    if (dec.callSign) cur.callSign = clean(dec.callSign) || null;
    if (dec.typeCode != null) cur.typeCode = dec.typeCode;
    if (dec.lengthM) cur.lengthM = dec.lengthM;
    if (dec.beamM) cur.beamM = dec.beamM;
    if (dec.draughtM) cur.draughtM = dec.draughtM;
    if (dec.destination) cur.destination = clean(dec.destination) || null;
  }
  nordicStore.set(id, cur);
}

// multipart reassembly (type 5 spans two sentences)
const kvParts = new Map();              // seq -> { total, got: Map(num -> payload), at }
function handleAivdmLine(line) {
  kvCounters.lines++;
  // Kystverket prefixes sentences with NMEA 4.0 tag blocks — "\s:2573445,c:...*5B\!BSVDM,..."
  // carrying source/timestamp metadata. Rejecting lines that don't START with "!" silently
  // discarded ~99% of the feed (the 60s counters showed it: lines=2365 decoded=15 bad=0).
  // Strip everything before the sentence itself.
  const bang = line.indexOf("!");
  if (bang < 0) return;
  if (bang > 0) line = line.slice(bang);
  if (!/^!..VDM/.test(line) && !/^!..VDO/.test(line)) return;
  const star = line.indexOf("*");
  const body = star > 0 ? line.slice(0, star) : line;
  const f = body.split(",");
  if (f.length < 6) { kvCounters.bad++; return; }
  const total = Number(f[1]), num = Number(f[2]), seq = f[3] || "-";
  const payload = f[5] || "";
  if (!payload) { kvCounters.bad++; return; }

  let bits = null;
  if (total === 1) {
    bits = payloadBits(payload);
  } else {
    let e = kvParts.get(seq);
    if (!e || e.total !== total) { e = { total, got: new Map(), at: Date.now() }; kvParts.set(seq, e); }
    e.got.set(num, payload);
    if (e.got.size === total) {
      let joined = "";
      for (let i = 1; i <= total; i++) joined += e.got.get(i) || "";
      kvParts.delete(seq);
      bits = payloadBits(joined);
    }
  }
  if (!bits) return;
  try {
    const dec = decodeAivdmPayload(bits);
    if (dec) { applyDecoded(dec); kvCounters.decoded++; kvState.lastMsgAt = Date.now(); }
    else kvCounters.skipped++;               // valid sentence, type we deliberately ignore (e.g. 4)
  } catch { kvCounters.bad++; }
}

function startKystverket() {
  const net = require("net");
  let sock = null, buf = "";
  const connect = () => {
    sock = net.createConnection({ host: KV_HOST, port: KV_PORT });
    sock.setEncoding("ascii");
    sock.on("connect", () => { kvState.connected = true; kvState.retries = 0; console.log(`[kystverket] connected ${KV_HOST}:${KV_PORT}`); });
    sock.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handleAivdmLine(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
      }
      if (buf.length > 65536) buf = "";               // never let a lineless stream grow the buffer
    });
    // A dying socket fires error AND close AND sometimes end. Guarding on the socket
    // identity makes teardown idempotent — without it one disconnect scheduled several
    // reconnects, each spawning its own socket: the connect/disconnect churn in the logs,
    // and a slow connection leak.
    const mySock = sock;
    const down = () => {
      if (sock !== mySock) return;            // already torn down / superseded
      sock.destroy(); sock = null; buf = "";
      kvState.connected = false;
      const wait = Math.min(3000 * 2 ** kvState.retries, 60000);
      kvState.retries++;
      console.log(`[kystverket] disconnected — retry #${kvState.retries} in ${wait / 1000}s`);
      setTimeout(connect, wait);
    };
    sock.on("error", down);
    sock.on("close", down);
    sock.on("end", down);
  };
  connect();
  setInterval(() => {
    console.log(`[kystverket] 60s: lines=${kvCounters.lines} decoded=${kvCounters.decoded} skipped=${kvCounters.skipped} bad=${kvCounters.bad} fleet=${nordicStore.size}`);
    kvCounters = { lines: 0, decoded: 0, skipped: 0, bad: 0 };
    const cut = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of nordicStore) if (v.lastSeen < cut) nordicStore.delete(k);
  }, 60000);
}

function kystverketStatus() {
  return kvState.connected && Date.now() - kvState.lastMsgAt < 2 * 60 * 1000 ? "live" : "down";
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
    if (sd.Destination) cur.destination = clean(sd.Destination) || null;
    if (sd.ImoNumber) cur.imo = String(sd.ImoNumber);
    if (sd.CallSign) cur.callSign = clean(sd.CallSign) || null;
    if (typeof sd.MaximumStaticDraught === "number" && sd.MaximumStaticDraught > 0) cur.draughtM = sd.MaximumStaticDraught;
    const d = sd.Dimension;
    if (d && (d.A || d.B || d.C || d.D)) {
      cur.lengthM = (d.A || 0) + (d.B || 0);
      cur.beamM = (d.C || 0) + (d.D || 0);
    }
    const e = sd.Eta;
    if (e && e.Month) cur.eta = `${String(e.Month).padStart(2, "0")}-${String(e.Day || 0).padStart(2, "0")} ${String(e.Hour || 0).padStart(2, "0")}:${String(e.Minute || 0).padStart(2, "0")}Z`;
  }
  store.set(id, cur);
}
// upstream health: "live" once messages flow, "down" while we cannot hold a connection
let upstreamState = { connected: false, lastMsgAt: 0, lastCloseCode: null, retries: 0 };
function sourceStatus() {
  const out = {};
  if (PROVIDERS.has("digitraffic")) out.digitraffic = "live";           // pull-based; failures surface per-request
  if (PROVIDERS.has("kystverket")) out.kystverket = kystverketStatus();
  if (PROVIDERS.has("aisstream")) out.aisstream = aisstreamRawStatus();
  return out;
}

function upstreamStatus() {
  const st = Object.values(sourceStatus());
  if (!st.length) return "down";
  if (st.every((x) => x === "live")) return "live";
  return st.some((x) => x === "live") ? "partial" : "down";
}

function aisstreamRawStatus() {
  if (!PROVIDERS.has("aisstream")) return "off";
  const fresh = Date.now() - upstreamState.lastMsgAt < 120000;
  return upstreamState.connected && fresh ? "live" : "down";
}


// ---------------------------------------------------------------------------
// Uncrewed surface vessels (sea drones)
//
// Same honesty problem as aircraft: most military USVs broadcast nothing at all.
// What IS observable is the research and commercial fleet — Saildrone, DriX, Mariner,
// Sea Machines and similar — which carry AIS because they share crowded water with
// crewed shipping. So this identifies the visible population, not the whole one.
//
// Signals, in order of reliability:
//   1. Operator naming — these fleets use consistent, distinctive vessel names
//   2. AIS ship type 0/90-99 ("other"/unspecified) combined with a very small hull
//   3. Small hull (<25m) holding a slow, steady offshore transit for a long period
const USV_NAME = /\b(SAILDRONE|SD\s?\d{3,4}|DRIX|USV|UNCREWED|UNMANNED|MARINER\s?\d|SEA\s?MACHINES|OCIUS|BLUEBOTTLE|SEA\s?HUNTER|DEVIL\s?RAY|MARTAC|GHOST\s?FLEET|SEATRAC|SPRAY\s?GLIDER|WAVE\s?GLIDER|AUTONAUT|C-?WORKER|MAXLIMER|ECHO\s?VOYAGER)\b/i;

function classifyUsv(v) {
  const name = String(v.name || "") + " " + String(v.callSign || "");
  if (USV_NAME.test(name)) return { usv: true, usvConfidence: "confirmed" };

  const small = Number.isFinite(v.lengthM) && v.lengthM > 0 && v.lengthM <= 25;
  const unspecified = v.typeCode == null || v.typeCode === 0 || (v.typeCode >= 90 && v.typeCode <= 99);
  const slowSteady = Number.isFinite(v.sogKt) && v.sogKt > 0.5 && v.sogKt <= 8;

  // a small, type-unspecified hull making steady way is a candidate, never a claim
  if (small && unspecified && slowSteady) return { usv: true, usvConfidence: "possible" };
  return { usv: false, usvConfidence: null };
}


// ---------------------------------------------------------------------------
// Submarine support vessels
//
// Submarines themselves are NOT trackable. AIS is VHF radio and radio does not
// propagate through seawater, so a submerged vessel — military, research or tourist —
// transmits nothing. Surfaced boats usually transit dark as well.
//
// What IS observable is the surface infrastructure that supports them: tenders, rescue
// ships, research vessels carrying submersibles, and cable/salvage ships. Their movements
// indicate where submarine activity is being SUPPORTED. That is an inference about surface
// logistics, never a detection of a submarine, and the API says so.
const SUB_SUPPORT = /\b(SUBMARINE\s?(TENDER|RESCUE)|USNS\s+\w+|EMORY\s?S\.?\s?LAND|FRANK\s?CABLE|BELOS|SWIFT\s?RESCUE|MYSTIC|ATLAS|LOPEROV|KOMMUNA|IGOR\s?BELOUSOV|JIAN\s?GONG|CHANG\s?DAO|ANTEO|FORBIN|SEAHORSE\s?STANDARD|ALVIN|ATLANTIS|NAUTILE|POURQUOI\s?PAS|OCEAN\s?INFINITY|ARMADA\s?7|GLOMAR|SUBSEA|DIVE\s?SUPPORT|SATURATION\s?DIVE)\b/i;

// AIS ship types that commonly carry or support submersibles
const SUB_SUPPORT_TYPES = new Set([
  35,   // military operations
  50,   // pilot vessel
  51,   // search and rescue
  53,   // port tender
  58,   // medical / special operations
]);

function classifySubSupport(v) {
  const name = String(v.name || "") + " " + String(v.callSign || "");
  if (SUB_SUPPORT.test(name)) return { subSupport: true, subSupportConfidence: "named" };
  // type alone is weak — require a substantial hull so harbour launches do not qualify
  if (SUB_SUPPORT_TYPES.has(Number(v.typeCode)) && Number(v.lengthM) >= 60)
    return { subSupport: true, subSupportConfidence: "possible" };
  return { subSupport: false, subSupportConfidence: null };
}

function aisstreamFleet() {
  return Array.from(store.values())
    .filter((v) => typeof v.lat === "number" && typeof v.lon === "number")
    .map((v) => Object.assign({}, v, classifyUsv(v), classifySubSupport(v)));
}
function parseBoxes() {
  const raw = (process.env.AIS_BBOX || "").trim();
  if (!raw) return [[[-90, -180], [90, 180]]];          // default: whole planet
  const boxes = raw.split(";").map((b) => b.split(",").map(Number))
    .filter((v) => v.length === 4 && v.every(Number.isFinite))
    .map(([a, b, c, d]) => [[a, b], [c, d]]);
  return boxes.length ? boxes : [[[-90, -180], [90, 180]]];
}

function startProviders() {
  // Start every enabled push ingest; digitraffic is pull-based, nothing to start.
  if (PROVIDERS.has("kystverket")) startKystverket();
  if (PROVIDERS.has("aisstream")) startAisstream();
  console.log(`[ais] providers: ${[...PROVIDERS].join(" + ")}`);
}

function startAisstream() {
  if (!AISSTREAM_KEY) { console.warn("[aisstream] AISSTREAM_KEY not set — no data will arrive"); return; }
  if (typeof WebSocket === "undefined") { console.warn("[aisstream] needs Node >= 21 global WebSocket"); return; }
  let lastMsgAt = Date.now();
  let msgCount = 0, badCount = 0;
  let retries = 0;                     // drives exponential backoff on reconnect
  setInterval(() => {
    console.log(`[aisstream] 60s: msgs=${msgCount} badParse=${badCount} fleet=${store.size}`);
    msgCount = 0; badCount = 0;
  }, 60000);
  let current = null;
  process.on("SIGTERM", () => {                 // release the key before the new instance connects
    try { if (current) { current.onclose = null; current.close(1000, "shutdown"); } } catch {}
  });
  const connect = () => {
    const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
    current = ws;
    ws.addEventListener("open", () => {
      console.log("[aisstream] connected");
      lastMsgAt = Date.now();
      retries = 0;
      upstreamState.connected = true;
      // NOTE: whole-globe bbox is a firehose; narrow it in production.
      const boxes = parseBoxes();
      if (boxes.length === 1 && boxes[0][0][0] === -90) console.log("[aisstream] subscribing worldwide (set AIS_BBOX to narrow)");
      else console.log(`[aisstream] subscribing to ${boxes.length} bounding box(es)`);
      ws.send(JSON.stringify({ APIKey: AISSTREAM_KEY, BoundingBoxes: boxes,
        FilterMessageTypes: ["PositionReport", "ShipStaticData"] }));
    });
    try { ws.binaryType = "arraybuffer"; } catch {}
    ws.addEventListener("message", async (ev) => {
      lastMsgAt = Date.now(); msgCount++;
      upstreamState.lastMsgAt = lastMsgAt;   // drives upstreamStatus()
      try {
        // aisstream sends JSON in binary frames; the runtime may surface them as
        // string, Buffer, ArrayBuffer, or Blob. Decode all of them before parsing.
        let raw = ev.data;
        if (typeof raw !== "string") {
          if (raw instanceof ArrayBuffer) raw = Buffer.from(raw).toString("utf8");
          else if (typeof Buffer !== "undefined" && Buffer.isBuffer(raw)) raw = raw.toString("utf8");
          else if (raw && typeof raw.text === "function") raw = await raw.text(); // Blob
          else raw = String(raw);
        }
        const m = JSON.parse(raw);
        if (m && m.error) { console.error("[aisstream] server error:", m.error); return; }
        ingestAisstream(m);
      } catch (e) {
        badCount++;
        if (badCount === 1) console.error("[aisstream] first parse failure:", e.message,
          "| frame type:", ev.data && ev.data.constructor ? ev.data.constructor.name : typeof ev.data);
      }
    });
    ws.addEventListener("close", (ev) => {
      const code = (ev && ev.code) || 0;
      const reason = ((ev && ev.reason) || "").toString().slice(0, 200);
      retries++;
      upstreamState.connected = false;
      upstreamState.lastCloseCode = code;
      upstreamState.retries = retries;
      const wait = Math.min(3000 * Math.pow(2, retries - 1), 60000);   // 3s, 6s, 12s … capped at 60s
      console.warn(`[aisstream] closed code=${code}${reason ? " reason=" + reason : ""} — retry #${retries} in ${wait / 1000}s`);
      if (code === 1008 || (reason && /unauthor|invalid|api ?key|forbidden|limit/i.test(reason)))
        console.error("[aisstream] looks like an API-key or quota problem, not a network blip");
      setTimeout(connect, wait);
    });
    ws.addEventListener("error", (ev) => {
      const msg = (ev && (ev.message || (ev.error && ev.error.message))) || "";
      if (msg) console.error("[aisstream] socket error:", String(msg).slice(0, 200));
      try { ws.close(); } catch {}
    });
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

function classifyAll(list, provider) {
  // Classification applies to EVERY provider. Previously only the aisstream path ran
  // classifyUsv/classifySubSupport, so in digitraffic mode a Saildrone in Helsinki
  // harbour would never have been flagged — the sea-drone layer silently depended on
  // which provider happened to be configured.
  return list.map((v) => Object.assign({ provider }, v, classifyUsv(v), classifySubSupport(v)));
}

async function getFleet() {
  // Merge every enabled source by MMSI. Later sources overwrite earlier ones on overlap,
  // so the order goes pull-cache first, live streams last — the streamed record is
  // fresher and richer.
  const merged = new Map();
  if (PROVIDERS.has("digitraffic")) {
    const dt = await digitrafficFleet().catch(() => []);
    classifyAll(dt, "digitraffic").forEach((v) => merged.set(v.id, v));
  }
  if (PROVIDERS.has("kystverket")) {
    classifyAll(
      Array.from(nordicStore.values()).filter((v) => typeof v.lat === "number" && typeof v.lon === "number"),
      "kystverket"
    ).forEach((v) => merged.set(v.id, v));
  }
  if (PROVIDERS.has("aisstream")) {
    aisstreamFleet().forEach((v) => merged.set(v.id, Object.assign({ provider: "aisstream" }, v)));
  }
  return Array.from(merged.values());
}

// Radius-filtered vessels around a point (used by the combined server).
async function getVessels(lat, lon, radius) {
  const fleet = await getFleet();
  const vessels = fleet
    .map((v) => ({ ...v, distNm: nmBetween(lat, lon, v.lat, v.lon) }))
    .filter((v) => v.distNm <= radius)
    .sort((a, b) => a.distNm - b.distNm);
  return { source: PROVIDER, upstream: upstreamStatus(), sources: sourceStatus(), coverage: (() => {
      // Built from sources that are actually DELIVERING, not merely enabled. An enabled-but-dead
      // aisstream must not let this string claim "global" — coverage would overstate reality,
      // which in this app counts as a bug. A dead source is named as down instead.
      const st = sourceStatus();
      const parts = [], dead = [];
      const add = (key, label) => { if (!(key in st)) return; (st[key] === "live" ? parts : dead).push(label); };
      add("digitraffic", "Baltic Sea (digitraffic)");
      add("kystverket", "Norwegian coast & Svalbard (Kystverket)");
      add("aisstream", "global (aisstream)");
      const globalLive = st.aisstream === "live";
      return (parts.length ? parts.join(" + ") : "no sources currently delivering")
        + (globalLive ? "" : " — regional, not global")
        + (dead.length ? ` · ${dead.join(", ")} currently down` : "");
    })(), updated: new Date().toISOString(), count: vessels.length, vessels };
}

// Global sea-drone watch: every USV candidate currently in the fleet, nearest first when
// a position is given. Kept separate from /api/vessels so it is a deliberate request
// rather than something quietly mixed into ordinary marine traffic.
async function getUsvFleet(lat, lon) {
  const fleet = await getFleet();
  const hasPos = Number.isFinite(lat) && Number.isFinite(lon);
  let out = fleet.filter((v) => v.usv);
  if (hasPos) {
    out = out.map((v) => ({ ...v, distNm: nmBetween(lat, lon, v.lat, v.lon) }))
             .sort((a, b) => a.distNm - b.distNm);
  }
  return {
    source: PROVIDER, upstream: upstreamStatus(), updated: new Date().toISOString(),
    note: "Most military USVs broadcast no AIS at all. This shows the research and commercial fleet that does, plus small unidentified hulls flagged as possible.",
    submarineNote: "Submarines cannot be tracked. AIS is VHF radio, which does not travel through seawater, so no submerged vessel of any kind transmits a position. The support-vessel layer shows surface ships associated with submarine operations — infrastructure, not submarines.",
    count: out.length,
    confirmed: out.filter((v) => v.usvConfidence === "confirmed").length,
    possible: out.filter((v) => v.usvConfidence === "possible").length,
    vessels: out.slice(0, 300),
  };
}


// Surface vessels associated with submarine operations. NOT submarines — see the note.
async function getSubSupportFleet(lat, lon) {
  const fleet = await getFleet();
  const hasPos = Number.isFinite(lat) && Number.isFinite(lon);
  let out = fleet.filter((v) => v.subSupport);
  if (hasPos) {
    out = out.map((v) => ({ ...v, distNm: nmBetween(lat, lon, v.lat, v.lon) }))
             .sort((a, b) => a.distNm - b.distNm);
  }
  return {
    source: PROVIDER, upstream: upstreamStatus(), updated: new Date().toISOString(),
    note: "Submarines cannot be tracked by AIS — VHF radio does not propagate through seawater, so no submerged vessel transmits a position. These are SURFACE support ships (tenders, rescue vessels, submersible motherships). Their presence indicates where submarine activity is being supported; it is not a submarine detection.",
    count: out.length,
    named: out.filter((v) => v.subSupportConfidence === "named").length,
    possible: out.filter((v) => v.subSupportConfidence === "possible").length,
    vessels: out.slice(0, 200),
  };
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
      return send(res, 200, { query: { lat, lon, radius }, source: PROVIDER, upstream: upstreamStatus(), updated: new Date().toISOString(), count: vessels.length, vessels });
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

module.exports = { classifyUsv, classifySubSupport, getUsvFleet, getSubSupportFleet, getFleet, getVessels, startProviders, startKystverket, decodeAivdmPayload, handleAivdmLine, _nordicStore: nordicStore, normalizeDigitraffic, ingestAisstream, aisstreamFleet, startAisstream, createServer, handler, store, upstreamStatus, _upstreamState: upstreamState };
