#!/usr/bin/env node
/*
 * build-airfields.js — download OurAirports and emit the trimmed reference file the proxy loads.
 *
 * RUN:  cd ~/streetwatch-proxy && node build-airfields.js
 * OUT:  airfields.json.gz   (~2 MB, committed to the repo)
 *
 * Re-run occasionally; OurAirports rebuilds nightly. There is no need to track it closely — the
 * point is a stable reference layer, not a live feed, and a file in the repo cannot fail at
 * startup the way a network fetch can.
 *
 * SOURCE: OurAirports, PUBLIC DOMAIN (CC0). Founded 2007 to fill the gap left when public access
 * to the US DAFIF service was shut down in 2006. FAA-derived for US fields.
 *
 * WHY NOT GOOGLE MAPS: their Platform terms prohibit storing or redistributing place names and
 * coordinates to build a derivative database. Two public repos heading to production is the wrong
 * place to test that. OurAirports is the same data, legally usable, and already has elevation.
 *
 * WHAT IS KEPT AND WHY:
 *   name, ident   — for LEGIBILITY. A contact near a grid cell currently reads
 *                   "Deep sweep 30.5N 88.1W"; it should read "Mobile Downtown Airport, 5.8nm".
 *   lat, lon      — 5 decimal places, ~1.1 m. Far finer than any use here needs.
 *   elevation_ft  — THE POINT OF THE EXERCISE. Present on 83% of records. alt_ft in the archive is
 *                   BAROMETRIC (above sea level), so every altitude ceiling means something
 *                   different at every field: 1,000ft admits parked aircraft at a coastal base and
 *                   excludes parked aircraft at Kabul (5,877ft).
 *   type          — packed to one byte. Distinguishes a runway from a heliport, which matters when
 *                   deciding whether a candidate site can explain fixed-wing activity.
 *   iso_country   — for labelling. NOTE the archive's own `country` field is the WATCHING SITE's
 *                   country, not the contact's; that bug produced "Ireland" for a cluster in
 *                   Shropshire. Country must come from the reference record, never from the site.
 *
 * CLOSED AIRFIELDS ARE KEPT. They are wrong for naming — nothing operates there — but they are
 * still valid GROUND ELEVATION samples, which is what the terrain-roughness check needs. The
 * runtime module filters them out of naming and keeps them for elevation.
 */

const https = require("https");
const fs = require("fs");
const zlib = require("zlib");

const URL = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv";
const OUT = "airfields.json.gz";

// packed type codes — kept stable, the runtime module maps them back
const TYPE = { small_airport: 0, heliport: 1, closed: 2, medium_airport: 3, seaplane_base: 4, large_airport: 5 };

const get = (url) => new Promise((res, rej) => {
  https.get(url, (r) => {
    if (r.statusCode === 301 || r.statusCode === 302) return get(r.headers.location).then(res, rej);
    if (r.statusCode !== 200) return rej(new Error("HTTP " + r.statusCode));
    let b = ""; r.setEncoding("utf8");
    r.on("data", (c) => (b += c)); r.on("end", () => res(b));
  }).on("error", rej);
});

function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch !== "\r") cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length)
             .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

(async () => {
  process.stdout.write("downloading OurAirports (~12 MB) ... ");
  const csv = await get(URL);
  console.log("done");

  const all = parseCsv(csv).filter((a) =>
    a.latitude_deg && a.longitude_deg && a.type !== "balloonport");

  const out = all.map((a) => [
    a.name,
    a.ident || "",
    TYPE[a.type] ?? 9,
    Math.round(+a.latitude_deg * 1e5) / 1e5,
    Math.round(+a.longitude_deg * 1e5) / 1e5,
    a.elevation_ft === "" ? null : Math.round(+a.elevation_ft),
    a.iso_country || "",
  ]);

  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 });
  fs.writeFileSync(OUT, gz);

  const byType = {};
  all.forEach((a) => (byType[a.type] = (byType[a.type] || 0) + 1));
  const withEl = out.filter((r) => r[5] !== null).length;

  console.log(`\nwrote ${OUT} — ${(gz.length / 1e6).toFixed(2)} MB gzipped`);
  console.log(`${out.length.toLocaleString()} records, ${new Set(all.map((a) => a.iso_country)).size} countries`);
  Object.entries(byType).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  ${k}`));
  console.log(`\nelevation present on ${withEl.toLocaleString()} (${(100 * withEl / out.length).toFixed(0)}%)`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
