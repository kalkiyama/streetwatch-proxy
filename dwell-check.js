#!/usr/bin/env node
/*
 * dwell-check.js — does an aircraft STOP at a place, or pass through a coverage gap?
 *
 * RUN:  cd ~/streetwatch-proxy
 *       export $(grep -v '^#' .env.local | xargs)
 *       node dwell-check.js 38.68 -76.84 3
 *       node dwell-check.js <lat> <lon> [radiusNm]
 *
 * WHY THIS EXISTS. discover-airfields.js finds clusters where aircraft repeatedly reach low
 * altitude and low speed. Four such clusters sit around 38.68N 76.84W in Cedarville, Maryland —
 * 49 aircraft, no catalogued airfield within 4nm, and a road called Air Force Road. That looked
 * like a finding.
 *
 * It is also exactly what a COVERAGE GAP looks like. Southern Maryland carries constant helicopter
 * traffic between Andrews, Patuxent River and Potomac Airfield, and a helicopter flying low over
 * that corridor drops below the horizon of every receiver that can hear it. The track ends. Then
 * it reappears. Clustered endpoints, balanced arrivals and departures — the same signature.
 *
 * THE TEST THAT SEPARATES THEM is what happens in between:
 *
 *   LANDED   — the aircraft disappears, and reappears LATER at the SAME PLACE. Something was on
 *              the ground for a while.
 *   TRANSIT  — the aircraft disappears, and reappears somewhere ELSE along its heading, usually
 *              within a minute or two. It never stopped; the receivers simply lost it.
 *
 * A gap of 8 minutes that resumes 400 yards away is a stop. A gap of 90 seconds that resumes 6nm
 * further on is a hole in the coverage. Neither is visible from the cluster alone, which is why
 * discover-airfields.js reports candidates and refuses to call them airfields.
 *
 * This script answers the question for one place, and it is meant to be able to answer NO. A
 * negative result here is a real outcome, not a failure — it would mean the Cedarville clusters
 * are a receiver artefact and should be recorded as such.
 */

"use strict";
const { Pool } = require("pg");

const [, , latArg, lonArg, nmArg] = process.argv;
if (!latArg || !lonArg) {
  console.error("usage: node dwell-check.js <lat> <lon> [radiusNm]");
  process.exit(1);
}
const LAT = Number(latArg), LON = Number(lonArg), NM = Number(nmArg || 3);

// Degrees per nautical mile, with longitude shrinking as latitude rises.
const DLAT = NM / 60;
const DLON = NM / (60 * Math.cos((LAT * Math.PI) / 180));

// A gap shorter than this is just the sweep's own rotation, not an absence.
const MIN_GAP_MIN = 3;
// Beyond this the aircraft has almost certainly left and come back on a separate sortie, which is
// a different claim from "it sat here".
const MAX_GAP_MIN = 240;
// How close the reappearance has to be to count as the SAME place.
const SAME_PLACE_NM = 1.5;

// SPEED IS THE REAL TEST, and distance alone got this wrong.
//
// The first version classified a gap as a stop if the track resumed within 1.5nm. By that measure
// Cedarville scored 60% and Raumai 69% — near enough identical, and the two places are nothing
// alike. Reading the rows by hand showed why: every Cedarville record resumed at 60-100kt, which
// is a helicopter FLYING SLOWLY over a wooded corridor, while Raumai carried readings at 1-3kt,
// which is an aircraft that has actually stopped.
//
// A helicopter at 80kt that vanishes and returns 0.5nm away has not landed; it has flown behind a
// ridge. Only speed distinguishes those, and a ratio built on distance alone will call a transit
// route an airfield every time.
const STOPPED_KT = 10;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const nmBetween = (a, b, c, d) =>
  Math.hypot((a - c) * 60, (b - d) * 60 * Math.cos(((a + c) / 2 * Math.PI) / 180));

(async () => {
  console.log(`\nDWELL CHECK · ${LAT}, ${LON} · within ${NM}nm\n`);

  // Every observation near the point, in time order per airframe. Grouped by ICAO because that is
  // the airframe; a callsign can change mid-flight and would split one aircraft into two.
  const { rows } = await pool.query(
    `SELECT icao, ts, lat, lon, alt_ft, agl_ft, speed_kt, callsign, type_code, kind
       FROM drone_tracks
      WHERE lat BETWEEN $1 AND $2 AND lon BETWEEN $3 AND $4
      ORDER BY icao, ts`,
    [LAT - DLAT, LAT + DLAT, LON - DLON, LON + DLON]
  );

  if (!rows.length) {
    console.log("no observations in the archive for this area.\n");
    await pool.end();
    return;
  }

  const byIcao = {};
  rows.forEach((r) => { (byIcao[r.icao] = byIcao[r.icao] || []).push(r); });

  const stops = [], slowFlyers = [], transits = [];
  for (const [icao, obs] of Object.entries(byIcao)) {
    for (let i = 1; i < obs.length; i++) {
      const gapMin = (new Date(obs[i].ts) - new Date(obs[i - 1].ts)) / 60000;
      if (gapMin < MIN_GAP_MIN || gapMin > MAX_GAP_MIN) continue;
      const moved = nmBetween(
        Number(obs[i - 1].lat), Number(obs[i - 1].lon),
        Number(obs[i].lat), Number(obs[i].lon)
      );
      const rec = {
        icao, gapMin, moved,
        callsign: obs[i].callsign || obs[i - 1].callsign || null,
        type: obs[i].type_code || obs[i - 1].type_code || null,
        kind: obs[i].kind,
        beforeAlt: obs[i - 1].alt_ft, afterAlt: obs[i].alt_ft,
        beforeSpd: obs[i - 1].speed_kt, afterSpd: obs[i].speed_kt,
        at: obs[i - 1].ts,
      };
      // A STOP needs both: the track resumed in the same place AND something was slow enough on
      // one side of the gap to have been on the ground. Either alone is not enough.
      const slow = (rec.beforeSpd != null && rec.beforeSpd <= STOPPED_KT)
                || (rec.afterSpd != null && rec.afterSpd <= STOPPED_KT);
      rec.slow = slow;
      if (moved <= SAME_PLACE_NM && slow) stops.push(rec);
      else if (moved <= SAME_PLACE_NM) slowFlyers.push(rec);
      else transits.push(rec);
    }
  }

  console.log(`observations   : ${rows.length.toLocaleString()} · ${Object.keys(byIcao).length} airframes`);
  const total = stops.length + slowFlyers.length + transits.length;
  console.log(`gaps of ${MIN_GAP_MIN}-${MAX_GAP_MIN} min : ${total}`);
  console.log(`  STOPPED    — same place, under ${STOPPED_KT}kt : ${stops.length}`);
  console.log(`  slow flyer — same place, still moving  : ${slowFlyers.length}`);
  console.log(`  transit    — resumed elsewhere         : ${transits.length}\n`);

  const show = (list, title) => {
    if (!list.length) return;
    console.log(`── ${title} ──`);
    list.sort((a, b) => b.gapMin - a.gapMin).slice(0, 12).forEach((d) => {
      console.log(`  ${d.icao} ${(d.callsign || "").padEnd(9)}${(d.type || "").padEnd(6)}`
        + ` gap ${d.gapMin.toFixed(0).padStart(4)}min  moved ${d.moved.toFixed(2)}nm`
        + `  ${d.beforeAlt ?? "?"}ft/${d.beforeSpd ?? "?"}kt \u2192 ${d.afterAlt ?? "?"}ft/${d.afterSpd ?? "?"}kt`
        + `  ${new Date(d.at).toISOString().slice(0, 16).replace("T", " ")}`);
    });
    console.log();
  };
  show(stops, `STOPPED — same place, and slow enough to be on the ground (${stops.length})`);
  show(slowFlyers, `SLOW FLYER — same place, but never below ${STOPPED_KT}kt (${slowFlyers.length})`);
  show(transits, `TRANSIT — the track resumed elsewhere (${transits.length})`);

  // ── the verdict, stated conservatively ────────────────────────────────────
  console.log("══════════════════════════════════════════════════════════════════");
  if (total < 5) {
    console.log("TOO FEW GAPS TO JUDGE. Fewer than five interruptions of usable length; any");
    console.log("figure from this is noise. Not evidence either way.");
  } else if (stops.length === 0) {
    console.log("NOTHING STOPPED HERE. Every interruption resumed with the aircraft still moving.");
    console.log("Whatever this cluster is, it is not a place aircraft land — it is a corridor they");
    console.log("fly through low enough to fall out of receiver coverage.");
  } else if (stops.length >= 5) {
    console.log(`${stops.length} interruptions resumed in the same place with an aircraft under ${STOPPED_KT}kt.`);
    console.log("That is what a landing looks like. It is still not proof — a helicopter holding a");
    console.log("stationary hover reads identically — but it is a stop rather than a transit.");
  } else {
    console.log(`Only ${stops.length} interruption(s) show an aircraft actually slowing to a stop. Too few to`);
    console.log("carry a claim on their own, and the rest of the traffic here is passing through.");
  }
  console.log("══════════════════════════════════════════════════════════════════");
  console.log("\nAGL is barometric minus a proxy ground level: expect +/-800ft of error from QNH");
  console.log("alone. Gaps are the sweep's view, not the aircraft's: this watch rotates across");
  console.log("1,081 airspaces, so a gap can be the sweep looking elsewhere rather than the");
  console.log("aircraft being absent.\n");

  await pool.end();
})();
