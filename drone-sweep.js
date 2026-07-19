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

const SITE_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 15000); // one site per 15s → full cycle ≈ 7 min
const RADIUS_NM = 250;                 // upstream maximum
const RETAIN_MS = 24 * 60 * 60 * 1000; // keep sightings for 24h
const MAX_TRACKED = 3000;              // memory bound

// Publicly known UAV airspaces (mirrors the UAV Watch catalog entries).
const SITES = [
  ["Phoenix–Luke AFB", "United States", 33.535, -112.383],
  ["Vegas–Creech/Nellis", "United States", 36.587, -115.673],
  ["Edwards AFB–Plant 42", "United States", 34.905, -117.884],
  ["China Lake NAWS", "United States", 35.688, -117.690],
  ["Yuma Proving Ground", "United States", 32.900, -114.400],
  ["Grand Forks AFB", "United States", 47.960, -97.400],
  ["Naval Base Ventura", "United States", 34.120, -119.120],
  ["Fort Huachuca", "United States", 31.580, -110.340],
  ["CFB Goose Bay", "Canada", 53.320, -60.420],
  ["RAF Waddington", "United Kingdom", 53.170, -0.520],
  ["Amari AB", "Estonia", 59.260, 24.210],
  ["Sigonella NAS", "Italy", 37.400, 14.920],
  ["Miroslawiec", "Poland", 53.400, 16.080],
  ["Larissa AB", "Greece", 39.650, 22.460],
  ["Incirlik AB", "Türkiye", 37.000, 35.430],
  ["Al Dhafra AB", "UAE", 24.250, 54.550],
  ["Ali Al Salem AB", "Kuwait", 29.350, 47.520],
  ["Palmachim AB", "Israel", 31.900, 34.690],
  ["Bagram area", "Afghanistan", 34.950, 69.260],
  ["Jamnagar AFS", "India", 22.470, 70.010],
  ["Chabua AFS", "India", 27.460, 95.120],
  ["Kadena AB", "Japan", 26.350, 127.770],
  ["Osan AB", "South Korea", 37.090, 127.030],
  ["Andersen AFB", "Guam", 13.580, 144.920],
  ["Chabelley Airfield", "Djibouti", 11.520, 42.920],
  ["Air Base 201", "Niger", 16.970, 8.000],
  ["Woomera Range", "Australia", -31.140, 136.800],
  ["RAAF Tindal", "Australia", -14.520, 132.380],
];

const seen = new Map();     // id -> sighting record
let cursor = 0;
let cycles = 0, sweepErrors = 0, lastSweepAt = null;

function record(a, site) {
  const now = Date.now();
  const prev = seen.get(a.id);
  const point = [Math.round(a.lat * 1000) / 1000, Math.round(a.lon * 1000) / 1000, now];
  if (prev) {
    prev.lastSeen = now;
    prev.lat = a.lat; prev.lon = a.lon;
    prev.altFt = a.altFt; prev.groundSpeedKt = a.groundSpeedKt; prev.headingDeg = a.headingDeg;
    prev.site = site[0]; prev.country = site[1];
    prev.callsign = a.callsign || prev.callsign;
    if (prev.track.length === 0 || now - prev.track[prev.track.length - 1][2] > 60000) {
      prev.track.push(point);
      if (prev.track.length > 240) prev.track.shift();   // ~4h of one-minute points
    }
    return;
  }
  if (seen.size >= MAX_TRACKED) return;                  // bounded memory
  seen.set(a.id, {
    id: a.id, callsign: a.callsign || null, typeCode: a.typeCode || null,
    registration: a.registration || null, desc: a.desc || null, military: a.military ?? null,
    lat: a.lat, lon: a.lon, altFt: a.altFt, groundSpeedKt: a.groundSpeedKt, headingDeg: a.headingDeg,
    site: site[0], country: site[1], siteLat: site[2], siteLon: site[3],
    firstSeen: now, lastSeen: now, track: [point],
  });
}

function prune() {
  const cutoff = Date.now() - RETAIN_MS;
  for (const [id, s] of seen) if (s.lastSeen < cutoff) seen.delete(id);
}

async function sweepOnce() {
  const site = SITES[cursor % SITES.length];
  cursor++;
  if (cursor % SITES.length === 0) { cycles++; prune(); }
  try {
    const data = await fetchAircraft(site[2], site[3], RADIUS_NM);
    (data.aircraft || []).filter((a) => a.isDrone).forEach((a) => record(a, site));
    lastSweepAt = Date.now();
  } catch (e) {
    sweepErrors++;
    if (sweepErrors % 20 === 1) console.error("[sweep]", site[0], (e && e.message) || e);
  }
}

function start() {
  if (process.env.SWEEP_DISABLED === "1") { console.log("[sweep] disabled"); return null; }
  console.log(`[sweep] watching ${SITES.length} UAV airspaces, one per ${SITE_INTERVAL_MS / 1000}s`);
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
  return {
    source: "airplanes.live · ADS-B category B6",
    updated: new Date().toISOString(),
    sweep: { sites: SITES.length, cycles, lastSweepAt, errors: sweepErrors, tracked24h: seen.size },
    count: drones.length,
    drones,
  };
}

function getTrack(id) {
  const s = seen.get(String(id).toLowerCase()) || seen.get(String(id));
  if (!s) return null;
  return { id: s.id, callsign: s.callsign, site: s.site, firstSeen: s.firstSeen, lastSeen: s.lastSeen, track: s.track };
}

module.exports = { start, getDrones, getTrack, SITES, _seen: seen, _sweepOnce: sweepOnce };
