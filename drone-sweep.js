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
  // ---- Conflict-adjacent airspaces ----
  // NOTE: aircraft engaged in combat generally fly with transponders off. What is visible
  // here is the surrounding logistics and surveillance traffic operating from nearby bases,
  // plus civil aviation. Presence of a site is not a claim about who is fighting whom.
  ["Rzeszow / Ukraine border", "Poland", 50.110, 22.020],
  ["Iasi / Ukraine border", "Romania", 47.180, 27.620],
  ["Chisinau approach", "Moldova", 46.930, 28.930],
  ["Black Sea south", "International waters", 43.500, 32.000],
  ["Beirut / Levant coast", "Lebanon", 33.820, 35.490],
  ["Golan / north Israel", "Israel", 33.100, 35.600],
  ["Red Sea north", "International waters", 20.500, 38.500],
  ["Bab-el-Mandeb", "International waters", 12.600, 43.400],
  ["Port Sudan", "Sudan", 19.580, 37.220],
  ["Bamako / Sahel", "Mali", 12.530, -7.950],
  ["Lake Chad basin", "Chad", 13.100, 14.500],
  ["Goma / Great Lakes", "DR Congo", -1.670, 29.240],
  ["Yerevan / Caucasus", "Armenia", 40.150, 44.400],
  ["Taiwan Strait", "International waters", 24.500, 119.500],
  ["South China Sea north", "International waters", 16.500, 114.000],
  ["Korea DMZ approach", "South Korea", 37.900, 126.900],
  ["Kashmir / Srinagar", "India", 34.000, 74.780],
  ["Caribbean south", "International waters", 12.800, -70.500],

  // ---- Extended global coverage: every country with plausibly observable military or
  //      state aviation. Many of these will stay quiet for long periods — that is expected,
  //      and the cold tier means quiet sites cost almost nothing.
  ["Baldonnel", "Ireland", 53.300, -6.440],
  ["Karup AB", "Denmark", 56.300, 9.120],
  ["Lielvarde AB", "Latvia", 56.780, 24.850],
  ["Machulishchy", "Belarus", 53.770, 27.630],
  ["Lviv approach", "Ukraine", 49.810, 23.960],
  ["Zeltweg AB", "Austria", 47.200, 14.740],
  ["Payerne AB", "Switzerland", 46.840, 6.920],
  ["Caslav AB", "Czechia", 49.940, 15.380],
  ["Sliac AB", "Slovakia", 48.640, 19.130],
  ["Kecskemet AB", "Hungary", 46.920, 19.750],
  ["Cerklje AB", "Slovenia", 45.900, 15.530],
  ["Zagreb Pleso", "Croatia", 45.740, 16.070],
  ["Batajnica AB", "Serbia", 44.930, 20.260],
  ["Sarajevo", "Bosnia", 43.820, 18.330],
  ["Skopje", "North Macedonia", 41.960, 21.620],
  ["Kucove AB", "Albania", 40.780, 19.900],
  ["Podgorica", "Montenegro", 42.360, 19.250],
  ["Luqa", "Malta", 35.860, 14.480],
  ["Findel", "Luxembourg", 49.630, 6.210],
  ["Tampere-Pirkkala", "Finland", 61.410, 23.600],
  ["Bodo", "Norway", 67.270, 14.370],
  ["Kaliningrad", "Russia", 54.890, 20.590],
  ["Moscow area", "Russia", 55.570, 37.270],
  ["Vladivostok", "Russia", 43.400, 132.150],
  ["Thumrait AB", "Oman", 17.670, 54.020],
  ["Aden", "Yemen", 12.830, 45.030],
  ["Latakia", "Syria", 35.400, 35.950],
  ["Tehran area", "Iran", 35.420, 51.150],
  ["Kenitra AB", "Morocco", 34.300, -6.600],
  ["Boufarik AB", "Algeria", 36.550, 2.870],
  ["Bizerte", "Tunisia", 37.240, 9.790],
  ["Addis Ababa", "Ethiopia", 8.980, 38.800],
  ["Asmara", "Eritrea", 15.290, 38.910],
  ["Entebbe", "Uganda", 0.040, 32.440],
  ["Dar es Salaam", "Tanzania", -6.870, 39.200],
  ["Kigali", "Rwanda", -1.970, 30.140],
  ["Brazzaville", "Congo", -4.250, 15.250],
  ["Libreville", "Gabon", 0.460, 9.410],
  ["Yaounde", "Cameroon", 3.720, 11.550],
  ["Abuja", "Nigeria", 9.010, 7.270],
  ["Ouagadougou", "Burkina Faso", 12.350, -1.510],
  ["Dakar", "Senegal", 14.740, -17.490],
  ["Nouakchott", "Mauritania", 18.100, -15.950],
  ["Accra", "Ghana", 5.600, -0.170],
  ["Abidjan", "Cote d'Ivoire", 5.260, -3.930],
  ["Bangui", "Central African Rep", 4.400, 18.520],
  ["Juba", "South Sudan", 4.870, 31.600],
  ["Lusaka", "Zambia", -15.330, 28.450],
  ["Harare", "Zimbabwe", -17.930, 31.090],
  ["Gaborone", "Botswana", -24.550, 25.920],
  ["Windhoek", "Namibia", -22.480, 17.470],
  ["Waterkloof AFB", "South Africa", -25.830, 28.220],
  ["Maputo", "Mozambique", -25.920, 32.570],
  ["Luanda", "Angola", -8.860, 13.230],
  ["Antananarivo", "Madagascar", -18.800, 47.480],
  ["Conakry", "Guinea", 9.580, -13.610],
  ["Monrovia", "Liberia", 6.240, -10.360],
  ["Lome", "Togo", 6.170, 1.250],
  ["Cotonou", "Benin", 6.360, 2.380],
  ["Lilongwe", "Malawi", -13.790, 33.780],
  ["Hanoi area", "Vietnam", 21.220, 105.810],
  ["Phnom Penh", "Cambodia", 11.550, 104.840],
  ["Vientiane", "Laos", 17.990, 102.560],
  ["Yangon", "Myanmar", 16.900, 96.130],
  ["Butterworth AB", "Malaysia", 5.470, 100.390],
  ["Paya Lebar AB", "Singapore", 1.360, 103.910],
  ["Jakarta area", "Indonesia", -6.130, 106.660],
  ["Brunei", "Brunei", 4.940, 114.930],
  ["Beijing area", "China", 39.510, 116.410],
  ["Ulaanbaatar", "Mongolia", 47.840, 106.770],
  ["Almaty", "Kazakhstan", 43.350, 77.040],
  ["Tashkent", "Uzbekistan", 41.260, 69.270],
  ["Ashgabat", "Turkmenistan", 37.990, 58.360],
  ["Dushanbe", "Tajikistan", 38.540, 68.820],
  ["Bishkek", "Kyrgyzstan", 43.060, 74.480],
  ["Baku", "Azerbaijan", 40.470, 50.050],
  ["Tbilisi", "Georgia", 41.670, 44.950],
  ["Kathmandu", "Nepal", 27.700, 85.360],
  ["Dhaka", "Bangladesh", 23.840, 90.400],
  ["Colombo", "Sri Lanka", 7.180, 79.880],
  ["Male", "Maldives", 4.190, 73.530],
  ["Dili", "Timor-Leste", -8.550, 125.520],
  ["Santa Lucia AB", "Mexico", 19.750, -99.020],
  ["Guatemala City", "Guatemala", 14.580, -90.530],
  ["Soto Cano AB", "Honduras", 14.380, -87.620],
  ["Managua", "Nicaragua", 12.140, -86.170],
  ["San Jose", "Costa Rica", 9.990, -84.210],
  ["Panama City", "Panama", 8.910, -79.600],
  ["Havana", "Cuba", 23.000, -82.410],
  ["Santo Domingo", "Dominican Rep", 18.430, -69.670],
  ["Port-au-Prince", "Haiti", 18.580, -72.290],
  ["Kingston", "Jamaica", 17.940, -76.790],
  ["Port of Spain", "Trinidad", 10.600, -61.340],
  ["Caracas", "Venezuela", 10.600, -66.990],
  ["Quito", "Ecuador", -0.140, -78.490],
  ["Lima area", "Peru", -12.020, -77.110],
  ["La Paz", "Bolivia", -16.510, -68.190],
  ["Brasilia", "Brazil", -15.870, -47.920],
  ["Manaus", "Brazil", -3.040, -60.050],
  ["Rio de Janeiro", "Brazil", -22.910, -43.160],
  ["Asuncion", "Paraguay", -25.240, -57.520],
  ["Montevideo", "Uruguay", -34.790, -56.030],
  ["Buenos Aires", "Argentina", -34.560, -58.420],
  ["Rio Gallegos", "Argentina", -51.610, -69.310],
  ["Santiago", "Chile", -33.390, -70.790],
  ["Punta Arenas", "Chile", -53.000, -70.850],
  ["Georgetown", "Guyana", 6.800, -58.250],
  ["Paramaribo", "Suriname", 5.450, -55.190],
  ["Belize City", "Belize", 17.540, -88.310],
  ["Nassau", "Bahamas", 25.040, -77.470],
  ["Pituffik", "Greenland", 76.530, -68.700],
  ["CFB Trenton", "Canada", 44.120, -77.530],
  ["CFB Bagotville", "Canada", 48.330, -70.990],
  ["Port Moresby", "Papua New Guinea", -9.440, 147.220],
  ["Nadi", "Fiji", -17.750, 177.440],
  ["Noumea", "New Caledonia", -22.010, 166.210],
  ["Kwajalein", "Marshall Islands", 8.720, 167.730],
  ["Tahiti Faa'a", "French Polynesia", -17.550, -149.610],
  ["RAAF Darwin", "Australia", -12.410, 130.880],
  ["RAAF Pearce", "Australia", -31.670, 116.020],
  ["Honiara", "Solomon Islands", -9.430, 160.050],
  ["Guadalcanal approach", "Vanuatu", -17.700, 168.320],
  ["McMurdo approach", "Antarctica", -77.850, 166.670],
];

const seen = new Map();     // id -> sighting record

// Adaptive rotation. With ~100 airspaces a plain round-robin at 15s would revisit each
// one only every ~25 min. Instead: any site that produced a contact in the last 24h is
// "hot" and gets visited every pass; quiet sites are checked once every COLD_EVERY passes.
// Upstream load is unchanged either way — it depends on the interval, not the site count.
// Three tiers, because breadth would otherwise cost freshness. With ~250 airspaces a
// two-tier scheme pushes the productive ones to a ~22 min refresh; tiering keeps them at ~11.
//   HOT   contact within 24h  -> every pass
//   WARM  contact within 30d  -> every WARM_EVERY passes
//   COLD  never seen anything -> every COLD_EVERY passes
const WARM_EVERY = Number(process.env.SWEEP_WARM_EVERY || 3);
const COLD_EVERY = Number(process.env.SWEEP_COLD_EVERY || 10);
const HOT_MS = 24 * 60 * 60 * 1000;
const WARM_MS = 30 * 24 * 60 * 60 * 1000;
const lastHit = new Array(SITES.length).fill(0);
let queue = [];
let passNo = 0;
let passSize = 0;
let tiers = { hot: 0, warm: 0, cold: 0 };

function buildPass() {
  passNo++;
  const now = Date.now();
  const hot = [], warm = [], cold = [];
  SITES.forEach((_, i) => {
    const age = now - lastHit[i];
    if (age < HOT_MS) hot.push(i);
    else if (lastHit[i] > 0 && age < WARM_MS) warm.push(i);
    else cold.push(i);
  });
  const warmSlice = warm.filter((_, k) => k % WARM_EVERY === passNo % WARM_EVERY);
  const coldSlice = cold.filter((_, k) => k % COLD_EVERY === passNo % COLD_EVERY);
  const extra = warmSlice.concat(coldSlice);
  // interleave so the pass is not front-loaded with hot sites
  const out = [];
  const step = extra.length ? Math.max(1, Math.round(hot.length / extra.length)) : Infinity;
  let ci = 0;
  hot.forEach((h, i) => { out.push(h); if ((i + 1) % step === 0 && ci < extra.length) out.push(extra[ci++]); });
  while (ci < extra.length) out.push(extra[ci++]);
  queue = out.length ? out : SITES.map((_, i) => i);
  passSize = queue.length;
  tiers = { hot: hot.length, warm: warm.length, cold: cold.length };
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
      hotSites: tiers.hot,
      warmSites: tiers.warm,
      coldSites: tiers.cold,
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
