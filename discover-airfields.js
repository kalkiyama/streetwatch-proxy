#!/usr/bin/env node
/*
 * discover-airfields.js — find places where military aircraft repeatedly operate AT GROUND LEVEL,
 * from how they behave, not from any register.
 *
 * WHAT IT ACTUALLY FINDS — established Jul 30, and it is broader than the name suggests.
 * The first candidate to survive every filter was -40.2068, 175.2150 in New Zealand: two clusters
 * 0.88nm apart, both at ground level, 5 airframes over 5 days, nothing catalogued within 15nm.
 * It is RAUMAI AIR WEAPONS RANGE, on the coast west of RNZAF Ohakea. NZDF describes NH90 gunnery
 * and live-firing there day and night, AND a field exercise where NH90s LANDED to be loaded with
 * flares. So aircraft genuinely land there — the ground-level clusters are literal landings.
 * It is absent from all 85,809 OurAirports records, CORRECTLY: it is not an airfield.
 * So the output covers airfields, weapons ranges, landing zones, forward loading points and
 * low-level training areas. A cluster that matches no airfield is NOT a failed detection — it may
 * be a real site of a different KIND. Read the unmatched list as "ground-level military activity
 * with no airfield to explain it", never as "an airfield the databases missed".
 *
 * RUN:  cd ~/streetwatch-proxy
 *       node discover-airfields.js                 # uses $DATABASE_URL
 *       node discover-airfields.js --days 90 --min-events 3
 *
 * WHAT IT DOES
 * Aircraft that land stop transmitting at a point. Aircraft that depart start transmitting at
 * a point. A real airfield produces BOTH, tightly clustered, at low altitude and low speed. So
 * the airfield can be inferred from the traffic without any list saying it exists.
 *
 * THE CONFOUND THAT KILLS THE NAIVE VERSION
 * A track "ending" in this archive is usually NOT a landing — it is the sweep moving on. One
 * site is polled every 15s on rotation, so any aircraft is unobserved most of the time, and a
 * naive last-row-per-track clusters polling gaps, not landings.
 *
 * THE CONTROL
 * Use each SITE's own row history as an observation clock. If site S recorded OTHER aircraft at
 * timestamps after aircraft A's last row at S, then observation demonstrably continued and A
 * genuinely stopped being visible. That is the difference between "we stopped looking" and "it
 * stopped being there", and without it none of the output means anything.
 *
 * SECOND CONFOUND: RADIO HORIZON
 * Aircraft also vanish below line-of-sight, and low altitude is exactly where reception fails.
 * A coverage edge produces disappearances ALONG AN ARC, at altitude, with NO matching
 * appearances. A real field produces both, at a POINT, slow and low. The appear/disappear ratio
 * and the spatial spread are the separators — see SCORING.
 *
 * WHAT THIS CAN AND CANNOT FIND
 * The archive holds MILITARY AND UAV contacts only. So this finds airfields used by military or
 * UAV traffic. It says nothing about civil-only strips, and absence here means "no military or
 * UAV traffic was observed landing", never "no airfield".
 */

const { Pool } = require("pg");
const fs = require("fs");
const https = require("https");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };

const DAYS        = Number(opt("days", 90));
const GAP_MIN     = Number(opt("gap-min", 240));   // minutes of silence that ends a segment.
                                                   // MUST exceed the sweep's own revisit interval: cold
                                                   // sites are polled every ~2.5h, so a smaller value makes
                                                   // every poll look like a new arrival. At 25min a single
                                                   // PARKED aircraft produced 123 phantom events at one point.
// LOW_FT (barometric, 3000ft) WAS the fallback wherever ground level could not be established.
// Removed Aug 1: falling back to a LOOSER rule where we knew LESS made the tool measurably worse
// — candidates 42 -> 61, validation 93% -> 92%. Endpoints with no usable ground level are now
// DISCARDED, so nothing reads this. Found dead by eslint on its first run in this repo.
const LOW_AGL_FT  = Number(opt("low-agl", 500));   // endpoint ceiling ABOVE FIELD — the real filter
const GROUND_REF_NM = Number(opt("ground-ref-nm", 15));  // how far to look for a ground-elevation proxy
const SLOW_KT     = Number(opt("slow-kt", 200));   // endpoint speed ceiling
const CELL_DEG    = Number(opt("cell", 0.02));     // ~1.2nm clustering cell
const MIN_EVENTS  = Number(opt("min-events", 3));  // events before a cluster is reported
const MATCH_NM    = Number(opt("match-nm", 3));    // distance to call it "the same airfield"

const AIRPORTS_CSV = "airports.csv";
const AIRPORTS_URL =
  "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv";

const nm = (a, b, c, d) => {
  const r = (x) => (x * Math.PI) / 180, dLa = r(c - a), dLo = r(d - b);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLo / 2) ** 2;
  return 2 * (6371.0088 / 1.852) * Math.asin(Math.sqrt(h));
};

function download(url, dest) {
  return new Promise((res, rej) => {
    const f = fs.createWriteStream(dest);
    https.get(url, (r) => {
      if (r.statusCode === 302 || r.statusCode === 301) return download(r.headers.location, dest).then(res, rej);
      if (r.statusCode !== 200) return rej(new Error("HTTP " + r.statusCode));
      r.pipe(f); f.on("finish", () => f.close(res));
    }).on("error", rej);
  });
}

// Minimal CSV reader — the file is well-formed and quoted, no need for a dependency.
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
  // ---------- 1. reference list ----------
  if (!fs.existsSync(AIRPORTS_CSV)) {
    process.stdout.write("downloading OurAirports (~12 MB) ... ");
    await download(AIRPORTS_URL, AIRPORTS_CSV);
    console.log("done");
  }
  const known = parseCsv(fs.readFileSync(AIRPORTS_CSV, "utf8"))
    .filter((a) => a.latitude_deg && a.longitude_deg && a.type !== "closed")
    .map((a) => ({
      name: a.name, type: a.type, country: a.iso_country, ident: a.ident,
      lat: +a.latitude_deg, lon: +a.longitude_deg,
      elev: a.elevation_ft ? +a.elevation_ft : null,
    }));
  console.log(`reference : ${known.length.toLocaleString()} open airfields, ${new Set(known.map(k=>k.country)).size} countries\n`);

  // Coarse spatial index so 85k x N stays fast.
  const kIdx = new Map();
  const kkey = (la, lo) => `${Math.floor(la)}|${Math.floor(lo)}`;
  known.forEach((k) => {
    for (const dla of [-1, 0, 1]) for (const dlo of [-1, 0, 1]) {
      const key = kkey(k.lat + dla, k.lon + dlo);
      if (!kIdx.has(key)) kIdx.set(key, []);
      kIdx.get(key).push(k);
    }
  });
  const nearestKnown = (la, lo) => {
    let best = null, bd = Infinity;
    for (const k of kIdx.get(kkey(la, lo)) || []) {
      const d = nm(la, lo, k.lat, k.lon);
      if (d < bd) { bd = d; best = k; }
    }
    return best ? { ...best, distNm: bd } : null;
  };

  // TERRAIN ROUGHNESS, used to decide whether a ground-elevation PROXY is trustworthy.
  // Two different effects produce a negative height-above-field and they OVERLAP in range, so no
  // fixed cutoff can separate them:
  //   1. BAROMETRIC PRESSURE. ADS-B sends pressure altitude referenced to 1013.25 hPa, not local
  //      QNH. At ~27ft per hPa and a real-world range of ~980-1040, a parked aircraft at a
  //      sea-level field genuinely reads anywhere from about +1,400ft to -720ft. Laughlin at
  //      -32ft and North Island at -26ft are exactly this, and both are correct detections.
  //   2. A BAD GROUND PROXY. Using the nearest airfield's elevation assumes flat terrain. At
  //      Los Alamos — an airfield on a MESA at 7,171ft, with the valley far below — a cluster
  //      came out at -946ft AGL. Nothing is wrong with the aircraft; the reference is wrong.
  // Rejecting on the NUMBER would discard case 1 along with case 2. Rejecting on the CAUSE works:
  // if the reference airfields within range disagree wildly about their own elevation, the
  // terrain is not flat and no single-field proxy means anything there.
  //   Laughlin neighbourhood: everything ~1,000-1,100ft. spread small, proxy sound.
  //   Los Alamos neighbourhood: 6,348 / 6,433 / 7,012 / 7,171 / 7,200. spread 852ft, proxy void.
  const ROUGH_FT = Number(opt("rough-ft", 500));
  const terrainSpread = (la, lo, withinNm) => {
    const el = [];
    for (const k of kIdx.get(kkey(la, lo)) || [])
      if (k.elev != null && nm(la, lo, k.lat, k.lon) <= withinNm) el.push(k.elev);
    if (el.length < 2) return 0;              // nothing to disagree with
    return Math.max(...el) - Math.min(...el);
  };

  // ---------- 2. archive ----------
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // THE OBSERVATION CLOCK, BOTH ENDS. A disappearance only counts if the site kept recording
  // AFTER it; an appearance only counts if the site was already recording BEFORE it.
  // The second half did not exist. The comment beside the emerge test claimed it did — "only if
  // the site was already recording before it showed up" — and the code counted every low, slow
  // first row unconditionally. So an "emerge" fired whenever the SWEEP STARTED WATCHING a site,
  // which is not a departure, and departures were systematically over-counted against arrivals.
  // Two numbers measured differently. A panel reading "6 arrivals · 4 departures" would have been
  // comparing a controlled figure with an uncontrolled one.
  const { rows: clock } = await pool.query(
    `SELECT site, min(ts) AS first_ts, max(ts) AS last_ts FROM drone_tracks
      WHERE ts > now() - ($1||' days')::interval GROUP BY site`, [String(DAYS)]);
  const siteLast = new Map(clock.map((r) => [r.site, new Date(r.last_ts).getTime()]));
  const siteFirst = new Map(clock.map((r) => [r.site, new Date(r.first_ts).getTime()]));

  const { rows } = await pool.query(
    `SELECT icao, ts, lat, lon, alt_ft, speed_kt, site, country, kind
       FROM drone_tracks
      WHERE ts > now() - ($1||' days')::interval
      ORDER BY icao, ts`, [String(DAYS)]);
  await pool.end();
  console.log(`archive   : ${rows.length.toLocaleString()} rows · ${new Set(rows.map(r=>r.icao)).size.toLocaleString()} airframes · ${siteLast.size} sites reporting\n`);
  if (!rows.length) { console.log("nothing to analyse"); return; }

  // ---------- 3. segment tracks, extract endpoints ----------
  const GAP_MS = GAP_MIN * 60000, OBS_MS = GAP_MS;
  const events = [];
  // hoisted out of flush(): these count across the WHOLE run, not per segment
  let noGroundRef = 0, roughTerrain = 0;
  let seg = [];
  const flush = () => {
    if (!seg.length) return;
    const first = seg[0], last = seg[seg.length - 1];
    // HEIGHT ABOVE FIELD, not barometric altitude. alt_ft is above SEA LEVEL, so a flat ceiling
    // means completely different things at different places: 3,000ft admits anything under
    // 2,700ft AGL at a 300ft coastal field, and excludes aircraft PARKED at Kabul (5,877ft).
    // The first run of this script showed the cost directly — roughly half the candidates were
    // aircraft leaving coverage in level flight at 1,600-1,900ft AGL, not landing.
    //
    // There is no terrain dataset here, so ground level is taken from the NEAREST REFERENCE
    // AIRFIELD's elevation. That is a PROXY, and it is stated as one: terrain varies slowly over
    // 15nm in most places, but in mountainous country it will be wrong, and where no reference
    // field is within GROUND_REF_NM the barometric fallback applies and the event is counted
    // separately so the fallback's share is visible rather than assumed small.
    const groundAt = (la, lo) => {
      const k = nearestKnown(la, lo);
      return k && k.distNm <= GROUND_REF_NM && k.elev != null ? k.elev : null;
    };
    const lowSlow = (r) => {
      if (r.alt_ft == null) return false;
      if (r.speed_kt != null && r.speed_kt >= SLOW_KT) return false;
      // NO GUESSING. The first attempt at this fell back to a LOOSER barometric ceiling wherever
      // AGL could not be established — 3,000ft instead of 500ft AGL — which made the filter MORE
      // permissive exactly where we knew LESS. Measured cost: ground-reference coverage fell to
      // 43%, endpoints rose 10,635 -> 12,984, candidates 42 -> 61, validation 93% -> 92%. The
      // transit cases the AGL filter exists to remove came straight back in through the fallback.
      // If height above ground is unknown, a landing cannot be told from an overflight, so the
      // endpoint is DISCARDED. That loses coverage in mountains — where unlisted strips are most
      // likely — and it is the correct trade, because a candidate you cannot trust is worse than
      // one you never saw. The excluded counts are printed so the loss is visible, not silent.
      const g = groundAt(r.lat, r.lon);
      if (g == null) { noGroundRef++; return false; }
      if (terrainSpread(r.lat, r.lon, GROUND_REF_NM) > ROUGH_FT) { roughTerrain++; return false; }
      r._aglFt = r.alt_ft - g;
      r._groundFt = g;
      return r._aglFt < LOW_AGL_FT;
    };

    // DISAPPEARANCE — only if the site demonstrably kept observing afterwards.
    const lastSeen = siteLast.get(last.site);
    if (lowSlow(last) && lastSeen && lastSeen - new Date(last.ts).getTime() > OBS_MS)
      events.push({ ...last, ev: "vanish" });

    // APPEARANCE — and NOW it really is only if the site was already recording before it showed
    // up. Same clock as the disappearance test above, run backwards.
    const firstSeen = siteFirst.get(first.site);
    if (lowSlow(first) && firstSeen && new Date(first.ts).getTime() - firstSeen > OBS_MS)
      events.push({ ...first, ev: "emerge" });
    seg = [];
  };
  let prev = null;
  for (const r of rows) {
    if (prev && (r.icao !== prev.icao || new Date(r.ts) - new Date(prev.ts) > GAP_MS)) flush();
    seg.push(r); prev = r;
  }
  flush();
  const withAgl = events.filter((e) => e._aglFt != null).length;
  console.log(`endpoints : ${events.filter(e=>e.ev==="vanish").length} disappearances · ${events.filter(e=>e.ev==="emerge").length} appearances`);
  console.log(`filter    : under ${LOW_AGL_FT}ft ABOVE FIELD and under ${SLOW_KT}kt · ${withAgl}/${events.length} had a ground reference within ${GROUND_REF_NM}nm`);
  console.log(`            DISCARDED for unknown ground level: ${noGroundRef} no reference within ${GROUND_REF_NM}nm, ${roughTerrain} rough terrain (>${ROUGH_FT}ft spread)`);
  console.log(`            AGL is PRESSURE altitude minus a proxy ground level: expect +/-800ft of error from QNH alone\n`);

  // ---------- 4. cluster ----------
  const cells = new Map();
  for (const e of events) {
    const key = `${Math.round(e.lat / CELL_DEG)}|${Math.round(e.lon / CELL_DEG)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(e);
  }

  const clusters = [];
  for (const [, evs] of cells) {
    if (evs.length < MIN_EVENTS) continue;
    const lat = evs.reduce((s, e) => s + e.lat, 0) / evs.length;
    const lon = evs.reduce((s, e) => s + e.lon, 0) / evs.length;
    const vanish = evs.filter((e) => e.ev === "vanish").length;
    const emerge = evs.filter((e) => e.ev === "emerge").length;
    const alts = evs.map((e) => e.alt_ft).filter((x) => x != null).sort((a, b) => a - b);
    const spread = Math.max(...evs.map((e) => nm(lat, lon, e.lat, e.lon)));
    clusters.push({
      lat, lon, n: evs.length, vanish, emerge,
      icaos: new Set(evs.map((e) => e.icao)).size,
      // RAW EVENT COUNT IS NOT EVIDENCE. One aircraft re-observed on every sweep pass inflates it
      // without adding a single new fact. Distinct airframes x distinct days is the real weight.
      days: new Set(evs.map((e) => new Date(e.ts).toISOString().slice(0, 10))).size,
      medAlt: alts.length ? alts[Math.floor(alts.length / 2)] : null,
      medAgl: (() => { const g = evs.map((e) => e._aglFt).filter((x) => x != null).sort((a, b) => a - b);
                       return g.length ? g[Math.floor(g.length / 2)] : null; })(),
      spreadNm: spread,
      // NOT the cluster's country — this is the country of the WATCHING SITE. It produced
      // "Ireland" for a cluster 3.1nm from RAF Shawbury, "Croatia" for one in Austria, and
      // "Luxembourg" for one beside Nörvenich Air Base. Country is set from the nearest
      // reference airfield below instead.
      siteCountry: evs[0].country,
      // SCORING. balance near 1 => both arrivals and departures => a place aircraft USE.
      // balance near 0 => disappearances only => radio horizon, not an airfield.
      balance: vanish + emerge ? Math.min(vanish, emerge) / Math.max(vanish, emerge) : 0,
    });
  }

  // ---------- 5. classify and report ----------
  const scored = clusters.map((c) => {
    const k = nearestKnown(c.lat, c.lon);
    // Report the nearest reference airfield ALWAYS, not only inside MATCH_NM. The first run listed
    // RAF Shawbury (3.1nm), Sleap (3.4nm) and Nörvenich Air Base (3.5nm) under "nothing within 3nm
    // in 72,444 records" — true as written, false as read. A near-miss on the match radius is not
    // a discovery, and nobody can tell the two apart unless the distance is on the line.
    c.nearest = k;
    c.country = k ? k.country : "";
    // BALANCE WAS A GOOD HYPOTHESIS AND THE DATA FALSIFIED IT (Jul 27). The first run rejected
    // Quonset State (8 aircraft, 3 days, 0.26nm from the real field) and Albuquerque Sunport
    // (7 aircraft, 4 days, 0.29nm) as "horizon-like" purely on balance: 9v/1e and 0v/7e.
    // Both are unambiguously airfields. Arrivals and departures are NOT captured symmetrically —
    // partly a real asymmetry, partly mine, since disappearances must pass the observation-clock
    // test and appearances have no equivalent gate. So balance is REPORTED, never gating.
    // SPREAD is what actually discriminates: real fields cluster inside ~0.5nm, a radio horizon
    // smears along an arc. Distinct airframes and distinct days carry the weight.
    const airfieldLike = c.spreadNm <= 1.5 && c.icaos >= 2 && c.days >= 2;
    return { ...c, known: k && k.distNm <= MATCH_NM ? k : null, airfieldLike };
  }).sort((a, b) => b.icaos - a.icaos || b.days - a.days);

  const confirmed = scored.filter((c) => c.airfieldLike && c.known);
  const candidate = scored.filter((c) => c.airfieldLike && !c.known);
  const horizon   = scored.filter((c) => !c.airfieldLike);

  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : "—");
  console.log("═".repeat(78));
  console.log(`CLUSTERS ${scored.length} · airfield-like ${confirmed.length + candidate.length} · horizon-like ${horizon.length}`);
  console.log(`VALIDATION: ${confirmed.length}/${confirmed.length + candidate.length} (${pct(confirmed.length, confirmed.length + candidate.length)}) of clusters match a KNOWN airfield within ${MATCH_NM}nm.`);
  console.log("This measures ENDPOINT DETECTION, not completeness. A high figure means the clustering");
  console.log("finds real places. It does NOT mean the unmatched remainder are errors — see below.");
  console.log("If that number is high, the method works. If it is low, the method is finding noise —");
  console.log("read the candidates as suspect, not as discoveries.");
  console.log("═".repeat(78));

  const show = (c) => {
    console.log(
      `  ${c.lat.toFixed(4)},${c.lon.toFixed(4)}  ${String(c.icaos).padStart(2)}ac/${String(c.days).padStart(2)}d ` +
      `(${c.vanish}v/${c.emerge}e bal ${c.balance.toFixed(2)}) ${String(c.n).padStart(4)}ev ` +
      `spread ${c.spreadNm.toFixed(1)}nm ${c.medAgl != null ? `AGL~${c.medAgl}ft` : `alt~${c.medAlt ?? "?"}ft(baro)`}  ${c.country || ""}` +
      (c.nearest
        ? `\n        ↳ ${c.known ? "MATCH" : "NEAREST"}: ${c.nearest.name} (${c.nearest.ident}, ${c.nearest.type}, `
          + `${c.nearest.distNm.toFixed(2)}nm, elev ${c.nearest.elev ?? "?"}ft)`
        : "\n        ↳ nothing in the reference set nearby")
    );
  };

  console.log(`\n── CONFIRMED — the method rediscovered a known airfield (${confirmed.length}) ──`);
  confirmed.slice(0, 25).forEach(show);

  console.log(`\n── UNMATCHED — ground-level activity with NO airfield within ${MATCH_NM}nm (${candidate.length}) ──`);
  console.log("   NOT failed airfield detections. These are places aircraft repeatedly reach ground level");
  console.log("   where no catalogued airfield explains it — which is how RAUMAI AIR WEAPONS RANGE was");
  console.log("   found. Ranges, landing zones and training areas are legitimately absent from airfield");
  console.log("   registers. Each line shows its nearest known airfield regardless of distance: one at");
  console.log("   3.1nm is a NEAR-MISS on --match-nm, not a finding. Verify the far ones before claiming.");
  candidate.slice(0, 25).forEach(show);

  console.log(`\n── HORIZON-LIKE — rejected as coverage edge, not airfield (${horizon.length}) ──`);
  horizon.slice(0, 8).forEach(show);

  console.log(`\nRERUN TIGHTER:  node discover-airfields.js --low-ft 1500 --slow-kt 150 --min-events 5`);
  console.log(`NOTE: alt_ft is BAROMETRIC (above sea level). For clusters matched to a known airfield the`);
  console.log(`      reference elevation is printed above — subtract it to get true height above field.`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
