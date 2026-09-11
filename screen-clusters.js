#!/usr/bin/env node
/*
 * screen-clusters.js — run the dwell test across every unmatched cluster at once.
 *
 * RUN:  cd ~/streetwatch-proxy
 *       export $(grep -v '^#' .env.local | xargs)
 *       node discover-airfields.js --days 90 --min-events 3 > /tmp/clusters.txt
 *       node screen-clusters.js /tmp/clusters.txt
 *
 * WHY. The September run produced 130 clusters with no catalogued airfield within 3nm. Every one
 * was a candidate and none had been examined, because examining one by hand took an afternoon and
 * the first one checked — Cedarville, Maryland — turned out to be a helicopter transit corridor
 * rather than a landing site.
 *
 * That check is now mechanical. discover-airfields.js finds places where aircraft go LOW AND SLOW,
 * which includes both landings and low transit; dwell-check.js separates them by asking whether
 * anything actually stopped. This runs the second across the output of the first.
 *
 * WHAT COUNTS AS A STOP, and why it is stricter than it looks:
 *   - a gap in the observations of 3 to 240 minutes
 *   - the track resumes within 1.5nm of where it ended
 *   - AND something is under 10kt on one side of the gap
 *
 * The speed clause is the whole test. Without it Cedarville scored 60% and Raumai Air Weapons Range
 * scored 69% — indistinguishable — and with it they score 0 and 11. A helicopter at 80kt that
 * vanishes and returns half a mile later has flown behind a ridge, not landed.
 *
 * WHAT THIS DOES NOT DO. It does not identify anything. A cluster with stops is a place where
 * aircraft repeatedly come to rest and no airfield register explains it. That is a candidate for
 * a human to look at with imagery — a range, a landing zone, a helipad, a farm strip, or a
 * mis-parsed reference elevation. The tool is for triage, not conclusions.
 */

"use strict";
const fs = require("fs");
const { Pool } = require("pg");

const MIN_GAP_MIN = 3, MAX_GAP_MIN = 240, SAME_PLACE_NM = 1.5, STOPPED_KT = 10;
const RADIUS_NM = 3;

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("usage: node screen-clusters.js <discover-airfields output file>");
  process.exit(1);
}

// ── read the UNMATCHED section only ─────────────────────────────────────────
// The confirmed ones already have an airfield to explain them; the horizon-like ones the tool has
// already rejected as coverage edge. Neither needs screening.
const text = fs.readFileSync(file, "utf8");
const start = text.indexOf("── UNMATCHED");
const end = text.indexOf("── HORIZON-LIKE");
if (start < 0) { console.error("no UNMATCHED section in that file"); process.exit(1); }
const section = text.slice(start, end > start ? end : undefined);

const clusters = [];
const lineRe = /^\s*(-?\d+\.\d+),(-?\d+\.\d+)\s+(\d+)ac\/\s*(\d+)d[^\n]*?(\d+)ev[^\n]*?AGL~(-?\d+)ft\s+(\w+)/gm;
let m;
while ((m = lineRe.exec(section)) !== null) {
  clusters.push({
    lat: Number(m[1]), lon: Number(m[2]),
    aircraft: Number(m[3]), days: Number(m[4]), events: Number(m[5]),
    agl: Number(m[6]), country: m[7], nearest: null,
  });
}
// The NEAREST line follows each cluster and names the closest known airfield regardless of range.
const nearRe = /↳ NEAREST: ([^(]+)\(([^,]+),[^,]+,\s*([\d.]+)nm/g;
const nears = [];
while ((m = nearRe.exec(section)) !== null) nears.push({ name: m[1].trim(), code: m[2], nm: Number(m[3]) });
clusters.forEach((c, i) => { c.nearest = nears[i] || null; });

if (!clusters.length) { console.error("parsed no clusters — has the output format changed?"); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const nmBetween = (a, b, c, d) =>
  Math.hypot((a - c) * 60, (b - d) * 60 * Math.cos(((a + c) / 2 * Math.PI) / 180));

(async () => {
  console.log(`\nscreening ${clusters.length} unmatched clusters against the dwell test\n`);

  for (const c of clusters) {
    const dlat = RADIUS_NM / 60;
    const dlon = RADIUS_NM / (60 * Math.cos((c.lat * Math.PI) / 180));
    const { rows } = await pool.query(
      `SELECT icao, ts, lat, lon, speed_kt, callsign, type_code
         FROM drone_tracks
        WHERE lat BETWEEN $1 AND $2 AND lon BETWEEN $3 AND $4
        ORDER BY icao, ts`,
      [c.lat - dlat, c.lat + dlat, c.lon - dlon, c.lon + dlon]
    );
    const byIcao = {};
    rows.forEach((r) => { (byIcao[r.icao] = byIcao[r.icao] || []).push(r); });

    c.stops = 0; c.slowFlyers = 0; c.transits = 0; c.stopCallsigns = new Set();
    for (const obs of Object.values(byIcao)) {
      for (let i = 1; i < obs.length; i++) {
        const gapMin = (new Date(obs[i].ts) - new Date(obs[i - 1].ts)) / 60000;
        if (gapMin < MIN_GAP_MIN || gapMin > MAX_GAP_MIN) continue;
        const moved = nmBetween(Number(obs[i - 1].lat), Number(obs[i - 1].lon),
                                Number(obs[i].lat), Number(obs[i].lon));
        const slow = (obs[i - 1].speed_kt != null && obs[i - 1].speed_kt <= STOPPED_KT)
                  || (obs[i].speed_kt != null && obs[i].speed_kt <= STOPPED_KT);
        if (moved <= SAME_PLACE_NM && slow) {
          c.stops++;
          const cs = obs[i].callsign || obs[i - 1].callsign;
          if (cs) c.stopCallsigns.add(cs.trim());
        } else if (moved <= SAME_PLACE_NM) c.slowFlyers++;
        else c.transits++;
      }
    }
    process.stdout.write(".");
  }
  console.log("\n");

  const withStops = clusters.filter((c) => c.stops > 0).sort((a, b) => b.stops - a.stops);
  const noStops = clusters.filter((c) => c.stops === 0);

  console.log("══════════════════════════════════════════════════════════════════════════════");
  console.log(`${withStops.length} of ${clusters.length} clusters show an aircraft actually stopping.`);
  console.log(`${noStops.length} show only movement — corridors, not places.`);
  console.log("══════════════════════════════════════════════════════════════════════════════\n");

  if (withStops.length) {
    console.log("── WORTH A LOOK — aircraft came to rest here and no airfield explains it ──");
    console.log("   Ordered by number of stops. A cluster with one stop is an anecdote; several");
    console.log("   stops by several airframes over weeks is a place.\n");
    for (const c of withStops) {
      const cs = [...c.stopCallsigns].slice(0, 4).join(" ");
      console.log(`  ${c.lat.toFixed(4)},${c.lon.toFixed(4)}  ${String(c.stops).padStart(3)} stops`
        + `  ${String(c.slowFlyers).padStart(3)} slow  ${String(c.transits).padStart(3)} transit`
        + `  ${c.aircraft}ac/${c.days}d  ${c.country}`);
      if (c.nearest) console.log(`        nearest: ${c.nearest.name}(${c.nearest.code}) ${c.nearest.nm}nm`);
      if (cs) console.log(`        callsigns at rest: ${cs}`);
      // A single fleet is usually a unit operating in its own area rather than a discovery. The
      // Cedarville cluster was 49 aircraft and one callsign, MUSL — one squadron, not a secret.
      if (c.stopCallsigns.size === 1) {
        console.log(`        ONE callsign only — likely a single unit's own area, not a find`);
      }
      console.log();
    }
  }

  console.log(`── NO STOPS (${noStops.length}) — low traffic passing through, not landing ──`);
  noStops.slice(0, 15).forEach((c) => {
    console.log(`  ${c.lat.toFixed(4)},${c.lon.toFixed(4)}  ${c.aircraft}ac  ${c.transits} transits  ${c.country}`
      + (c.nearest ? `  (${c.nearest.nm}nm from ${c.nearest.name.slice(0, 28)})` : ""));
  });
  if (noStops.length > 15) console.log(`  … and ${noStops.length - 15} more`);

  console.log("\nA stop is: a 3-240min gap, resuming within 1.5nm, with something under 10kt on one");
  console.log("side of it. That is consistent with a landing and equally consistent with a");
  console.log("helicopter holding a stationary hover. Verify with imagery before calling anything");
  console.log("anything.\n");

  await pool.end();
})();
