#!/usr/bin/env node
/*
 * build-datacenters.js — fetch data centre locations from PeeringDB and OpenStreetMap, write a
 * single JSON file for the app to serve.
 *
 * RUN:  cd ~/streetwatch-proxy
 *       export $(grep -v '^#' .env.local | xargs)
 *       node build-datacenters.js
 *
 * WHY A FILE AND NOT A DATABASE. This data is read-only, changes slowly, and never needs a query
 * more complex than "what is in this box". Postgres would be overhead for no benefit, and Neon's
 * free tier is already the tightest constraint in the project. A committed JSON file is also
 * VERSION CONTROLLED: `git diff` shows exactly what changed between refreshes, which no database
 * gives you for free.
 *
 * WHY NOT FETCH AT RUNTIME. Render's free tier has an ephemeral filesystem and restarts often, so
 * anything written at runtime is lost. Overpass is a shared free service that already timed out on
 * one global query here — depending on it per request would fail constantly for visitors.
 *
 * NOTHING IS MERGED. Equinix Ashburn appears in PeeringDB and in OSM under different names at
 * slightly different coordinates. Deciding those are "the same" throws away the fact that two
 * independent sources disagree, and that disagreement is itself information. Every record keeps
 * its own source, and the app shows all of them. Three pins close together tell the reader more
 * than one pin that quietly picked a winner.
 */

"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "datacenters.json");
const PDB_KEY = process.env.PEERINGDB_KEY || "";

// Starting set: the markets holding most of the world's capacity. NOT a permanent limit — this is
// a list to add to once the data quality per country is known. OSM coverage varies enormously,
// and there is no point crawling a country that returns three records.
const COUNTRIES = [
  ["US", "United States"], ["DE", "Germany"], ["NL", "Netherlands"], ["GB", "United Kingdom"],
  ["IE", "Ireland"], ["FR", "France"], ["SG", "Singapore"], ["JP", "Japan"],
  ["AU", "Australia"], ["CA", "Canada"], ["BR", "Brazil"], ["IN", "India"],
];

const OVERPASS = "https://overpass-api.de/api/interpreter";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── PeeringDB ───────────────────────────────────────────────────────────────
async function peeringdb() {
  if (!PDB_KEY) {
    console.log("PEERINGDB_KEY not set — skipping PeeringDB. Anonymous access is throttled to a");
    console.log("few requests an hour, so a key is effectively required. peeringdb.com -> API Keys.\n");
    return [];
  }
  process.stdout.write("peeringdb : fetching… ");
  const r = await fetch("https://www.peeringdb.com/api/fac", {
    headers: { Authorization: `Api-Key ${PDB_KEY}` },
  });
  if (!r.ok) throw new Error(`peeringdb ${r.status}`);
  const j = await r.json();
  const out = [];
  for (const f of j.data || []) {
    const lat = Number(f.latitude), lon = Number(f.longitude);
    // A record with no coordinates cannot go on a map. It is dropped here rather than placed
    // somewhere invented — geocoding the address would guess, and a guessed position on a map
    // of physical infrastructure is worse than an absent one.
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    // PeeringDB publishes two placeholder records — "PeeringDB Example Facility North" and
    // "South", both at the same Antarctic coordinate — and they appeared on the map as real
    // facilities, which is where the "Antarctica (2)" entry in the country filter came from.
    //
    // Excluding them is not a departure from "show everything, merge nothing". That rule is about
    // preserving genuine disagreement between independent sources; a documented test record is not
    // a disagreement, and reproducing an upstream's scaffolding faithfully is not honesty.
    if (/peeringdb example/i.test(f.name || "") || /example organization/i.test(f.org_name || "")) continue;
    out.push({
      src: "peeringdb",
      srcId: `pdb:${f.id}`,
      name: f.name || null,
      operator: f.org_name || null,
      lat, lon,
      address: [f.address1, f.address2].filter(Boolean).join(", ") || null,
      city: f.city || null,
      state: f.state || null,
      country: f.country || null,
      // Self-reported power detail. Not capacity in MW — nobody publishes that openly — but it is
      // sourced rather than inferred, which is the whole standard here.
      voltage: f.available_voltage_services && f.available_voltage_services.length
        ? f.available_voltage_services : null,
      substations: f.diverse_serving_substations || null,
      networks: Number.isFinite(f.net_count) ? f.net_count : null,
      url: f.website || null,
      ref: `https://www.peeringdb.com/fac/${f.id}`,
    });
  }
  console.log(`${out.length} facilities with coordinates (of ${(j.data || []).length})`);
  return out;
}

// ── OpenStreetMap via Overpass ──────────────────────────────────────────────
// Queried country by country. A global query was tried and the server refused it as too heavy,
// which is why this walks a list with pauses instead of asking for everything at once.
async function osmCountry(iso, label) {
  const q = `[out:json][timeout:180];
area["ISO3166-1"="${iso}"]->.a;
(
  node["telecom"="data_center"](area.a);
  way["telecom"="data_center"](area.a);
  node["building"="data_center"](area.a);
  way["building"="data_center"](area.a);
);
out center tags;`;
  const r = await fetch(OVERPASS, {
    method: "POST",
    // Overpass asks clients to identify themselves so operators can contact a heavy user rather
    // than simply blocking them. Node's fetch sends a minimal User-Agent by default.
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "streetwatch.earth data centre map (one-off monthly build)",
    },
    body: "data=" + encodeURIComponent(q),
  });
  if (!r.ok) throw new Error(`overpass ${r.status}`);
  const text = await r.text();
  // Overpass answers an overloaded request with an HTML error page and a 200, so the content has
  // to be checked rather than the status code.
  if (text.trim().startsWith("<")) throw new Error("overpass returned an error page (server busy)");
  const j = JSON.parse(text);
  const out = [];
  for (const e of j.elements || []) {
    // Most data centres are mapped as building OUTLINES rather than points — 223 ways against 39
    // nodes in Germany — so `out center` supplies a centroid for the polygons.
    const lat = e.lat != null ? e.lat : e.center && e.center.lat;
    const lon = e.lon != null ? e.lon : e.center && e.center.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const t = e.tags || {};
    out.push({
      src: "osm",
      srcId: `osm:${e.type}/${e.id}`,
      name: t.name || t["name:en"] || null,
      operator: t.operator || t.owner || null,
      lat, lon,
      address: [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ") || null,
      city: t["addr:city"] || null,
      state: t["addr:state"] || null,
      country: iso,
      voltage: null, substations: null, networks: null,
      url: t.website || null,
      ref: `https://www.openstreetmap.org/${e.type}/${e.id}`,
      wikidata: t["operator:wikidata"] || t.wikidata || null,
    });
  }
  return out;
}

// ── DataCentersExposed ──────────────────────────────────────────────────────
// A third source, and a different KIND of record from the other two.
//
// PeeringDB lists facilities that sell interconnection. OpenStreetMap has buildings somebody
// surveyed. DataCentersExposed traces campuses through regulatory filings, company registers and
// national energy regulators — which is why it carries the two fields this map has shown as
// "unknown" on every record since it was built: POWER IN MEGAWATTS, and water.
//
// ODbL, the same licence as the OSM data beside it, so the share-alike obligation is not new.
// Free CSV, no key, regenerated daily. Attribution is required and is rendered in the app.
//
// NOTHING IS MATCHED TO EXISTING RECORDS. The obvious move — find our Equinix Ashburn building and
// stamp their capacity onto it — is exactly the merge this file has refused from the start. Their
// rows are CAMPUS-level and ours are BUILDING-level: one "Amazon Northern Virginia, 400MW" would
// match thirteen separate Amazon buildings in Sterling, and applying it to each would invent
// 5,200MW. So these are added as their own records and the app shows both, the same way it already
// shows Centersquare as three OSM buildings and two PeeringDB facilities without deciding which
// framing is correct.
//
// THE MAPPED ROWS ARE SKIPPED. About 5,500 of their 6,138 are status "mapped" — single-source,
// no capacity, and their slugs show they come from PeeringDB, which this file already carries in
// full. Adding them would be 5,500 near-duplicates carrying nothing new.
//
// WHAT IS KEPT IS NOT ALL REAL, and that is the point. Only 216 are operating. 203 are PROPOSALS
// that may never be built, 19 were BLOCKED and 18 WITHDRAWN. Every record therefore carries its
// status, and the app must draw a proposal differently from a building — a map that shows a
// planning application the same way it shows a data centre is asserting something false.
const DCX_CSV = "https://datacentersexposed.com/data/facilities.csv";
const DCX_KEEP = new Set(["operating", "under_construction", "proposed", "permitted", "blocked", "withdrawn"]);

function parseCsv(text) {
  // Their export opens with a "#" comment line before the header.
  const lines = text.split("\n").filter((l) => l.length && !l.startsWith("#"));
  const head = splitRow(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = splitRow(l);
    const o = {};
    head.forEach((h, i) => { o[h] = (cells[i] || "").trim(); });
    return o;
  });
}

// Minimal quoted-CSV split. Facility names contain commas ("Meta Hyperion, Richland Parish") and
// a naive split on "," would shift every column after them.
function splitRow(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function dcx() {
  process.stdout.write("dcx       : fetching… ");
  const r = await fetch(DCX_CSV, {
    headers: { "User-Agent": "streetwatch.earth data centre map (one-off monthly build)" },
  });
  if (!r.ok) throw new Error(`dcx ${r.status}`);
  const rows = parseCsv(await r.text());
  const out = [];
  for (const f of rows) {
    if (!DCX_KEEP.has(f.status)) continue;
    const lat = Number(f.lat), lon = Number(f.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const mw = Number(f.power_mw);
    out.push({
      src: "dcx",
      srcId: `dcx:${f.slug}`,
      name: f.name || null,
      operator: f.operator || null,
      // The corporate owner behind the operator, which neither other source carries.
      parent: f.ultimate_parent || null,
      lat, lon,
      address: null,
      city: f.city || null,
      state: f.state || null,
      country: "US",
      status: f.status,
      // FINALLY a real number in the field that has said "unknown" on every record until now.
      powerMw: Number.isFinite(mw) && mw > 0 ? mw : null,
      waterGpd: f.water_gpd ? Number(f.water_gpd) || null : null,
      sqft: f.square_footage ? Number(f.square_footage) || null : null,
      year: f.year_operational || null,
      // high / medium / low. They require two independent sources before calling something
      // "operating"; single-source rows are "mapped" and are skipped above. Carried through
      // rather than flattened, because a medium-confidence 11GW proposal and a high-confidence
      // operating site are not the same claim.
      confidence: f.confidence || null,
      voltage: null, substations: null, networks: null,
      url: null,
      ref: f.source_url || f.url || null,
    });
  }
  const counts = {};
  out.forEach((x) => { counts[x.status] = (counts[x.status] || 0) + 1; });
  console.log(`${out.length} campuses · ${out.filter((x) => x.powerMw).length} with capacity · `
    + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", "));
  return out;
}

// ── Submarine cables ────────────────────────────────────────────────────────
// The physical internet, on the same map as the buildings it connects.
//
// WHY OSM RATHER THAN TELEGEOGRAPHY. TeleGeography's map is the canonical one and tracks roughly
// 570 active systems against OSM's 199 — but it is CC BY-NC-SA, and NonCommercial plus ShareAlike
// does not fit a publicly deployed app whose other data is ODbL. They also state plainly that
// their routes are STYLISED and do not reflect the actual path taken, which for a map that
// distinguishes an MLAT estimate from a broadcast fix is its own problem. OSM is less complete and
// honestly licensed; that is the trade, and the app says so.
//
// EVERY SEGMENT IS KEPT, named or not. Only 274 of 656 ways carry a name — but an unnamed cable is
// still a cable somebody surveyed, and dropping the other 382 would hide real coverage to make the
// layer look tidier. Same reasoning as the data centre records with no operator tag.
async function cables() {
  process.stdout.write("cables    : fetching… ");
  const q = `[out:json][timeout:180];
way["submarine"="yes"]["communication"~"line|optical_fiber"];
out geom tags;`;
  const r = await fetch(OVERPASS, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "streetwatch.earth data centre map (one-off monthly build)",
    },
    body: "data=" + encodeURIComponent(q),
  });
  const text = await r.text();
  if (text.trim().startsWith("<")) throw new Error("overpass returned an error page (server busy)");
  const j = JSON.parse(text);
  const out = [];
  for (const e of j.elements || []) {
    if (!e.geometry || e.geometry.length < 2) continue;
    const t = e.tags || {};
    out.push({
      srcId: `osm:way/${e.id}`,
      name: t.name || t["name:en"] || null,
      operator: t.operator || null,
      // Coordinates as [lat, lon] pairs, matching what Leaflet's polyline expects, so the client
      // draws them without a conversion step.
      line: e.geometry.map((g) => [g.lat, g.lon]),
      ref: `https://www.openstreetmap.org/way/${e.id}`,
      wikipedia: t.wikipedia || null,
    });
  }
  console.log(`${out.length} segments · ${new Set(out.map((c) => c.name).filter(Boolean)).size} named systems`);
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  const records = [];
  const bySource = {};

  try {
    const pdb = await peeringdb();
    records.push(...pdb);
    bySource.peeringdb = pdb.length;
  } catch (e) {
    console.log("peeringdb : FAILED —", e.message);
  }

  console.log("\nopenstreetmap (one country at a time; a global query is refused as too heavy):");
  for (const [iso, label] of COUNTRIES) {
    process.stdout.write(`  ${label.padEnd(16)} `);
    // ONE retry, after a long wait. "Server busy" is the normal state of a free shared endpoint
    // rather than an exceptional one, and abandoning a country on the first refusal loses data
    // that a minute's patience would have collected.
    let rows = null;
    for (let attempt = 1; attempt <= 2 && rows === null; attempt++) {
      try {
        rows = await osmCountry(iso, label);
      } catch (e) {
        if (attempt === 2) { console.log(`FAILED — ${e.message}`); break; }
        process.stdout.write(`busy, waiting 60s… `);
        await sleep(60000);
      }
    }
    if (rows) {
      records.push(...rows);
      bySource[`osm:${iso}`] = rows.length;
      console.log(`${rows.length}`);
    }
    // 25 SECONDS, not 4. The first run fired twelve queries four seconds apart and got the IP
    // blocked outright — both overpass-api.de and the kumi.systems mirror refused connections
    // afterwards, which took hours to clear. Overpass runs two query slots per client with a
    // cooldown, so a pause shorter than a typical query's own runtime is asking to be cut off.
    //
    // A dozen countries at 25s is about five minutes of waiting. That is the correct price for
    // using someone else's free service.
    await sleep(25000);
  }

  try {
    const rows = await dcx();
    records.push(...rows);
    bySource.dcx = rows.length;
  } catch (e) {
    console.log("dcx       : FAILED —", e.message);
  }

  let cableRows = [];
  try {
    await sleep(25000);
    cableRows = await cables();
  } catch (e) {
    console.log("cables    : FAILED —", e.message);
  }

  const payload = {
    built: new Date().toISOString(),
    note: "One record per SOURCE entry. Records are never merged: the same site may appear more "
        + "than once under different names and slightly different coordinates, and that "
        + "disagreement between independent sources is itself information. Capacity, water use "
        + "and power sourcing are not published openly by most operators and are absent here "
        + "rather than estimated.",
    sources: {
      peeringdb: "https://www.peeringdb.com — operator-maintained, CC-BY 4.0",
      osm: "https://www.openstreetmap.org — contributor-mapped, ODbL",
      dcx: "https://datacentersexposed.com — campuses traced through regulatory filings and "
         + "energy regulators, ODbL. \u00a9 DataCentersExposed contributors. Includes PROPOSED, "
         + "BLOCKED and WITHDRAWN sites, which do not exist and are marked as such.",
    },
    counts: bySource,
    total: records.length,
    records,
    cableNote: "Submarine cables as mapped in OpenStreetMap. Roughly a third of the world's active "
             + "systems are mapped there, and fewer than half the segments carry a name — the "
             + "unnamed ones are drawn anyway, because a cable nobody has labelled is still a "
             + "cable somebody surveyed. Routes are as contributors drew them, not surveyed "
             + "positions.",
    cableCount: cableRows.length,
    cables: cableRows,
  };

  fs.writeFileSync(OUT, JSON.stringify(payload));
  const mb = (fs.statSync(OUT).size / 1048576).toFixed(2);
  console.log(`\nwrote ${OUT}`);
  console.log(`${records.length.toLocaleString()} records · ${mb} MB`);
  console.log("\nCommit it. The app serves this file directly — there is no runtime dependency on");
  console.log("either upstream, and `git diff` shows what changed between refreshes.");
})();
