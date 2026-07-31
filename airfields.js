/*
 * airfields.js — the reference layer. Nearest-airfield lookup and ground elevation, from the
 * 85,748-record OurAirports set built by build-airfields.js.
 *
 * TWO JOBS, both of which unblock open items:
 *
 *   1. GROUND ELEVATION, so a barometric altitude can be turned into a height above field.
 *      alt_ft in the archive is above SEA LEVEL. A flat ceiling therefore means something
 *      different everywhere: 1,000ft admits anything under 2,700ft AGL at a 300ft coastal field
 *      and excludes aircraft PARKED at Kabul (5,877ft). This is the prerequisite the radius/
 *      altitude ladder has been blocked on.
 *
 *   2. NAMING, so a location can be described by a real airfield instead of a grid label.
 *      "Deep sweep 30.5N 88.1W" tells a reader nothing. "Mobile Downtown Airport, 5.8nm" tells
 *      them where they are — and in that specific case it is the field hosting Coast Guard
 *      Aviation Training Center Mobile, which is how a 72nm coverage hole was found.
 *
 * MEMORY. Loaded into TYPED ARRAYS, not objects: ~3.5 MB against an RSS floor of 85-95 MB, about
 * 4%. Parsing the same data into 85,748 JS objects would cost roughly 17 MB. That mattered enough
 * to be worth the extra code, on a 512 MB instance where a memory investigation has just closed.
 * The parsed JSON is dropped after packing, so the ~20 MB load spike is transient.
 *
 * THE ELEVATION FIGURE IS A PROXY AND IS TREATED AS ONE.
 * There is no terrain dataset here, so ground level is the nearest reference airfield's elevation.
 * That assumes flat terrain, and it is measurably wrong where terrain is not flat: a cluster near
 * LOS ALAMOS — an airfield on a MESA at 7,171ft with the valley far below — came out at -946ft
 * "above field". Rejecting on the NUMBER cannot work, because barometric pressure ALSO produces
 * negative values (ADS-B sends pressure altitude referenced to 1013.25 hPa, not local QNH; at
 * ~27ft/hPa over a real range of ~980-1040, a parked aircraft at a sea-level field genuinely reads
 * anywhere from +1,400ft to -720ft) and the two ranges OVERLAP.
 * So rejection is on the CAUSE: if reference airfields near a point disagree about their own
 * elevation by more than ROUGH_FT, terrain is not flat and no single-field proxy means anything
 * there. groundElevation() returns null in that case, and CALLERS MUST TREAT NULL AS "UNKNOWN,
 * DISCARD" rather than falling back to something looser — falling back to a looser rule where less
 * was known made the discovery script measurably worse (candidates 42 -> 61, validation 93% -> 92%).
 */

const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const TYPE_NAME = ["small_airport", "heliport", "closed", "medium_airport",
                   "seaplane_base", "large_airport", "?", "?", "?", "unknown"];
const CLOSED = 2;

const ROUGH_FT = Number(process.env.AIRFIELD_ROUGH_FT || 500);   // terrain-disagreement limit
const GROUND_NM = Number(process.env.AIRFIELD_GROUND_NM || 15);  // how far to look for ground level

let N = 0;
let LAT, LON, ELEV, TYPE, HASEL;
let NAMES = [], IDENTS = [], COUNTRY = [];
let grid = null;          // "latCell|lonCell" -> Int32Array of indices
let ready = false;

function nmBetween(aLat, aLon, bLat, bLon) {
  const r = (x) => (x * Math.PI) / 180;
  const dLa = r(bLat - aLat), dLo = r(bLon - aLon);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLo / 2) ** 2;
  return 2 * (6371.0088 / 1.852) * Math.asin(Math.sqrt(h));
}

function load(file) {
  const p = file || path.join(__dirname, "airfields.json.gz");
  if (!fs.existsSync(p)) {
    console.error(`[airfields] ${path.basename(p)} not found — run: node build-airfields.js`);
    return false;
  }
  let rows;
  try {
    rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
  } catch (e) {
    console.error("[airfields] could not read reference file:", e.message);
    return false;
  }

  N = rows.length;
  LAT = new Float32Array(N); LON = new Float32Array(N);
  ELEV = new Int16Array(N);  TYPE = new Uint8Array(N); HASEL = new Uint8Array(N);
  NAMES = new Array(N); IDENTS = new Array(N); COUNTRY = new Array(N);

  const buckets = new Map();
  for (let i = 0; i < N; i++) {
    const r = rows[i];
    NAMES[i] = r[0]; IDENTS[i] = r[1]; TYPE[i] = r[2];
    LAT[i] = r[3]; LON[i] = r[4];
    // Int16 spans -32,768..32,767 ft. The highest airfield on earth is ~14,500ft, so this is safe
    // with a wide margin — but clamp rather than let a bad record wrap silently to a negative.
    if (r[5] === null) { ELEV[i] = 0; HASEL[i] = 0; }
    else { ELEV[i] = Math.max(-2000, Math.min(30000, r[5])); HASEL[i] = 1; }
    COUNTRY[i] = r[6];

    const key = `${Math.floor(r[3])}|${Math.floor(r[4])}`;
    let b = buckets.get(key);
    if (!b) { b = []; buckets.set(key, b); }
    b.push(i);
  }
  grid = new Map();
  for (const [k, v] of buckets) grid.set(k, Int32Array.from(v));

  ready = true;
  const withEl = HASEL.reduce((a, b) => a + b, 0);
  console.log(`[airfields] ${N.toLocaleString()} reference airfields loaded · elevation on ${withEl.toLocaleString()} (${Math.round(100 * withEl / N)}%)`);
  return true;
}

// Candidate indices from the 3x3 block of 1-degree cells around a point. A 1-degree cell is 60nm
// of latitude, so the block always covers any query radius used here with margin.
function* candidates(lat, lon) {
  const la = Math.floor(lat), lo = Math.floor(lon);
  for (let dla = -1; dla <= 1; dla++)
    for (let dlo = -1; dlo <= 1; dlo++) {
      const b = grid.get(`${la + dla}|${lo + dlo}`);
      if (b) for (let k = 0; k < b.length; k++) yield b[k];
    }
}

function record(i, distNm) {
  return {
    name: NAMES[i], ident: IDENTS[i], type: TYPE_NAME[TYPE[i]] || "unknown",
    lat: LAT[i], lon: LON[i],
    elevFt: HASEL[i] ? ELEV[i] : null,
    country: COUNTRY[i],
    distNm: Math.round(distNm * 100) / 100,
    closed: TYPE[i] === CLOSED,
  };
}

/**
 * Nearest reference airfield to a point.
 * @param {object} opt
 *   maxNm         cap the search (default 60)
 *   includeClosed keep closed fields — WRONG for naming, RIGHT for elevation (default false)
 *   runwayOnly    exclude heliports and seaplane bases, for "could this explain fixed-wing?"
 */
function nearest(lat, lon, opt = {}) {
  if (!ready || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const maxNm = opt.maxNm ?? 60;
  const wantClosed = opt.includeClosed === true;
  const runwayOnly = opt.runwayOnly === true;
  let best = -1, bd = Infinity;
  for (const i of candidates(lat, lon)) {
    if (!wantClosed && TYPE[i] === CLOSED) continue;
    if (runwayOnly && (TYPE[i] === 1 || TYPE[i] === 4)) continue;   // heliport, seaplane base
    const d = nmBetween(lat, lon, LAT[i], LON[i]);
    if (d < bd) { bd = d; best = i; }
  }
  return best >= 0 && bd <= maxNm ? record(best, bd) : null;
}

/** Every reference airfield within a radius, nearest first. */
function within(lat, lon, radiusNm, opt = {}) {
  if (!ready || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const wantClosed = opt.includeClosed === true;
  const out = [];
  for (const i of candidates(lat, lon)) {
    if (!wantClosed && TYPE[i] === CLOSED) continue;
    const d = nmBetween(lat, lon, LAT[i], LON[i]);
    if (d <= radiusNm) out.push(record(i, d));
  }
  out.sort((a, b) => a.distNm - b.distNm);
  return opt.limit ? out.slice(0, opt.limit) : out;
}

/**
 * Ground elevation in feet, or NULL if it cannot be established.
 * NULL means UNKNOWN — discard the observation. Do not substitute a looser rule; doing that made
 * the discovery script worse, measurably.
 * Closed airfields ARE used here: they cannot host traffic but they are still valid terrain samples.
 */
function groundElevation(lat, lon) {
  if (!ready || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best = -1, bd = Infinity, min = Infinity, max = -Infinity, n = 0;
  for (const i of candidates(lat, lon)) {
    if (!HASEL[i]) continue;
    const d = nmBetween(lat, lon, LAT[i], LON[i]);
    if (d > GROUND_NM) continue;
    n++;
    if (ELEV[i] < min) min = ELEV[i];
    if (ELEV[i] > max) max = ELEV[i];
    if (d < bd) { bd = d; best = i; }
  }
  if (best < 0) return null;                       // no reference in range
  if (n >= 2 && max - min > ROUGH_FT) return null; // terrain disagrees with itself — proxy is void
  return ELEV[best];
}

/**
 * Height above field for a BAROMETRIC altitude, or null if ground level is unknown.
 * The caller must state the uncertainty: ADS-B pressure altitude carries up to ~+/-800ft of error
 * from local QNH alone, so "under 500ft above field" means "under 500ft, plus or minus the day's
 * pressure deviation". That is still far better than a flat sea-level ceiling, and it is not
 * precision.
 */
function heightAboveField(lat, lon, altFt) {
  if (altFt === null || altFt === undefined) return null;
  const g = groundElevation(lat, lon);
  return g === null ? null : altFt - g;
}

/**
 * Human label for a position. NEAREST IS NOT MOST USEFUL.
 * The first version of this returned the nearest open field, and for the Mobile Bay cell that gave
 * "Midstream Fuel Service Seaplane Base Heliport, 1.0nm" — technically correct and useless, when
 * the answer a reader needs is MOBILE DOWNTOWN AIRPORT at 5.8nm, the field hosting Coast Guard
 * Aviation Training Center Mobile. An oil-and-gas helipad does not explain a C-130.
 * So: prefer a RUNWAY-CAPABLE field within runwayNm, and fall back to anything only if there is
 * none. A runway 6nm away describes a location better than a helipad 1nm away.
 * Same lesson as the audit tool's name heuristic, arriving from the other side: proximity in a
 * database is not relevance.
 */
function describe(lat, lon, maxNm = 25, runwayNm = 12) {
  const runway = nearest(lat, lon, { maxNm: runwayNm, runwayOnly: true });
  const a = runway || nearest(lat, lon, { maxNm });
  return a ? `${a.name}${a.ident ? ` (${a.ident})` : ""}, ${a.distNm.toFixed(1)}nm` : null;
}

module.exports = {
  load, nearest, within, groundElevation, heightAboveField, describe,
  get ready() { return ready; },
  get count() { return N; },
  nmBetween,
};
