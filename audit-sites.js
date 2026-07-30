#!/usr/bin/env node
/*
 * audit-sites.js — find military airfields the watch list is MISSING, using observed activity.
 *
 * RUN:  cd ~/streetwatch-proxy && node audit-sites.js
 *       node audit-sites.js --days 7 --min-terminal 3
 *
 * WHY THIS METHOD. The regional audit was previously framed as "pick a country, list its military
 * airfields from a reference source, diff against SITES". That is a lot of work per country and it
 * finds airfields whether or not anything ever flies there.
 * This inverts it: take the sites where the sweep has ACTUALLY RECORDED terminal activity, find the
 * nearest military-named airfield to each, and report the ones that are not in SITES. Every result
 * arrives with evidence attached — N terminal contacts — instead of a name in a database.
 *
 * IT WORKS BECAUSE THE DEEP GRID FINALLY RUNS. Before Jul 29 the grid received zero slots and
 * gridPromoted stood at 4 of 799 for the project's whole history. Within 36 hours of the per-tier
 * floor fix it reached 99. Those 95 newly-productive cells are exactly the places the named list
 * does not cover — which is what the grid was built to find and had never been allowed to do.
 *
 * FIRST RESULT FROM THIS METHOD, found by hand: Deep sweep 30.5N 88.1W, 16 terminal contacts,
 * 7.8nm from Mobile Downtown (Brookley Field) — home of COAST GUARD AVIATION TRAINING CENTER
 * MOBILE, absent from SITES. Nearby and also absent: NAS Whiting Field, NAS Pensacola, Keesler AFB.
 *
 * HONEST LIMITS, both of which matter when reading the output:
 *  - "Military-named" is a NAME HEURISTIC over OurAirports. It will miss bases whose names do not
 *    say so, and it will match civil fields with military-sounding names. It is a shortlist to
 *    check, never a conclusion.
 *  - Terminal contacts near a GRID CELL are aircraft low and close to an arbitrary point, not
 *    proof of an airfield there. The named airfield in the output is the CANDIDATE explanation.
 *    Verify against imagery before adding anything.
 */

const https = require("https");
const fs = require("fs");
const { SITES } = require("./drone-sweep.js");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const DAYS         = Number(opt("days", 7));
const MIN_TERMINAL = Number(opt("min-terminal", 1));
const NEAR_SITE_NM = Number(opt("near-site-nm", 15));   // already covered if this close to a site
const MATCH_NM     = Number(opt("match-nm", 12));       // how far to look for an explaining airfield

const PROXY = "https://streetwatch-proxy.onrender.com";
const AIRPORTS_CSV = "airports.csv";
const AIRPORTS_URL = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv";

const MIL = [
  "air force base", "air base", " afb", "naval air", " nas ", "marine corps", "mcas",
  "army airfield", " aaf", "army air", "coast guard", "air station", "raf ", "military",
  "outlying landing", "auxiliary field", "stagefield", "joint base",
];

const nm = (a, b, c, d) => {
  const r = (x) => (x * Math.PI) / 180, dLa = r(c - a), dLo = r(d - b);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLo / 2) ** 2;
  return 2 * (6371.0088 / 1.852) * Math.asin(Math.sqrt(h));
};

const get = (url) => new Promise((res, rej) => {
  https.get(url, (r) => {
    if (r.statusCode === 301 || r.statusCode === 302) return get(r.headers.location).then(res, rej);
    let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res(b));
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
  if (!fs.existsSync(AIRPORTS_CSV)) {
    process.stdout.write("downloading OurAirports (~12 MB) ... ");
    fs.writeFileSync(AIRPORTS_CSV, await get(AIRPORTS_URL));
    console.log("done");
  }
  const all = parseCsv(fs.readFileSync(AIRPORTS_CSV, "utf8"))
    .filter((a) => a.latitude_deg && a.type !== "closed" && a.type !== "balloonport")
    .map((a) => ({ name: a.name, ident: a.ident, type: a.type, country: a.iso_country,
                   lat: +a.latitude_deg, lon: +a.longitude_deg,
                   elev: a.elevation_ft ? +a.elevation_ft : null }));
  const mil = all.filter((a) => MIL.some((k) => (" " + a.name.toLowerCase() + " ").includes(k)));
  console.log(`reference : ${all.length.toLocaleString()} airfields, ${mil.length.toLocaleString()} military-named\n`);

  const heat = JSON.parse(await get(`${PROXY}/api/drones/heat?days=${DAYS}`));
  const sites = Array.isArray(heat) ? heat : (heat.sites || heat.data || []);
  const named = SITES.filter((s) => s[1] !== "Deep sweep");
  console.log(`archive   : ${sites.length} sites with rows over ${DAYS}d · ${named.length} named sites in the watch list\n`);

  const out = [];
  for (const s of sites) {
    const term = s.terminal_contacts || 0;
    if (term < MIN_TERMINAL) continue;
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;

    // already covered? nearest NAMED watch site
    let dNamed = Infinity, nearestNamed = null;
    for (const n of named) {
      const d = nm(s.lat, s.lon, n[2], n[3]);
      if (d < dNamed) { dNamed = d; nearestNamed = n[0]; }
    }
    if (dNamed <= NEAR_SITE_NM) continue;   // a named site already owns this area

    // WHAT COULD EXPLAIN THE TERMINAL ACTIVITY?
    // DO NOT filter by military-sounding name. The first run of this script did, and it missed
    // MOBILE DOWNTOWN AIRPORT (Brookley Field) at 5.8nm — home of Coast Guard Aviation Training
    // Center Mobile — because the airfield's NAME is civil. It reported "no military-named
    // airfield within 12nm" for the one case that motivated writing the script. Military units
    // are routinely hosted at civil-named fields, so the name says nothing about the operator.
    // Report every runway-capable field nearby and let a person judge; flag the military-named
    // ones as a hint, never as the filter.
    const runway = new Set(["small_airport", "medium_airport", "large_airport"]);
    const nearby = all
      .filter((a) => runway.has(a.type))
      .map((a) => ({ ...a, d: nm(s.lat, s.lon, a.lat, a.lon) }))
      .filter((a) => a.d <= MATCH_NM)
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);
    out.push({ site: s.site, lat: s.lat, lon: s.lon, term, contacts: s.contacts,
               nearestNamed, dNamed, nearby });
  }
  out.sort((a, b) => b.term - a.term);

  console.log("=".repeat(84));
  console.log(`CANDIDATE GAPS — terminal activity >= ${MIN_TERMINAL}, and no named watch site within ${NEAR_SITE_NM}nm`);
  console.log("=".repeat(84));
  if (!out.length) { console.log("none — the named list covers everywhere the archive shows terminal activity"); return; }

  for (const o of out) {
    console.log(`\n${o.site}  (${o.lat.toFixed(3)}, ${o.lon.toFixed(3)})`);
    console.log(`   ${o.term} terminal of ${o.contacts} contacts · nearest watch site: ${o.nearestNamed} at ${o.dNamed.toFixed(0)}nm`);
    if (o.nearby.length) {
      console.log(`   runway-capable fields within ${MATCH_NM}nm:`);
      for (const a of o.nearby) {
        const flag = MIL.some((k) => (" " + a.name.toLowerCase() + " ").includes(k)) ? "  [military-named]" : "";
        console.log(`     ${a.d.toFixed(1).padStart(5)}nm  ${a.name.slice(0, 46).padEnd(46)} ${a.type.padEnd(15)} elev ${a.elev ?? "?"}ft${flag}`);
      }
    } else {
      console.log(`   NO runway-capable field within ${MATCH_NM}nm — likely low transit, not an airfield.`);
    }
  }
  console.log(`\n${out.length} candidate(s). Verify each against imagery before adding to SITES.`);
  console.log(`Then run the spacing check against ALL entries — including deep cells — before committing.`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
