#!/usr/bin/env node
/*
 * build-cameras.js — where the automatic plate readers are, from OpenStreetMap.
 *
 * RUN:  cd ~/streetwatch-proxy && node build-cameras.js
 *       node build-cameras.js --bbox "32.5,-118.5,34.5,-116.5"   # one tile, for testing
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MAPS, AND WHAT IT REFUSES TO TOUCH.
 *
 * This records WHERE ALPR CAMERAS ARE. It does not read them, and could not: Flock Safety and the
 * other vendors publish no feed, and anything that looked like one would be reached through an
 * unsecured device or leaked credentials. That is the line the rest of this project already draws
 * — "private cameras of private spaces, anything reachable only because it is unsecured, are
 * deliberately excluded" — and a plate reader is the strongest case for it, because what these
 * cameras collect is a record of where named individuals drove.
 *
 * So: the camera is infrastructure, mapped like a data centre or a cable. What it sees is not
 * this project's business and never will be.
 *
 * WHY IT SITS WITH THE DATA CENTRES. A plate reader is a collection point. The read goes to
 * storage, over a network, into a facility — the three things the Data tab already maps. Put
 * together they are one picture of observation infrastructure, which is the only reason to add a
 * fifth map of a dataset four other sites already render well.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * THE COUNT IS A FLOOR, NOT A CENSUS. Every camera here was spotted from a public road by a
 * volunteer and tagged in OpenStreetMap, largely through the DeFlock project. Three consequences
 * the client must state rather than imply:
 *
 *   - Cameras exist that nobody has mapped. An empty county means nobody looked there.
 *   - Coverage follows contributors, not deployments — the same distortion that puts 72% of this
 *     project's submarine cables in one sea.
 *   - A camera removed is not necessarily unmapped, so some pins are stale.
 *
 * ODbL, same as the cable layer. Attribution is required and carried in the payload.
 */

"use strict";
const fs = require("fs");
const path = require("path");

// THREE INSTANCES OF THE SAME DATABASE. There is no second dataset — every public Flock map
// renders this one, put into OpenStreetMap by the DeFlock project — so redundancy here can only
// mean different hardware serving the same data. Eight of twenty-four tiles needed a retry on the
// main instance in one run; asking a struggling server again after 60s is a worse answer than
// asking a different one immediately.
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];
// Identify honestly. Overpass answers an absent User-Agent with 406, and it is a free shared
// service run on donated hardware — this project got its IP blocked in August by being impolite
// to it, which is a mistake worth making only once.
const UA = "streetwatch.earth (infrastructure mapping; contact via repo)";
// 20s, not 8. A run with eight-second pauses drew a 429 partway through — Overpass is free,
// shared, and enforces a budget per IP across the whole session rather than per request. Twenty
// tiles at 20s is seven minutes, which is nothing for a weekly job and is the difference between
// a complete sweep and one missing a state.
const PAUSE_MS = 20000;
// A 429 or 504 gets one retry after a long wait rather than being recorded as a failure — most
// of these clear on a second attempt, and re-running the whole build to recover one tile is worse
// for Overpass than waiting.
const RETRY_MS = 60000;

// TILES, because a country query times out. `area["ISO3166-1"="US"]` takes over 120s and returns
// nothing; a bounding box of the same ground answers in seconds. Overlaps are fine — nodes are
// deduplicated by OSM id below.
const TILES = [
  // SPLIT after 504s. Overpass refuses a tile that is too large or too dense, and these three
  // were both — US west holds California's 20,000, Texas 19,700, and the UK tile the whole of
  // Britain. A 504 is not an empty region, and a run that loses a tile loses a state.
  ["US socal",       32.0, -119.0, 34.6, -114.0],
  ["US central CA",  34.6, -122.0, 36.5, -117.0],
  ["US california N", 36.0, -125.0, 42.0, -118.0],
  ["US northwest",   42.0, -125.0, 49.5, -110.0],
  ["US southwest",   31.0, -115.0, 37.5, -102.0],
  ["US mountain",    37.0, -114.0, 49.5, -102.0],
  ["US texas W",     25.8, -107.0, 36.5, -100.0],
  ["US texas E",     25.8, -100.5, 36.5,  -93.5],
  ["US midwest N",   40.0,  -98.0, 49.5,  -87.0],
  ["US midwest S",   35.0,  -98.0, 40.5,  -87.0],
  ["US southeast",   24.4,  -92.0, 33.0,  -79.0],
  ["US appalachia S", 33.0, -88.0, 36.5, -78.0],
  ["US appalachia NW", 36.5, -88.0, 40.0, -83.5],
  ["US appalachia NE", 36.5, -83.5, 40.0, -78.0],
  ["US northeast",   38.0,  -80.5, 47.5,  -66.9],
  ["US alaska",      51.0, -172.0, 71.5, -129.0],
  ["US hawaii",      18.5, -161.0, 22.5, -154.0],
  ["Canada west",    48.0, -140.0, 60.0, -110.0],
  ["Canada east",    42.0, -110.0, 60.0,  -52.0],
  ["UK south",       49.5,  -11.0, 53.5,    2.0],
  ["UK north",       53.5,   -8.5, 61.0,    0.0],
  ["Europe west",    35.0,   -10.0, 55.0,   16.0],
  ["Europe east S",  35.0,   16.0, 48.0,   32.0],
  ["Europe east N",  48.0,   16.0, 60.0,   32.0],
  ["Australia NZ",  -48.0,   112.0, -9.0,  179.0],
];

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const ONE_BBOX = opt("bbox", null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tile(name, bbox, endpoint) {
  const q = `[out:json][timeout:180];
nwr["surveillance:type"="ALPR"](${bbox});
out center tags;`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(q),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const j = await res.json();
  // A timeout comes back as HTTP 200 with a `remark`, which is the shape of failure most likely
  // to be mistaken for an empty region.
  if (j.remark && /timed out|runtime error/i.test(j.remark)) throw new Error(`${name}: ${j.remark}`);
  return j.elements || [];
}

(async () => {
  const seen = new Map();
  const tiles = ONE_BBOX ? [["custom", ...ONE_BBOX.split(",").map(Number)]] : TILES;
  let failed = 0;

  for (const [name, s, w, n, e] of tiles) {
    const bbox = `${s},${w},${n},${e}`;
    process.stdout.write(`${name.padEnd(16)} `);
    try {
      let els = null, lastErr = null;
      for (let i = 0; i < OVERPASS.length && els === null; i++) {
        try {
          els = await tile(name, bbox, OVERPASS[i]);
        } catch (err) {
          lastErr = err;
          if (!/50\d|429|timed out/i.test(err.message)) throw err;
          const host = new URL(OVERPASS[i]).host.split(".")[1] || OVERPASS[i];
          process.stdout.write(`(${host} ${err.message.split(":").pop().trim()}) `);
          // A short pause before the next instance — they are separate machines, so there is no
          // need to wait out a rate limit that belongs to the one that just refused.
          if (i < OVERPASS.length - 1) await sleep(3000);
        }
      }
      if (els === null) throw lastErr;
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
          lat: +lat.toFixed(6),
          lon: +lon.toFixed(6),
          // The manufacturer where the mapper recorded one. 90% of a Georgia sample were Flock
          // Safety, but "ALPR" and "Flock" are different claims and the client must be able to
          // tell them apart rather than calling the whole layer Flock.
          make: t.manufacturer || null,
          operator: t.operator || null,
          // Which way it points, where recorded. A reader facing one way covers one direction of
          // travel, which is the difference between a junction watched and a junction covered.
          dir: t["camera:direction"] || t.direction || null,
          mount: t["surveillance:zone"] || t.mount || null,
        });
        added++;
      }
      console.log(`${String(els.length).padStart(6)} found · ${String(added).padStart(6)} new`);
    } catch (err) {
      failed++;
      console.log(`FAILED — ${err.message}`);
    }
    if (tiles.length > 1) await sleep(PAUSE_MS);
  }

  const cameras = [...seen.values()];
  const byMake = {};
  cameras.forEach((c) => { const k = c.make || "unrecorded"; byMake[k] = (byMake[k] || 0) + 1; });

  // REFUSE TO WRITE A COLLAPSED FILE. The cable layer lost 657 segments to an Overpass timeout
  // that wrote an empty array and committed cleanly, because the size guard watched a different
  // field. Any tile failing means this run saw less than the ground truth, and a partial file
  // silently replacing a complete one is the same bug wearing a different hat.
  const out = path.join(__dirname, "cameras.json");
  if (fs.existsSync(out)) {
    const prev = JSON.parse(fs.readFileSync(out, "utf8"));
    if (prev.count && cameras.length < prev.count * 0.8) {
      console.error(`\nREFUSING TO WRITE: ${cameras.length} cameras against ${prev.count} last time.`);
      console.error(`${failed} tile(s) failed. Re-run rather than commit a partial sweep.`);
      process.exit(1);
    }
  }

  fs.writeFileSync(out, JSON.stringify({
    source: "OpenStreetMap contributors, largely via the DeFlock project",
    licence: "ODbL — https://www.openstreetmap.org/copyright",
    built: new Date().toISOString().slice(0, 10),
    count: cameras.length,
    byMake,
    tilesFailed: failed,
    note: "Where automatic plate readers ARE. Nothing here reads a camera or records what one saw. "
        + "Every position was spotted from a public road by a volunteer and tagged in OpenStreetMap, "
        + "so this is a floor rather than a census: cameras exist that nobody has mapped, coverage "
        + "follows contributors rather than deployments, and a camera removed is not necessarily "
        + "unmapped.",
    cameras,
  }));

  const mb = (fs.statSync(out).size / 1048576).toFixed(2);
  console.log(`\nwrote ${out}`);
  console.log(`${cameras.length.toLocaleString()} cameras · ${mb} MB · ${failed} tile(s) failed`);
  console.log("by manufacturer:", Object.entries(byMake).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, v]) => `${k} ${v.toLocaleString()}`).join(" · "));
})();
