#!/usr/bin/env node
/*
 * build-power.js — where the power stations are, from OpenStreetMap.
 *
 * RUN:  cd ~/streetwatch-proxy && node build-power.js
 *       node build-power.js --bbox "25,-125,50,-66"    # one tile, for testing
 *
 * WHY THIS SITS WITH THE DATA CENTRES. A hyperscale campus is a power problem before it is a
 * computing one — Meta Louisiana is 2,000MW under construction, and 2,000MW has to come from
 * somewhere. The Data tab already maps the demand; this maps what answers it. Nobody else puts
 * the two on one canvas, which is the only reason to add a layer to a tab that already has four.
 *
 * WHAT IS HERE AND WHAT IS DELIBERATELY NOT:
 *
 *   power=plant      — a generating STATION. 17,143 in the continental US. This is the layer.
 *   power=substation — numerous, mostly unnamed, and a substation on a map tells a reader almost
 *                      nothing. Queries for them time out at US scale, which is the data saying
 *                      the same thing. Not carried.
 *   power=generator  — tags each TURBINE and each PANEL, not each farm. A wind farm of 200
 *                      turbines is 200 points of equipment rather than one facility. Not carried.
 *
 * A station's OUTPUT and FUEL are recorded where the mapper knew them and absent where they did
 * not. Absent is left absent: a plant with no capacity tag is not a small plant, it is an
 * unmeasured one, and filling that in from the size of its polygon would be inventing the
 * interesting part.
 *
 * ODbL, like the cables and the cameras. Attribution carried in the payload.
 */

"use strict";
const fs = require("fs");
const path = require("path");

// Three instances of the same database. There is no second source for this — GEM's tracker covers
// large plants with better attributes but not the long tail, and it is a different dataset rather
// than a fallback. What redundancy exists here is different hardware serving the same OSM.
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
// overpass.osm.ch REMOVED. It answered every tile it was asked with empty or near-empty results —
// 34 plants for central Europe, which has thousands. It appears to serve a regional extract rather
// than the global database, so as a fallback it converts a failure into a WRONG ANSWER that passes
// every check. An instance that returns plausible-looking partial data is more dangerous than one
// that returns nothing.
const UA = "streetwatch.earth (infrastructure mapping; contact via repo)";
// 45s. Twenty seconds drew repeated 429s from the main instance partway through a 22-tile run —
// Overpass budgets per IP across a session, not per request, so the pause has to carry the whole
// sweep rather than each query. Seventeen minutes for a weekly job is nothing.
const PAUSE_MS = 45000;

// Continental tiles. A whole-planet query for power=plant times out; these are sized from what
// actually returned during testing — the US box answered with 17,143 in one go, so the tiles can
// be large where density is moderate and must be smaller where it is not.
const TILES = [
  // SPLIT. The continental US in one box drew 504s from every instance while a box a third the
  // size answered instantly — Overpass refuses on the work a query implies, not on the count it
  // would return, so a wide box over dense ground fails even when the answer is small.
  ["US west",         31.0, -125.0,  50.0, -104.0],
  ["US central",      25.0, -104.0,  50.0,  -88.0],
  ["US east",         25.0,  -88.0,  50.0,  -66.0],
  ["Canada",          41.0, -141.0,  70.0,  -52.0],
  ["Alaska Hawaii",   18.0, -172.0,  71.5, -129.0],
  ["Mexico C America", 7.0, -118.0,  33.0,  -77.0],
  ["South America N", -15.0, -82.0,  13.0,  -34.0],
  ["South America S", -56.0, -76.0, -15.0,  -53.0],
  ["Europe west",     35.0,  -11.0,  56.0,   10.0],
  ["Europe central",  42.0,   10.0,  60.0,   25.0],
  ["Europe north",    55.0,   -2.0,  71.5,   32.0],
  ["Europe east",     35.0,   25.0,  55.0,   45.0],
  ["Africa north",     8.0,  -18.0,  38.0,   36.0],
  ["Africa south",   -35.0,   10.0,   8.0,   52.0],
  ["Middle East",     12.0,   34.0,  42.0,   63.0],
  ["Russia west",     45.0,   32.0,  70.0,   70.0],
  ["Russia east",     45.0,   70.0,  72.0,  180.0],
  ["India S Asia",     5.0,   60.0,  37.0,   92.0],
  ["China N",         30.0,   73.0,  54.0,  135.0],
  ["China S SE Asia", -11.0,  92.0,  30.0,  135.0],
  ["Japan Korea",     30.0,  126.0,  46.0,  146.0],
  ["Australia NZ",   -48.0,  112.0,  -9.0,  179.0],
];

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const ONE_BBOX = opt("bbox", null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "800 MW", "1.2 GW", "800000000" — mappers write output every way a person might. Parsed to
// megawatts where the string is unambiguous and left null where it is not, rather than guessing
// at a unit and publishing a number three orders of magnitude wrong.
function megawatts(v) {
  if (!v) return null;
  const s = String(v).trim().replace(/,/g, "");
  const m = s.match(/^([\d.]+)\s*([kKmMgG]?)[wW]?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  if (unit === "g") return n * 1000;
  if (unit === "m") return n;
  if (unit === "k") return n / 1000;
  // A bare number with no unit: OSM's convention is watts, so 800000000 is 800MW. Anything under
  // 10,000 bare is more likely a mapper writing megawatts without the unit — ambiguous, so null.
  if (n >= 10000) return n / 1e6;
  return null;
}

async function tile(bbox, endpoint) {
  const q = `[out:json][timeout:180];
nwr["power"="plant"](${bbox});
out center tags;`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(q),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  // A timeout is HTTP 200 with a remark — the failure most easily mistaken for an empty region.
  if (j.remark && /timed out|runtime error/i.test(j.remark)) throw new Error(j.remark);
  const els = j.elements || [];
  // AN EMPTY ANSWER FROM A LARGE BOX IS A FAILURE, NOT A FINDING. One instance returned zero
  // plants for the continental United States and the code recorded it as a successful tile —
  // the same shape as the Overpass timeout that wrote an empty cable array and committed
  // cleanly. A region genuinely without power stations does not exist at this size.
  if (els.length === 0) throw new Error("empty result — treating as failure");
  return els;
}

(async () => {
  const seen = new Map();
  const tiles = ONE_BBOX ? [["custom", ...ONE_BBOX.split(",").map(Number)]] : TILES;
  let failed = 0;

  for (const [name, s, w, n, e] of tiles) {
    const bbox = `${s},${w},${n},${e}`;
    process.stdout.write(`${name.padEnd(18)} `);
    let els = null, lastErr = null;
    for (let i = 0; i < OVERPASS.length && els === null; i++) {
      try {
        els = await tile(bbox, OVERPASS[i]);
      } catch (err) {
        lastErr = err;
        const host = new URL(OVERPASS[i]).host.split(".")[1] || "?";
        process.stdout.write(`(${host} ${err.message.slice(0, 24)}) `);
        if (i < OVERPASS.length - 1) await sleep(3000);
      }
    }
    if (els === null) { failed++; console.log(`FAILED — ${lastErr && lastErr.message}`); }
    else {
      let added = 0;
      for (const el of els) {
        const id = `${el.type[0]}${el.id}`;
        if (seen.has(id)) continue;
        const lat = el.lat ?? (el.center && el.center.lat);
        const lon = el.lon ?? (el.center && el.center.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const t = el.tags || {};
        seen.set(id, {
          id,
          lat: +lat.toFixed(5),
          lon: +lon.toFixed(5),
          name: t.name || null,
          operator: t.operator || null,
          // What it burns or catches. Left as the mapper wrote it rather than normalised into
          // categories — "coal;biomass" is a co-firing station and collapsing it to "coal" would
          // lose the thing that makes it interesting.
          source: t["plant:source"] || t["generator:source"] || null,
          method: t["plant:method"] || null,
          mw: megawatts(t["plant:output:electricity"] || t["generator:output:electricity"]),
          // Raw, so a reader can see what the parse was given when it returns null.
          outputRaw: t["plant:output:electricity"] || t["generator:output:electricity"] || null,
          start: t["start_date"] || null,
          wikidata: t.wikidata || null,
        });
        added++;
      }
      console.log(`${String(els.length).padStart(6)} found · ${String(added).padStart(6)} new`);
    }
    if (tiles.length > 1) await sleep(PAUSE_MS);
  }

  const plants = [...seen.values()];
  const bySource = {};
  plants.forEach((p) => { const k = p.source || "unrecorded"; bySource[k] = (bySource[k] || 0) + 1; });
  const withMw = plants.filter((p) => p.mw != null);

  // The same guard the cable layer earned the hard way: a partial sweep must not silently replace
  // a complete one.
  const out = path.join(__dirname, "power.json");
  // NOTHING IS WRITTEN AFTER A FAILED TILE. The 80% guard compares against a previous file and
  // says nothing when there is none — so the first run of a broken build wrote an empty file and
  // reported success in the same breath. A sweep that lost a tile did not see the world.
  if (failed > 0) {
    console.error(`\nNOT WRITING: ${failed} tile(s) failed, so this sweep is incomplete.`);
    console.error("Overpass refuses large boxes when busy — wait and re-run rather than keep a partial file.");
    process.exit(1);
  }
  // The guard applies to a single-tile run too. Skipping it there let a zero-plant result
  // overwrite a good file without a word — the exemption was meant to let a test run write
  // freely, which is exactly the case where a bad result is most likely.
  if (fs.existsSync(out)) {
    const prev = JSON.parse(fs.readFileSync(out, "utf8"));
    if (prev.count && plants.length < prev.count * 0.8) {
      console.error(`\nREFUSING TO WRITE: ${plants.length} plants against ${prev.count} last time.`);
      console.error(`${failed} tile(s) failed. Re-run rather than commit a partial sweep.`);
      process.exit(1);
    }
  }

  fs.writeFileSync(out, JSON.stringify({
    source: "OpenStreetMap contributors",
    licence: "ODbL — https://www.openstreetmap.org/copyright",
    built: new Date().toISOString().slice(0, 10),
    count: plants.length,
    withCapacity: withMw.length,
    bySource,
    tilesFailed: failed,
    note: "Generating stations as OpenStreetMap contributors mapped them. Capacity and fuel are "
        + "present where a mapper recorded them and absent where they did not — a station with no "
        + "capacity is an unmeasured one, not a small one. Coverage follows contributors rather "
        + "than generation, so an empty region means nobody mapped it.",
    plants,
  }));

  const mb = (fs.statSync(out).size / 1048576).toFixed(2);
  console.log(`\nwrote ${out}`);
  console.log(`${plants.length.toLocaleString()} plants · ${withMw.length.toLocaleString()} with capacity · ${mb} MB · ${failed} failed`);
  console.log("by source:", Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, v]) => `${k} ${v.toLocaleString()}`).join(" · "));
})();
