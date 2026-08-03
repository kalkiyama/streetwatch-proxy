#!/usr/bin/env node
/*
 * operations.js — what ACTUALLY used an airfield, rather than what was near it.
 *
 * RUN:  cd ~/streetwatch-proxy
 *       export $(grep -v '^#' .env.local | xargs)
 *       node operations.js "Whiting Field NAS"
 *       node operations.js "Eglin AFB" --days 30
 *       node operations.js --top 15            # busiest sites by operations
 *
 * READ-ONLY. One SELECT. Nothing is written and no schema changes.
 *
 * WHY THIS EXISTS. Every count in the product today is PROXIMITY: "21 military/UAV low and close"
 * means 21 aircraft were within 10nm below 4,000ft. That includes aircraft holding, going around,
 * or transiting a valley below a ridge. The panel says so — "positions only, never an observed
 * landing" — because the bands structurally cannot say more.
 * This counts EVENTS instead. A track that ENDS at a site is an arrival; one that BEGINS there is
 * a departure. That is the method discover-airfields.js already uses to find airfields nobody
 * catalogued, validated at 95% against known fields, and it found Raumai Air Weapons Range.
 *
 * IT IS STILL AN INFERENCE, and the output says so. A track ending near a field with the site
 * still observing is STRONG EVIDENCE of a landing. It is not an observed landing, and nothing in
 * public ADS-B can be. Aircraft also vanish below line-of-sight, and low altitude is exactly where
 * reception fails.
 *
 * THE OBSERVATION CLOCK, BOTH ENDS, is what makes this better than a guess:
 *   an arrival counts only if the site kept recording OTHER aircraft afterwards
 *   a departure counts only if the site was already recording BEFORE this one appeared
 * Without the first, "the sweep moved on" reads as a landing. Without the second — which was
 * MISSING until Aug 2, the comment claimed it and the code did not — "the sweep started watching"
 * reads as a departure. That over-counted departures by ~8% on a 7-day window.
 *
 * HEIGHT ABOVE FIELD, not barometric. alt_ft is above SEA LEVEL, so a flat ceiling means something
 * different at every site: 1,000ft admits anything under 2,700ft AGL at a coastal field and
 * excludes aircraft PARKED at Kabul (5,877ft). Endpoints whose ground level cannot be established
 * are DISCARDED, not guessed — see airfields.js.
 */

const { Pool } = require("pg");
const airfields = require("./airfields.js");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const SITE = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--days"
  && args[args.indexOf(a) - 1] !== "--top") || null;
const DAYS = Number(opt("days", 7));
const TOP = args.includes("--top") ? Number(opt("top", 10)) : 0;

const LOW_AGL_FT = Number(opt("low-agl", 500));   // ceiling ABOVE FIELD
const SLOW_KT    = Number(opt("slow-kt", 200));
const GAP_MIN    = Number(opt("gap-min", 240));   // silence that ends a segment; also the clock
const NEAR_NM    = Number(opt("near-nm", 10));    // an endpoint must be this close to the site

// Exported so the nightly job and the CLI share ONE implementation of the endpoint detection.
// Two copies would drift — the heat drawing in WorldMap and HeatMap did exactly that today.
async function compute(opts = {}) {
  const days = opts.days != null ? Number(opts.days) : DAYS;
  const site = opts.site !== undefined ? opts.site : SITE;
  const quiet = !!opts.quiet;
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // The observation clock: earliest and latest row per site.
  const { rows: clock } = await pool.query(
    `SELECT site, min(ts) AS first_ts, max(ts) AS last_ts FROM drone_tracks
      WHERE ts > now() - ($1||' days')::interval GROUP BY site`, [String(days)]);
  const siteFirst = new Map(clock.map((r) => [r.site, new Date(r.first_ts).getTime()]));
  const siteLast  = new Map(clock.map((r) => [r.site, new Date(r.last_ts).getTime()]));

  const where = site ? "AND site = $2" : "";
  const params = site ? [String(days), site] : [String(days)];
  const { rows } = await pool.query(
    `SELECT icao, ts, lat, lon, alt_ft, speed_kt, callsign, type_code, descr, site, kind, agl_ft
       FROM drone_tracks
      WHERE ts > now() - ($1||' days')::interval AND site_dist_nm <= ${NEAR_NM} ${where}
      ORDER BY icao, ts`, params);
  await pool.end();

  if (!rows.length) {
    console.log(site ? `no rows within ${NEAR_NM}nm of "${site}" in ${days} days` : "no rows");
    return;
  }

  // EXCLUDE STATIONARY EMITTERS. Souda Bay reported 18 operations from 2 "airframes" — and 16 of
  // them were TXLU05 / 46838a, described as "TWR", sitting at EXACTLY -490ft on every single event
  // across a week. A tower transponder. The method was reading gaps in its transmission as
  // departures and its resumption as arrivals.
  // THE TEST IS ZERO VARIANCE IN BOTH POSITION AND ALTITUDE, not position alone. A parked Global
  // Hawk or a Chinook on a ramp also has near-zero position spread — excluding those would replace
  // one false claim with another. But a parked AIRCRAFT still reports small barometric variation
  // (R08177 shows 825ft, the E-3G 6,800ft) while a fixed INSTALLATION reports a constant.
  // Six emitters in the whole archive: TXLU00/02/04/05, JAC02, ELW01. Small, and one of them was
  // making a NATO air base look eight times busier than it is.
  const still = new Set();
  {
    const by = new Map();
    for (const r of rows) {
      const b = by.get(r.icao) || { la: [], lo: [], al: [] };
      b.la.push(r.lat); b.lo.push(r.lon);
      if (r.alt_ft != null) b.al.push(r.alt_ft);
      by.set(r.icao, b);
    }
    for (const [icao, b] of by) {
      if (b.la.length < 5) continue;                       // too few points to be sure
      const spreadNm = Math.max((Math.max(...b.la) - Math.min(...b.la)) * 60,
                                (Math.max(...b.lo) - Math.min(...b.lo)) * 60);
      const altRange = b.al.length ? Math.max(...b.al) - Math.min(...b.al) : 0;
      if (spreadNm < 0.05 && altRange === 0) still.add(icao);
    }
    if (still.size && !quiet) console.log(`excluded ${still.size} stationary emitter(s): ${[...still].join(", ")}`);
  }

  const GAP_MS = GAP_MIN * 60000, OBS_MS = GAP_MS;
  const ops = [];
  let seg = [];
  let noGround = 0;

  // An endpoint qualifies only if it is LOW and SLOW. agl_ft is stored per row since Aug 1; where
  // it is null the ground level could not be established and the row is DISCARDED rather than
  // falling back to a looser barometric test — doing that made the discovery script measurably
  // worse (candidates 42 -> 61, validation 93% -> 92%).
  const lowSlow = (r) => {
    if (r.agl_ft == null) { noGround++; return false; }
    if (r.speed_kt != null && r.speed_kt >= SLOW_KT) return false;
    return r.agl_ft < LOW_AGL_FT;
  };

  const flush = () => {
    if (!seg.length) { seg = []; return; }
    const first = seg[0], last = seg[seg.length - 1];

    const kept = siteLast.get(last.site);
    if (lowSlow(last) && kept && kept - new Date(last.ts).getTime() > OBS_MS)
      ops.push({ ...last, ev: "arrival" });

    const began = siteFirst.get(first.site);
    if (lowSlow(first) && began && new Date(first.ts).getTime() - began > OBS_MS)
      ops.push({ ...first, ev: "departure" });
    seg = [];
  };

  let prev = null;
  for (const r of rows) {
    if (still.has(r.icao)) continue;
    if (prev && (r.icao !== prev.icao || new Date(r.ts) - new Date(prev.ts) > GAP_MS)) flush();
    seg.push(r); prev = r;
  }
  flush();

  if (quiet) { /* the nightly job wants events returned, not a report printed */ }
  else if (TOP) {
    const bySite = new Map();
    for (const o of ops) {
      const b = bySite.get(o.site) || { arr: 0, dep: 0, frames: new Set() };
      if (o.ev === "arrival") b.arr++; else b.dep++;
      b.frames.add(o.icao);
      bySite.set(o.site, b);
    }
    const list = [...bySite.entries()]
      .map(([site, b]) => ({ site, ...b, frames: b.frames.size, total: b.arr + b.dep }))
      .sort((a, b) => b.total - a.total).slice(0, TOP);
    console.log(`OPERATIONS — last ${days} days, endpoints within ${NEAR_NM}nm and below ${LOW_AGL_FT}ft above field\n`);
    console.log("site                            arrivals  departures  airframes");
    list.forEach((x) => console.log(
      `  ${x.site.slice(0, 28).padEnd(28)} ${String(x.arr).padStart(8)} ${String(x.dep).padStart(11)} ${String(x.frames).padStart(10)}`));
  } else {
    const arr = ops.filter((o) => o.ev === "arrival");
    const dep = ops.filter((o) => o.ev === "departure");
    const frames = new Set(ops.map((o) => o.icao));
    console.log(`\n${site} — last ${days} days`);
    const near = airfields.describe(rows[0].lat, rows[0].lon);
    if (near) console.log(`near ${near}`);
    console.log(`\n${arr.length} arrival${arr.length === 1 ? "" : "s"} · ${dep.length} departure${dep.length === 1 ? "" : "s"} · ${frames.size} distinct airframe${frames.size === 1 ? "" : "s"}\n`);
    ops.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    ops.slice(0, 30).forEach((o) => console.log(
      `  ${String(o.callsign || "—").padEnd(10)} ${o.icao}  ${String(o.descr || o.type_code || "?").slice(0, 30).padEnd(30)}` +
      ` ${o.ev.padEnd(10)} ${new Date(o.ts).toLocaleString()}  ${o.agl_ft}ft`));
    if (ops.length > 30) console.log(`  ... and ${ops.length - 30} more`);
  }

  // WHAT THIS NUMBER IS NOT. Whiting Field shows ~11 arrivals a week; its real movements run to
  // hundreds a DAY. The gap is not an error — it is what the method measures. Circuit training
  // never leaves the 10nm radius and never climbs out of coverage, so those tracks never END, and
  // an aircraft that never ends a track never produces an arrival.
  // So this counts TRAFFIC BETWEEN PLACES, not activity at a place. Left unlabelled, a reader
  // compares 11 against a published movement count, finds it 50x short, and concludes the tool is
  // broken — when it is answering a different and arguably more useful question.
if (!quiet) {
  console.log(`\nARRIVALS FROM AND DEPARTURES TO ELSEWHERE — not total movements.`);
  console.log(`Local circuit training never leaves the ${NEAR_NM}nm radius, so those flights never end a`);
  console.log(`track here and are NOT counted. A busy training field will show a small number.`);
  console.log(``);
  console.log(`INFERRED FROM TRACK ENDPOINTS, never an observed landing. An arrival is a track that`);
  console.log(`ENDS here while this site kept recording other aircraft; a departure is one that BEGINS`);
  console.log(`here after the site was already recording. Aircraft also vanish below line-of-sight, and`);
  console.log(`low altitude is exactly where reception fails — so this UNDERCOUNTS in both directions.`);
  console.log(`${noGround.toLocaleString()} endpoint(s) discarded: ground level could not be established, so height above`);
  console.log(`field was unknown. Discarded rather than guessed.`);
  }
  return ops;
}

module.exports = { compute };

// CLI only when run directly. `require("./operations.js")` from the proxy gets the function
// without executing any of this.
if (require.main === module) {
  compute().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
}
