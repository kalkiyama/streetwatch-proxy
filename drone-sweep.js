// StreetWatch — global drone sweep.
//
// Polls the UAV-watch airspaces on a slow rotation (one site at a time) and
// keeps every ADS-B category B6 (unmanned aerial vehicle) contact it sees.
// One sweep serves every user, so the app can show a planet-wide drone view
// without each client hammering the upstream API.
//
// Honest limits: this sees only drones that broadcast ADS-B (large military,
// government and test platforms) AND that a volunteer receiver can hear.
// Consumer drones use short-range Remote ID and never appear here.

const { fetchAircraft } = require("./adsb-proxy");
const archive = require("./archive.js");

// ICAO type designators for uncrewed platforms that often DON'T squawk category B6.
// Prefix match on MQ-/RQ- series covers Reaper, Predator, Triton, Global Hawk, Shadow…
const UAV_TYPE_RE = /^(MQ\d|RQ\d|TB2|ANKA|HRON|HERN|S100|WK45|SW4|GHWK)/i;

// Manufacturers of manned aircraft. ADS-B emitter category is SELF-DECLARED, so a
// mis-set transponder can broadcast "B6 / unmanned" from an ordinary Cessna. When the
// registry description names a manned airframe we keep the contact but mark it disputed
// rather than presenting a Skylane as a drone.
const MANNED_RE = /(CESSNA|PIPER|BEECH|CIRRUS|DIAMOND|MOONEY|ROBINSON|BELL|AIRBUS|BOEING|EMBRAER|BOMBARDIER|GULFSTREAM|LEARJET|SOCATA|PILATUS|TECNAM|MAULE|AVIAT|GRUMMAN|EXTRA|ROBIN|SLING|CIRRUS|QUEST|DAHER)/i;

// What kind of contact is this, why, and how much should we trust it?
// Returns null for ordinary civil traffic.
function classify(a) {
  if (a.typeCode && UAV_TYPE_RE.test(a.typeCode))
    return { kind: "uav", why: `type ${a.typeCode}`, confidence: "confirmed" };
  if (a.category === "B6") {
    if (a.desc && MANNED_RE.test(a.desc))
      return { kind: "uav", why: `B6 claimed · registry says ${a.desc}`, confidence: "disputed" };
    return { kind: "uav", why: "ADS-B category B6", confidence: "confirmed" };
  }
  if (a.military) return { kind: "military", why: "military registry flag", confidence: "confirmed" };
  return null;
}

const SITE_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 15000); // one site per 15s → full cycle ≈ 7 min
const RADIUS_NM = 250;                 // upstream maximum
const RETAIN_MS = 24 * 60 * 60 * 1000; // keep sightings for 24h
const MAX_TRACKED = 3000;              // memory bound

// Publicly known UAV airspaces (mirrors the UAV Watch catalog entries).
const SITES = [
  // ---- North America ----
  ["Creech / Nellis", "United States", 36.587, -115.673],
  ["Edwards AFB / Plant 42", "United States", 34.905, -117.884],
  ["China Lake NAWS", "United States", 35.688, -117.690],
  ["Yuma Proving Ground", "United States", 32.900, -114.400],
  ["Luke AFB / Phoenix", "United States", 33.535, -112.383],
  ["Fort Huachuca", "United States", 31.580, -110.340],
  ["Holloman AFB", "United States", 32.850, -106.110],
  ["White Sands Range", "United States", 32.380, -106.480],
  ["Cannon AFB", "United States", 34.380, -103.320],
  ["Beale AFB", "United States", 39.140, -121.440],
  ["Naval Base Ventura", "United States", 34.120, -119.120],
  ["Fort Bliss / El Paso", "United States", 31.850, -106.380],
  ["Corpus Christi NAS", "United States", 27.690, -97.290],
  ["Eglin AFB", "United States", 30.480, -86.520],
  ["Hurlburt Field", "United States", 30.430, -86.690],
  ["Robins AFB", "United States", 32.640, -83.590],
  ["Cherry Point MCAS", "United States", 34.900, -76.880],
  ["Norfolk / Oceana", "United States", 36.820, -76.030],
  ["Dover AFB", "United States", 39.130, -75.470],
  ["Wright-Patterson AFB", "United States", 39.830, -84.050],
  ["Offutt AFB", "United States", 41.120, -95.910],
  ["Tinker AFB", "United States", 35.410, -97.390],
  ["Grand Forks AFB", "United States", 47.960, -97.400],
  ["Eielson AFB", "United States", 64.670, -147.100],
  ["JB Elmendorf-Richardson", "United States", 61.250, -149.810],
  ["JB Pearl Harbor-Hickam", "United States", 21.330, -157.920],
  ["CFB Cold Lake", "Canada", 54.400, -110.280],
  ["CFB Goose Bay", "Canada", 53.320, -60.420],
  ["CFB Comox", "Canada", 49.710, -124.890],

  // ---- Europe ----
  ["RAF Waddington", "United Kingdom", 53.170, -0.520],
  ["RAF Lakenheath / Mildenhall", "United Kingdom", 52.410, 0.560],
  ["RAF Fairford", "United Kingdom", 51.680, -1.790],
  ["RAF Lossiemouth", "United Kingdom", 57.710, -3.340],
  ["RAF Brize Norton", "United Kingdom", 51.750, -1.580],
  ["Ramstein AB", "Germany", 49.440, 7.600],
  ["Spangdahlem AB", "Germany", 49.970, 6.690],
  ["Leeuwarden AB", "Netherlands", 53.220, 5.760],
  ["Kleine Brogel AB", "Belgium", 51.170, 5.470],
  ["Istres-Le Tube", "France", 43.520, 4.920],
  ["Aviano AB", "Italy", 46.030, 12.600],
  ["Sigonella NAS", "Italy", 37.400, 14.920],
  ["Decimomannu AB", "Italy", 39.350, 8.970],
  ["Rota NS", "Spain", 36.650, -6.350],
  ["Moron AB", "Spain", 37.170, -5.620],
  ["Beja AB", "Portugal", 38.080, -7.930],
  ["Keflavik", "Iceland", 63.990, -22.610],
  ["Orland AS", "Norway", 63.700, 9.600],
  ["Evenes", "Norway", 68.490, 16.680],
  ["Lulea-Kallax", "Sweden", 65.540, 22.120],
  ["Rovaniemi", "Finland", 66.560, 25.830],
  ["Amari AB", "Estonia", 59.260, 24.210],
  ["Siauliai AB", "Lithuania", 55.890, 23.390],
  ["Miroslawiec", "Poland", 53.400, 16.080],
  ["Powidz AB", "Poland", 52.380, 17.850],
  ["Mihail Kogalniceanu", "Romania", 44.360, 28.490],
  ["Graf Ignatievo", "Bulgaria", 42.290, 24.710],
  ["Larissa AB", "Greece", 39.650, 22.460],
  ["Souda Bay", "Greece", 35.530, 24.150],
  ["RAF Akrotiri", "Cyprus", 34.590, 32.990],

  // ---- Middle East ----
  ["Incirlik AB", "Turkiye", 37.000, 35.430],
  ["Al Udeid AB", "Qatar", 25.120, 51.320],
  ["Al Dhafra AB", "UAE", 24.250, 54.550],
  ["Ali Al Salem AB", "Kuwait", 29.350, 47.520],
  ["Prince Sultan AB", "Saudi Arabia", 24.060, 47.580],
  ["Muwaffaq Salti AB", "Jordan", 31.830, 36.780],
  ["Isa AB", "Bahrain", 25.920, 50.590],
  ["Palmachim AB", "Israel", 31.900, 34.690],
  ["Nevatim AB", "Israel", 31.210, 35.010],
  ["Erbil", "Iraq", 36.240, 43.960],
  ["Ain al-Asad", "Iraq", 33.790, 42.440],
  ["Bagram area", "Afghanistan", 34.950, 69.260],

  // ---- Africa ----
  ["Chabelley Airfield", "Djibouti", 11.520, 42.920],
  ["Air Base 201", "Niger", 16.970, 8.000],
  ["Manda Bay", "Kenya", -2.250, 40.910],
  ["Baledogle", "Somalia", 2.620, 44.860],
  ["Cairo West", "Egypt", 30.120, 30.920],
  ["Benghazi coast", "Libya", 32.100, 20.270],

  // ---- Asia ----
  ["Kadena AB", "Japan", 26.350, 127.770],
  ["Misawa AB", "Japan", 40.700, 141.370],
  ["Yokota AB", "Japan", 35.750, 139.350],
  ["Iwakuni MCAS", "Japan", 34.140, 132.240],
  ["Osan AB", "South Korea", 37.090, 127.030],
  ["Kunsan AB", "South Korea", 35.900, 126.620],
  ["Andersen AFB", "Guam", 13.580, 144.920],
  ["Clark AB", "Philippines", 15.190, 120.550],
  ["U-Tapao", "Thailand", 12.680, 101.000],
  ["Diego Garcia", "BIOT", -7.310, 72.410],
  ["Jamnagar AFS", "India", 22.470, 70.010],
  ["Chabua AFS", "India", 27.460, 95.120],
  ["Hindon AFS", "India", 28.710, 77.350],
  ["Nur Khan AB", "Pakistan", 33.620, 73.100],

  // ---- Oceania & South America ----
  ["Woomera Range", "Australia", -31.140, 136.800],
  ["RAAF Tindal", "Australia", -14.520, 132.380],
  ["RAAF Amberley", "Australia", -27.640, 152.710],
  ["RAAF Edinburgh", "Australia", -34.700, 138.620],
  ["RNZAF Ohakea", "New Zealand", -40.210, 175.390],
  ["Palanquero", "Colombia", 5.480, -74.660],
  ["Comalapa", "El Salvador", 13.440, -89.060],
  ["Hato / Curacao", "Curacao", 12.190, -68.960],
];

const seen = new Map();     // id -> sighting record

// Adaptive rotation. With ~100 airspaces a plain round-robin at 15s would revisit each
// one only every ~25 min. Instead: any site that produced a contact in the last 24h is
// "hot" and gets visited every pass; quiet sites are checked once every COLD_EVERY passes.
// Upstream load is unchanged either way — it depends on the interval, not the site count.
const COLD_EVERY = Number(process.env.SWEEP_COLD_EVERY || 3);
const lastHit = new Array(SITES.length).fill(0);
let queue = [];
let passNo = 0;
let passSize = 0;

function buildPass() {
  passNo++;
  const now = Date.now();
  const hot = [], cold = [];
  SITES.forEach((_, i) => ((now - lastHit[i] < 24 * 60 * 60 * 1000) ? hot : cold).push(i));
  const slice = cold.filter((_, k) => k % COLD_EVERY === passNo % COLD_EVERY);
  // interleave so hot and cold are spread through the pass rather than front-loaded
  const out = [];
  const step = slice.length ? Math.max(1, Math.round(hot.length / slice.length)) : Infinity;
  let ci = 0;
  hot.forEach((h, i) => { out.push(h); if ((i + 1) % step === 0 && ci < slice.length) out.push(slice[ci++]); });
  while (ci < slice.length) out.push(slice[ci++]);
  queue = out.length ? out : SITES.map((_, i) => i);
  passSize = queue.length;
  return passSize;
}
let cycles = 0, sweepErrors = 0, lastSweepAt = null;

function record(a, site, cls) {
  const now = Date.now();
  const prev = seen.get(a.id);
  const point = [Math.round(a.lat * 1000) / 1000, Math.round(a.lon * 1000) / 1000, now];
  if (prev) {
    prev.lastSeen = now;
    prev.lat = a.lat; prev.lon = a.lon;
    prev.altFt = a.altFt; prev.groundSpeedKt = a.groundSpeedKt; prev.headingDeg = a.headingDeg;
    prev.site = site[0]; prev.country = site[1];
    prev.callsign = a.callsign || prev.callsign;
    prev.kind = cls.kind; prev.why = cls.why; prev.confidence = cls.confidence;
    if (prev.track.length === 0 || now - prev.track[prev.track.length - 1][2] > 60000) {
      prev.track.push(point);
      if (prev.track.length > 240) prev.track.shift();   // ~4h of one-minute points
      archive.record(prev);                              // durable copy (no-op if archive disabled)
    }
    return;
  }
  if (seen.size >= MAX_TRACKED) return;                  // bounded memory
  seen.set(a.id, {
    id: a.id, kind: cls.kind, why: cls.why, confidence: cls.confidence,
    callsign: a.callsign || null, typeCode: a.typeCode || null,
    registration: a.registration || null, desc: a.desc || null, military: a.military ?? null,
    lat: a.lat, lon: a.lon, altFt: a.altFt, groundSpeedKt: a.groundSpeedKt, headingDeg: a.headingDeg,
    site: site[0], country: site[1], siteLat: site[2], siteLon: site[3],
    firstSeen: now, lastSeen: now, track: [point],
  });
  archive.record(seen.get(a.id));
}

function prune() {
  const cutoff = Date.now() - RETAIN_MS;
  for (const [id, s] of seen) if (s.lastSeen < cutoff) seen.delete(id);
}

async function sweepOnce() {
  if (queue.length === 0) { cycles++; buildPass(); if (cycles > 0) prune(); }
  const idx = queue.shift();
  const site = SITES[idx];
  try {
    const data = await fetchAircraft(site[2], site[3], RADIUS_NM);
    let hits = 0;
    (data.aircraft || []).forEach((a) => { const cls = classify(a); if (cls) { record(a, site, cls); hits++; } });
    if (hits) lastHit[idx] = Date.now();      // keep this airspace in the fast rotation
    lastSweepAt = Date.now();
  } catch (e) {
    sweepErrors++;
    if (sweepErrors % 20 === 1) console.error("[sweep]", site[0], (e && e.message) || e);
  }
}

function start() {
  if (process.env.SWEEP_DISABLED === "1") { console.log("[sweep] disabled"); return null; }
  console.log(`[sweep] watching ${SITES.length} UAV airspaces, one per ${SITE_INTERVAL_MS / 1000}s`);
  archive.init();
  sweepOnce();
  const id = setInterval(sweepOnce, SITE_INTERVAL_MS);
  setInterval(() => {
    const live = getDrones().count;
    console.log(`[sweep] cycle=${cycles} tracked=${seen.size} live=${live} errors=${sweepErrors}`);
  }, 300000);
  return id;
}

// Contacts seen within `sinceMs` (default: 15 min = "airborne now, as far as we know")
function getDrones(sinceMs = 15 * 60 * 1000) {
  const cutoff = Date.now() - sinceMs;
  const drones = Array.from(seen.values())
    .filter((s) => s.lastSeen >= cutoff)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(({ track, ...rest }) => ({ ...rest, trackPoints: track.length }));
  const byKind = drones.reduce((m, d) => ((m[d.kind] = (m[d.kind] || 0) + 1), m), {});
  return {
    source: "airplanes.live · ADS-B (category B6, UAV type codes, military registry flag)",
    updated: new Date().toISOString(),
    sweep: {
      sites: SITES.length,
      visited: Math.max(0, (queue.length ? passSize - queue.length : passSize)),
      passSize,
      hotSites: lastHit.filter((t) => Date.now() - t < 24 * 60 * 60 * 1000).length,
      cycles, lastSweepAt, errors: sweepErrors, tracked24h: seen.size,
      intervalSec: SITE_INTERVAL_MS / 1000,
    },
    count: drones.length,
    counts: {
      uav: byKind.uav || 0,
      military: byKind.military || 0,
      disputed: drones.filter((d) => d.confidence === "disputed").length,
    },
    note: "Only aircraft that broadcast ADS-B appear; aircraft with transponders off are invisible to every public feed. ADS-B emitter category is self-declared, so contacts marked 'disputed' broadcast as unmanned while the registry names a manned airframe.",
    drones,
  };
}

function getTrack(id) {
  const s = seen.get(String(id).toLowerCase()) || seen.get(String(id));
  if (!s) return null;
  return { id: s.id, callsign: s.callsign, site: s.site, firstSeen: s.firstSeen, lastSeen: s.lastSeen, track: s.track };
}

module.exports = { start, getDrones, getTrack, SITES, _seen: seen, _sweepOnce: sweepOnce };
