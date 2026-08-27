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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
    try {
      const rows = await osmCountry(iso, label);
      records.push(...rows);
      bySource[`osm:${iso}`] = rows.length;
      console.log(`${rows.length}`);
    } catch (e) {
      console.log(`FAILED — ${e.message}`);
    }
    // Overpass is a free shared service. Pausing between countries is the difference between being
    // a considerate consumer and being throttled.
    await sleep(4000);
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
    },
    counts: bySource,
    total: records.length,
    records,
  };

  fs.writeFileSync(OUT, JSON.stringify(payload));
  const mb = (fs.statSync(OUT).size / 1048576).toFixed(2);
  console.log(`\nwrote ${OUT}`);
  console.log(`${records.length.toLocaleString()} records · ${mb} MB`);
  console.log("\nCommit it. The app serves this file directly — there is no runtime dependency on");
  console.log("either upstream, and `git diff` shows what changed between refreshes.");
})();
