// StreetWatch — durable archive of public military / UAV aircraft tracks.
//
// SCOPE, deliberately narrow: only contacts the sweep classifies as `uav` or
// `military` are stored. Civil aviation and all vessel traffic are NEVER
// archived — tracking private aircraft and yachts over months would build a
// pattern-of-life record on private individuals. Military and government
// aircraft are public assets, publicly funded, broadcasting unencrypted in
// public airspace, which is why they are the one category worth a permanent
// public record.
//
// No user data of any kind is stored here: no IPs, no queries, no accounts.
//
// The archive is OPTIONAL. With no DATABASE_URL the module disables itself and
// every function becomes a safe no-op, so local dev and CI run without a database.

const RETAIN_DAYS = Number(process.env.ARCHIVE_RETAIN_DAYS || 90);
// Hard ceiling as well as the time limit: whichever bites first wins. Sized so the
// table stays well inside a free-tier Postgres (~250 bytes/row incl. indexes).
const MAX_ROWS = Number(process.env.ARCHIVE_MAX_ROWS || 1200000);
// Writes are BATCHED, not streamed. A serverless Postgres (Neon) bills compute time and
// suspends when idle — a trickle of single-row inserts would keep it awake 24/7 and burn
// the whole free allowance. Buffering in memory and flushing every few minutes lets the
// database sleep between flushes, cutting compute time by roughly an order of magnitude.
const FLUSH_MS = Number(process.env.ARCHIVE_FLUSH_MS || 10 * 60 * 1000);  // flush every 10 min
const FLUSH_MAX = Number(process.env.ARCHIVE_FLUSH_MAX || 400);           // ...or when the buffer fills
const URL = process.env.DATABASE_URL || "";

let pool = null;
let ready = false;
let writes = 0, writeErrors = 0, flushes = 0;
let buffer = [];

async function init() {
  if (ready) return true;                  // idempotent: safe to call from both boot paths
  if (!URL) { console.log("[archive] disabled (no DATABASE_URL) — sweep stays in memory only"); return false; }
  let Pool;
  try { ({ Pool } = require("pg")); }
  catch { console.error("[archive] 'pg' not installed — archive disabled"); return false; }

  pool = new Pool({
    connectionString: URL,
    ssl: { rejectUnauthorized: false },   // managed Postgres (Neon/Supabase) terminates TLS
    max: 2,                               // small pool: this is a tiny service
    idleTimeoutMillis: 5000,              // release connections quickly so the compute can suspend
    allowExitOnIdle: true,
    connectionTimeoutMillis: 10000,
  });
  pool.on("error", (e) => console.error("[archive] idle client error:", e.message));

  try {
    // One table, one index. Positions only — nothing about anyone using the app.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS drone_tracks (
        id          BIGSERIAL PRIMARY KEY,
        icao        TEXT        NOT NULL,
        ts          TIMESTAMPTZ NOT NULL,
        lat         DOUBLE PRECISION NOT NULL,
        lon         DOUBLE PRECISION NOT NULL,
        alt_ft      INTEGER,
        speed_kt    INTEGER,
        heading     DOUBLE PRECISION,
        kind        TEXT        NOT NULL,
        confidence  TEXT,
        callsign    TEXT,
        type_code   TEXT,
        descr       TEXT,
        site        TEXT,
        site_dist_nm DOUBLE PRECISION,
        country     TEXT,
        pos_method  TEXT,      -- ADS-B | ADS-R | TIS-B | MLAT | ADS-C | Mode S
        pos_computed BOOLEAN   -- true when the position was NOT self-reported
      )`);
    // The table already exists in production, so the CREATE above is a no-op there — new columns
    // have to be added explicitly or the INSERT below fails on every write.
    await pool.query(`ALTER TABLE drone_tracks ADD COLUMN IF NOT EXISTS pos_method TEXT`);
    await pool.query(`ALTER TABLE drone_tracks ADD COLUMN IF NOT EXISTS pos_computed BOOLEAN`);
    await pool.query(`CREATE INDEX IF NOT EXISTS drone_tracks_icao_ts ON drone_tracks (icao, ts DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS drone_tracks_ts ON drone_tracks (ts DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS drone_tracks_site_ts ON drone_tracks (site, ts DESC)`);
    // Rows written before the callsign padding fix hold literal "@@@@@@@@" — the ADS-B unset
    // marker, stored as if it were an identifier. New writes are cleaned at the proxy, but the
    // 90-day archive would keep surfacing the old ones in track and path views until they aged
    // out. Idempotent: after the first run this matches nothing.
    await pool.query(`UPDATE drone_tracks SET callsign = NULL WHERE callsign ~ '^[@_[:space:]]*$'`);
    // existing deployments predate this column
    await pool.query(`ALTER TABLE drone_tracks ADD COLUMN IF NOT EXISTS site_dist_nm DOUBLE PRECISION`);
    ready = true;
    console.log(`[archive] connected · retaining ${RETAIN_DAYS} days`);
    prune();
    setInterval(prune, 6 * 60 * 60 * 1000);   // prune every 6h
    setInterval(flush, FLUSH_MS);             // batched writes
    process.on("SIGTERM", () => { flush().catch(() => {}); });  // don't lose the buffer on redeploy
    return true;
  } catch (e) {
    console.error("[archive] init failed:", e.message);
    return false;
  }
}

// Queue one observation. Nothing touches the database until flush().
function record(c) {
  if (!ready) return;
  if (c.kind !== "uav" && c.kind !== "military") return;   // scope guard
  buffer.push([
    c.id, c.lastSeen || Date.now(), c.lat, c.lon,
    Number.isFinite(c.altFt) ? Math.round(c.altFt) : null,
    Number.isFinite(c.groundSpeedKt) ? Math.round(c.groundSpeedKt) : null,
    Number.isFinite(c.headingDeg) ? c.headingDeg : null,
    c.kind, c.confidence || null, c.callsign || null, c.typeCode || null,
    c.desc || null, c.site || null, c.country || null,
    Number.isFinite(c.siteDistNm) ? c.siteDistNm : null,
    c.posMethod || null,
    typeof c.posComputed === "boolean" ? c.posComputed : null,
  ]);
  if (buffer.length >= FLUSH_MAX) flush();
}

// Write the buffer as ONE multi-row INSERT. Still fully parameterised.
async function flush() {
  if (!ready || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  const COLS = 17;   // keep in step with the INSERT column list below
  const values = batch.map((_, i) => {
    const b = i * COLS;
    const ph = [];
    for (let k = 1; k <= COLS; k++) ph.push("$" + (b + k));
    // ts arrives as epoch ms and is converted in SQL; every value is still a bound parameter
    return "(" + ph[0] + ", to_timestamp(" + ph[1] + "/1000.0), " + ph.slice(2).join(", ") + ")";
  }).join(", ");
  try {
    await pool.query(
      `INSERT INTO drone_tracks
        (icao, ts, lat, lon, alt_ft, speed_kt, heading, kind, confidence, callsign, type_code, descr, site, country, site_dist_nm, pos_method, pos_computed)
       VALUES ${values}`,
      batch.flat()
    );
    writes += batch.length; flushes++;
    console.log(`[archive] flushed ${batch.length} rows (batch ${flushes})`);
  } catch (e) {
    writeErrors++;
    console.error("[archive] flush failed:", e.message);
  }
}

async function prune() {
  if (!ready) return;
  try {
    // 1) age limit
    const r = await pool.query(`DELETE FROM drone_tracks WHERE ts < now() - ($1 || ' days')::interval`, [String(RETAIN_DAYS)]);
    if (r.rowCount) console.log(`[archive] pruned ${r.rowCount} rows older than ${RETAIN_DAYS}d`);

    // 2) size ceiling — drop the oldest rows beyond the cap so storage can never run away
    const { rows } = await pool.query(`SELECT count(*)::bigint AS c FROM drone_tracks`);
    const total = Number(rows[0].c);
    if (total > MAX_ROWS) {
      const excess = total - MAX_ROWS;
      const d = await pool.query(
        `DELETE FROM drone_tracks WHERE id IN (SELECT id FROM drone_tracks ORDER BY ts ASC LIMIT $1)`,
        [excess]
      );
      console.log(`[archive] over cap (${total} > ${MAX_ROWS}) — dropped ${d.rowCount} oldest rows`);
    }

    // 3) keep the table compact after big deletes
    if (r.rowCount || total > MAX_ROWS) await pool.query("VACUUM (ANALYZE) drone_tracks").catch(() => {});

    // 4) warn early if storage is filling
    const sz = await pool.query(`SELECT pg_total_relation_size('drone_tracks') AS bytes`);
    const mb = Number(sz.rows[0].bytes) / 1e6;
    if (mb > 350) console.warn(`[archive] table at ${mb.toFixed(0)}MB — approaching a typical 500MB free tier`);
  } catch (e) { console.error("[archive] prune failed:", e.message); }
}

// ---- read-only queries (public endpoint) ----

// Distinct contacts seen in a window, newest first.
async function history({ days = 7, kind = null, limit = 200 } = {}) {
  if (!ready) return null;
  const d = Math.min(Math.max(Number(days) || 7, 1), RETAIN_DAYS);
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const params = [String(d), lim];
  let kindSql = "";
  if (kind === "uav" || kind === "military") { kindSql = "AND kind = $3"; params.push(kind); }
  const { rows } = await pool.query(
    `SELECT icao, kind, confidence,
            max(callsign) AS callsign, max(type_code) AS type_code, max(descr) AS descr,
            min(ts) AS first_seen, max(ts) AS last_seen,
            count(*) AS points,
            (array_agg(site ORDER BY ts DESC))[1] AS last_site,
            (array_agg(country ORDER BY ts DESC))[1] AS last_country
       FROM drone_tracks
      WHERE ts > now() - ($1 || ' days')::interval ${kindSql}
      GROUP BY icao, kind, confidence
      ORDER BY max(ts) DESC
      LIMIT $2`,
    params
  );
  return rows;
}

// Full recorded path for one contact.
async function track(icao, days = 90) {
  if (!ready) return null;
  const d = Math.min(Math.max(Number(days) || 90, 1), RETAIN_DAYS);
  const { rows } = await pool.query(
    `SELECT ts, lat, lon, alt_ft, speed_kt, heading, site
       FROM drone_tracks
      WHERE icao = $1 AND ts > now() - ($2 || ' days')::interval
      ORDER BY ts ASC LIMIT 5000`,
    [String(icao).toLowerCase(), String(d)]
  );
  return rows;
}


// Activity per airspace over a window — the basis of the heat map.
// Intensity is measured from our own observations, not asserted from outside sources.
// Observed coverage — where StreetWatch has ACTUALLY recorded contacts, binned into a grid.
//
// This is the honest inverse of the archive: instead of "what did we see", it answers "where
// can we see at all". The gaps matter as much as the fills — an empty cell means no ADS-B
// reception, no sweep site nearby, or genuinely no traffic, and the three are indistinguishable
// from this data alone. That ambiguity is stated in the UI rather than smoothed over. This is
// derived entirely from our own observations; it models nothing and predicts nothing.
async function coverage({ days = 7, cell = 2 } = {}) {
  if (!ready) return null;
  const d = Math.min(Math.max(Number(days) || 7, 1), RETAIN_DAYS);
  const c = Math.min(Math.max(Number(cell) || 2, 1), 10);     // grid size in degrees
  const { rows } = await pool.query(
    `SELECT floor(lat / $2) * $2 AS lat0,
            floor(lon / $2) * $2 AS lon0,
            count(*)::int              AS points,
            count(DISTINCT icao)::int  AS aircraft,
            max(ts)                    AS last_seen
       FROM drone_tracks
      WHERE ts > now() - ($1 || ' days')::interval
      GROUP BY 1, 2
      ORDER BY count(*) DESC
      LIMIT 4000`,
    [String(d), c]
  );
  return rows.map((r) => ({
    lat: Number(r.lat0), lon: Number(r.lon0), cellDeg: c,
    points: r.points, aircraft: r.aircraft, lastSeen: r.last_seen,
  }));
}

async function heat({ days = 7, siteCoords = {} } = {}) {
  if (!ready) return null;
  const d = Math.min(Math.max(Number(days) || 7, 1), RETAIN_DAYS);

  // Near-count is computed from the lat/lon stored on EVERY row, not from the site_dist_nm
  // column. That column only exists on rows written since it was added, so filtering on it
  // made the heat map report ~0 near contacts while the digest — which computes from
  // coordinates — reported the true figure. Two endpoints disagreeing about the same
  // quantity is worse than either being slightly slower.
  const names = Object.keys(siteCoords);
  const lats = names.map((n) => siteCoords[n].lat);
  const lons = names.map((n) => siteCoords[n].lon);
  const NEAR_NM = 25;

  // Counts at three radii in ONE pass. The distance is computed once in a CTE and reused by
  // FILTER clauses, so switching radius in the UI needs no refetch — and the three numbers
  // side by side are the actual finding: 350 aircraft within 250nm of Eglin but 37 within
  // 25nm says something true that neither figure says alone.
  const sql = names.length
    ? `WITH j AS (
         SELECT t.icao, t.kind, t.site, t.country, t.ts, t.alt_ft,
                2 * 3440.065 * asin(sqrt(
                  power(sin(radians(t.lat - s.slat) / 2), 2) +
                  cos(radians(s.slat)) * cos(radians(t.lat)) *
                  power(sin(radians(t.lon - s.slon) / 2), 2))) AS dist_nm
           FROM drone_tracks t
           LEFT JOIN unnest($2::text[], $3::float8[], $4::float8[]) AS s(site, slat, slon)
                  ON s.site = t.site
          WHERE t.ts > now() - ($1 || ' days')::interval AND t.site IS NOT NULL
       ),
       -- Each aircraft's LOWEST observed altitude within 25nm. Counting distinct aircraft per
       -- band directly double-counts anything that descends (12,000ft on one sweep, 8,000 on the
       -- next appears in two bands) — which is why 72+5+0 read as 77 against a total of 76.
       -- Bucketing by the minimum gives exactly one band per aircraft, so the bands sum.
       lo AS (
         SELECT site, icao, min(alt_ft) AS min_alt
           FROM j
          WHERE dist_nm <= 25 AND alt_ft IS NOT NULL
          GROUP BY site, icao
       ),
       bands AS (
         SELECT site,
                count(*) FILTER (WHERE min_alt < 10000)::int                      AS low25,
                count(*) FILTER (WHERE min_alt >= 10000 AND min_alt < 25000)::int AS mid25,
                count(*) FILTER (WHERE min_alt >= 25000)::int                     AS high25
           FROM lo GROUP BY site
       )
       SELECT j.site AS site,
              max(country) AS country,
              count(*)::int AS points,
              count(DISTINCT icao)::int AS contacts,
              count(DISTINCT icao) FILTER (WHERE kind = 'uav')::int AS uav,
              count(DISTINCT icao) FILTER (WHERE kind = 'military')::int AS military,
              count(*) FILTER (WHERE dist_nm <= 25)::int AS p25,
              count(*) FILTER (WHERE dist_nm <= 100)::int AS p100,
              count(DISTINCT icao) FILTER (WHERE dist_nm <= 25)::int AS c25,
              count(DISTINCT icao) FILTER (WHERE dist_nm <= 25 AND kind = 'uav')::int AS uav25,
              count(DISTINCT icao) FILTER (WHERE dist_nm <= 25 AND kind = 'military')::int AS mil25,
              count(DISTINCT icao) FILTER (WHERE dist_nm <= 100)::int AS c100,
              count(DISTINCT icao) FILTER (WHERE dist_nm <= 100 AND kind = 'uav')::int AS uav100,
              count(DISTINCT icao) FILTER (WHERE dist_nm <= 100 AND kind = 'military')::int AS mil100,
              count(DISTINCT icao) FILTER (WHERE dist_nm <= 25)::int AS near_contacts,
              -- TERMINAL AREA: within 10nm AND below 10,000ft. An aircraft cruising at 35,000ft
              -- over a base is transiting, not using it — but until now both counted identically,
              -- so a transcontinental flight inflated a dozen bases on its way past. Altitude is
              -- the semantic that separates "operating here" from "flew over here". Labelled as
              -- an INFERENCE: low and close is consistent with arriving/departing, not proof of
              -- a landing (we observe positions, never movements).
              -- 4,000ft, not 10,000. On a standard 3-degree approach an arriving aircraft is near
              -- 3,200ft at 10nm out, and circuit traffic is 1,000-1,500ft; a 10,000ft ceiling was
              -- still catching transits. CAVEAT recorded: alt_ft is barometric (MSL) and we do not
              -- store field elevation, so this proxy is weakest at high-elevation airfields.
              count(DISTINCT icao) FILTER (WHERE dist_nm <= 10 AND alt_ft IS NOT NULL AND alt_ft < 4000)::int AS terminal_contacts,
              count(*) FILTER (WHERE dist_nm <= 10 AND alt_ft IS NOT NULL AND alt_ft < 4000)::int AS terminal_points,
              -- HIGH OVERFLIGHT: inside 25nm but at cruise. These are the ones that were quietly
              -- inflating every "busy base" figure.
              -- A clean PARTITION of the aircraft within 25nm by altitude band. Three numbers that
              -- do not sum to the whole make every figure look untrustworthy; these do sum.
              COALESCE(max(b.low25), 0)  AS low25,
              COALESCE(max(b.mid25), 0)  AS mid25,
              COALESCE(max(b.high25), 0) AS high25,
              count(DISTINCT icao) FILTER (WHERE dist_nm <= 25 AND alt_ft IS NOT NULL AND alt_ft >= 25000)::int AS overflight_contacts,
              count(*) FILTER (WHERE alt_ft IS NOT NULL)::int AS points_with_alt,
              max(ts) AS last_seen,
              round(EXTRACT(EPOCH FROM (max(ts) - min(ts))) / 3600.0)::int AS span_hours
         FROM j LEFT JOIN bands b ON b.site = j.site
        GROUP BY j.site
        ORDER BY count(DISTINCT j.icao) DESC`
    : `SELECT site, max(country) AS country, count(*)::int AS points,
              count(DISTINCT icao)::int AS contacts,
              count(DISTINCT icao) FILTER (WHERE kind = 'uav')::int AS uav,
              count(DISTINCT icao) FILTER (WHERE kind = 'military')::int AS military,
              NULL::int AS c25, NULL::int AS uav25, NULL::int AS mil25,
              NULL::int AS c100, NULL::int AS uav100, NULL::int AS mil100,
              NULL::int AS near_contacts,
              max(ts) AS last_seen,
              round(EXTRACT(EPOCH FROM (max(ts) - min(ts))) / 3600.0)::int AS span_hours
         FROM drone_tracks
        WHERE ts > now() - ($1 || ' days')::interval AND site IS NOT NULL
        GROUP BY site ORDER BY count(DISTINCT icao) DESC`;

  const { rows } = await pool.query(sql, names.length ? [String(d), names, lats, lons] : [String(d)]);
  return rows;
}

async function stats() {
  if (!ready) return { enabled: false };
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS points,
              count(DISTINCT icao)::int AS contacts,
              min(ts) AS oldest,
              pg_total_relation_size('drone_tracks') AS bytes
         FROM drone_tracks`);
    const r = rows[0];
    return {
      enabled: true, retainDays: RETAIN_DAYS, maxRows: MAX_ROWS,
      writes, writeErrors, flushes, buffered: buffer.length, flushMinutes: FLUSH_MS / 60000,
      points: r.points, contacts: r.contacts, oldest: r.oldest,
      sizeMb: Number((Number(r.bytes) / 1e6).toFixed(1)),
      capacityUsedPct: Number(((r.points / MAX_ROWS) * 100).toFixed(1)),
    };
  } catch (e) { return { enabled: true, error: e.message }; }
}

const isReady = () => ready;


// Last time each site produced a contact, used to seed the sweep's adaptive tiers on boot.
// Without this the rotation is only adaptive within one process lifetime: every deploy or
// idle restart wipes it, every site falls back to cold, and airspaces that were productive
// yesterday get rediscovered on the slowest rotation.
async function lastSeenBySite({ days = 30 } = {}) {
  if (!isReady()) return {};
  const { rows } = await pool.query(
    `SELECT site, MAX(ts) AS last_ts
       FROM drone_tracks
      WHERE ts > now() - ($1 || ' days')::interval AND site IS NOT NULL
      GROUP BY site`,
    [String(days)]
  );
  const out = {};
  rows.forEach((r) => { out[r.site] = new Date(r.last_ts).getTime(); });
  return out;
}


// Aggregates for the weekly digest. All arithmetic happens HERE, in SQL — the language
// model is handed finished numbers and asked only to write them up. It never counts.
async function digestData({ days = 7, siteCoords = {} } = {}) {
  if (!isReady()) return null;
  const d = String(days);

  // How far back does the archive actually reach? Without this, a young archive makes every
  // site look like a dramatic riser ("0 -> 344") when the truth is simply that the previous
  // window predates the recording. Comparisons are suppressed unless the data supports them.
  const cov = await pool.query(`SELECT MIN(ts) AS earliest, MAX(ts) AS latest FROM drone_tracks`);
  const earliest = cov.rows[0] && cov.rows[0].earliest ? new Date(cov.rows[0].earliest) : null;
  const prevWindowStart = new Date(Date.now() - days * 2 * 86400000);
  const coversPrevWindow = !!earliest && earliest <= prevWindowStart;
  const archiveAgeHours = earliest ? Math.round((Date.now() - earliest) / 3600000) : 0;
  const [top, topField_, byCountry, prev, totals] = await Promise.all([
    pool.query(
      `SELECT site, (array_agg(country ORDER BY ts DESC))[1] AS country,
              COUNT(DISTINCT icao) AS contacts,
              COUNT(DISTINCT icao) FILTER (WHERE kind = 'uav') AS uav,
              COUNT(DISTINCT icao) FILTER (WHERE kind = 'military') AS military,
              -- low + close: consistent with using the field rather than passing overhead
              COUNT(DISTINCT icao) FILTER (WHERE alt_ft IS NOT NULL AND alt_ft < 4000
                                             AND site_dist_nm IS NOT NULL AND site_dist_nm <= 10) AS terminal
         FROM drone_tracks
        WHERE ts > now() - ($1 || ' days')::interval AND site IS NOT NULL
        GROUP BY site ORDER BY contacts DESC LIMIT 8`, [d]),
    pool.query(
      `SELECT site, (array_agg(country ORDER BY ts DESC))[1] AS country,
              COUNT(DISTINCT icao) FILTER (WHERE alt_ft IS NOT NULL AND alt_ft < 4000
                                             AND site_dist_nm IS NOT NULL AND site_dist_nm <= 10) AS terminal,
              COUNT(DISTINCT icao) AS contacts
         FROM drone_tracks
        WHERE ts > now() - ($1 || ' days')::interval AND site IS NOT NULL
        GROUP BY site HAVING COUNT(DISTINCT icao) FILTER (WHERE alt_ft IS NOT NULL AND alt_ft < 4000
                                             AND site_dist_nm IS NOT NULL AND site_dist_nm <= 10) > 0
        ORDER BY terminal DESC LIMIT 8`, [d]),
    pool.query(
      `SELECT country,
              COUNT(DISTINCT icao) AS contacts,
              COUNT(DISTINCT icao) FILTER (WHERE kind = 'uav') AS uav,
              COUNT(DISTINCT site) AS sites,
              COUNT(DISTINCT icao) FILTER (WHERE alt_ft IS NOT NULL AND alt_ft < 4000
                                             AND site_dist_nm IS NOT NULL AND site_dist_nm <= 10) AS terminal
         FROM drone_tracks
        WHERE ts > now() - ($1 || ' days')::interval AND country IS NOT NULL
        GROUP BY country ORDER BY contacts DESC LIMIT 10`, [d]),
    pool.query(
      `SELECT site, COUNT(DISTINCT icao) AS contacts
         FROM drone_tracks
        WHERE ts > now() - ($1 || ' days')::interval * 2
          AND ts <= now() - ($1 || ' days')::interval
          AND site IS NOT NULL
        GROUP BY site`, [d]),
    pool.query(
      `SELECT COUNT(DISTINCT icao) AS contacts,
              COUNT(DISTINCT icao) FILTER (WHERE kind = 'uav') AS uav,
              COUNT(DISTINCT icao) FILTER (WHERE kind = 'military') AS military,
              COUNT(DISTINCT site) AS sites
         FROM drone_tracks
        WHERE ts > now() - ($1 || ' days')::interval`, [d]),
  ]);
  const prevMap = {};
  prev.rows.forEach((r) => { prevMap[r.site] = Number(r.contacts); });

  const now = top.rows.map((r) => ({
    site: r.site, country: r.country,
    contacts: Number(r.contacts), uav: Number(r.uav), military: Number(r.military),
    terminal: r.terminal == null ? null : Number(r.terminal),
  }));

  // The sweep polls a 250nm radius, so a site's headline count covers a whole REGION, not the
  // base itself: 250nm of Eglin AFB contains Hurlburt, Tyndall, Pensacola NAS, Whiting, Maxwell
  // and Keesler. Reporting that as "Eglin AFB: 344" implies aircraft at Eglin and is false.
  // Compute a second, tight count within 25nm so both numbers can be shown honestly.
  const NEAR_NM = 25;
  await Promise.all(now.map(async (r) => {
    const c = siteCoords[r.site];
    if (!c) { r.nearContacts = null; return; }
    const q = await pool.query(
      `SELECT COUNT(DISTINCT icao) AS n FROM drone_tracks
        WHERE site = $1 AND ts > now() - ($2 || ' days')::interval
          AND 2 * 3440.065 * asin(sqrt(
                power(sin(radians(lat - $3) / 2), 2) +
                cos(radians($3)) * cos(radians(lat)) *
                power(sin(radians(lon - $4) / 2), 2))) <= $5`,
      [r.site, d, c.lat, c.lon, NEAR_NM]);
    r.nearContacts = Number(q.rows[0].n);
  }));
  // Only claim a rise or a first appearance if the archive actually covered the earlier window.
  const risers = coversPrevWindow
    ? now.map((r) => ({ site: r.site, prev: prevMap[r.site] || 0, now: r.contacts }))
         .filter((r) => r.now > r.prev)
         .sort((a, b) => (b.now - b.prev) - (a.now - a.prev))
         .slice(0, 5)
    : [];
  const newSites = coversPrevWindow ? now.filter((r) => !(r.site in prevMap)).slice(0, 5) : [];

  const t = totals.rows[0] || {};
  // The two orderings answer different questions, and where they DISAGREE is the finding:
  // a big 250nm count with a small 25nm count means busy regional airspace, not a busy base.
  const topNear = now.filter((r) => r.nearContacts != null)
    .slice().sort((a, b) => b.nearContacts - a.nearContacts).slice(0, 5);

  // Ranked by activity AT THE FIELD (within 10nm, below 4,000ft) rather than by the size of the
  // surrounding airspace. This is the ordering that answers "which bases were actually busy" —
  // ordering by the 250nm count answers "which bases sit in busy airspace", which is the original
  // 344 error wearing a leaderboard.
  const topField = topField_.rows.map((r) => ({
    site: r.site, country: r.country,
    terminal: Number(r.terminal), contacts: Number(r.contacts),
  }));

  // Country rollup: a digest that lists eight airbases with no geography reads as a list of
  // names. Grouping by country is the first thing a reader actually wants.
  const countries = byCountry.rows.map((r) => ({
    country: r.country,
    contacts: Number(r.contacts), uav: Number(r.uav),
    sites: Number(r.sites), terminal: Number(r.terminal || 0),
  }));

  return {
    windowDays: days,
    topNear,
    topField,
    countries,
    sweepRadiusNm: 250,
    nearRadiusNm: NEAR_NM,
    fieldRadiusNm: 10,
    fieldCeilingFt: 4000,
    archiveAgeHours,
    coversPrevWindow,
    top: now,
    risers,
    newSites,
    // `uav` and `military` are DISTINCT-aircraft counts over a per-ROW classification, so an
    // aircraft seen as military on one pass and UAV on another appears in BOTH. They therefore do
    // not partition the total, and printing them beside it invites a reader to add them and find
    // more aircraft than exist. Every archived row is one kind or the other, so the overlap is
    // exactly uav + military - contacts. Stated rather than tidied away: an aircraft classified
    // both ways is genuinely ambiguous, and that ambiguity is worth showing.
    totals: (() => {
      const contacts = Number(t.contacts || 0);
      const uav = Number(t.uav || 0);
      const military = Number(t.military || 0);
      return { contacts, uav, military, sites: Number(t.sites || 0),
               bothKinds: Math.max(0, uav + military - contacts) };
    })(),
  };
}

// How much history actually exists. The day-selector offers 1/7/30/90d, but a window can only
// ever show what has been recorded — a "7 days" chip over a 3-day-old archive is a promise the
// data cannot keep unless the UI says so.
async function ageHours() {
  if (!ready) return null;
  const { rows } = await pool.query(`SELECT MIN(ts) AS earliest, MAX(ts) AS latest FROM drone_tracks`);
  const earliest = rows[0] && rows[0].earliest ? new Date(rows[0].earliest).getTime() : null;
  if (!earliest) return 0;
  return Math.round((Date.now() - earliest) / 3600000);
}

// MULTI-STOP TRACKING — the same aircraft observed low and close at several airfields in sequence.
//
// A logistics run (load, fly, unload, fly again) leaves a distinctive trace: terminal-area
// observations at field A, then field B, then C, with a gap of hours between. Nothing else in this
// product looks across sites for a SINGLE aircraft; every other query aggregates per site.
//
// WHAT THIS CAN AND CANNOT SAY — stated here because the output is easy to over-read:
//   - We observe POSITIONS, never movements. "Low and close" (<=10nm, <4,000ft) is consistent with
//     using a field; it is not an observed landing, and a low overflight looks identical.
//   - A gap between two sites means WE DID NOT SEE IT, not that it flew directly. It may have
//     stopped somewhere unwatched, or been out of receiver coverage.
//   - Dwell is bounded by observation: "seen 09:12-11:40" means at least that long, and only that
//     it was within the terminal area during it.
//   - The sweep rotates, so an aircraft can be missed at a site entirely. Absence of a stop is not
//     evidence it did not stop.
//   - Nearby airfields can both see the same aircraft. Sites closer together than ~20nm may both
//     register a single approach; adjacent-field pairs are flagged rather than silently treated as
//     two stops.
//
// Visits are segmented by SITE CHANGE or a gap longer than VISIT_GAP_H, so an A -> B -> A pattern
// is preserved as three visits rather than collapsed into two sites.
const VISIT_GAP_H = Number(process.env.VISIT_GAP_HOURS || 3);

async function multiStop(days = 7, minStops = 2, limit = 40) {
  if (!ready) return { enabled: false, visits: [], aircraft: [] };
  const d = Math.max(1, Math.min(90, Number(days) || 7));
  const stops = Math.max(2, Math.min(10, Number(minStops) || 2));
  const lim = Math.max(1, Math.min(200, Number(limit) || 40));
  // Fail fast and visibly rather than hanging until the platform kills the connection.
  await pool.query("SET LOCAL statement_timeout = 15000").catch(() => {});
  const { rows } = await pool.query(
    `WITH terminal AS (
       SELECT icao, site, country, ts, callsign, type_code, descr, kind
         FROM drone_tracks
        WHERE ts > now() - ($1 || ' days')::interval
          AND site IS NOT NULL
          AND site_dist_nm IS NOT NULL AND site_dist_nm <= 10
          AND alt_ft IS NOT NULL AND alt_ft < 4000
     ),
     seq AS (
       SELECT *,
              LAG(site) OVER (PARTITION BY icao ORDER BY ts) AS prev_site,
              LAG(ts)   OVER (PARTITION BY icao ORDER BY ts) AS prev_ts
         FROM terminal
     ),
     marked AS (
       SELECT *, CASE WHEN prev_site IS DISTINCT FROM site
                        OR prev_ts IS NULL
                        OR ts - prev_ts > ($2 || ' hours')::interval
                      THEN 1 ELSE 0 END AS is_new
         FROM seq
     ),
     grouped AS (
       SELECT *, SUM(is_new) OVER (PARTITION BY icao ORDER BY ts
                                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS visit_no
         FROM marked
     ),
     visits AS (
       SELECT icao, visit_no, site,
              (array_agg(country ORDER BY ts DESC))[1]   AS country,
              (array_agg(callsign ORDER BY ts DESC))[1]  AS callsign,
              (array_agg(type_code ORDER BY ts DESC))[1] AS type_code,
              (array_agg(descr ORDER BY ts DESC))[1]     AS descr,
              (array_agg(kind ORDER BY ts DESC))[1]      AS kind,
              min(ts) AS first_seen, max(ts) AS last_seen, count(*)::int AS points
         FROM grouped GROUP BY icao, visit_no, site
     ),
     qualifying AS (
       SELECT icao, count(*)::int AS visit_count
         FROM visits
        GROUP BY icao
       HAVING count(*) >= $3 AND count(DISTINCT site) >= 2
        ORDER BY count(*) DESC
        LIMIT $4
     )
     SELECT v.*, q.visit_count FROM visits v JOIN qualifying q ON q.icao = v.icao
      ORDER BY q.visit_count DESC, v.icao, v.first_seen`,
    [d, VISIT_GAP_H, stops, lim]
  );

  // Fold the flat visit rows into one itinerary per aircraft.
  const byIcao = new Map();
  for (const r of rows) {
    const cur = byIcao.get(r.icao) || {
      icao: r.icao, callsign: null, typeCode: null, descr: null, kind: null,
      callsignSet: [], stops: [],
    };
    cur.callsign = cur.callsign || r.callsign || null;
    // Callsigns are set per MISSION, not per airframe: the same aircraft routinely arrives as one
    // callsign and departs as another. Keeping only the first hid that entirely. The change is
    // often the most informative part of an itinerary, so it is recorded per stop.
    if (r.callsign && !cur.callsignSet.includes(r.callsign)) cur.callsignSet.push(r.callsign);
    cur.typeCode = cur.typeCode || r.type_code || null;
    cur.descr = cur.descr || r.descr || null;
    cur.kind = cur.kind || r.kind || null;
    const first = new Date(r.first_seen).getTime();
    const last = new Date(r.last_seen).getTime();
    const mins = Math.round((last - first) / 60000);
    cur.stops.push({
      site: r.site, country: r.country,
      callsign: r.callsign || null,
      firstSeen: r.first_seen, lastSeen: r.last_seen,
      // "At least" because we only know the span we OBSERVED it inside the terminal area.
      observedMinutes: mins,
      points: r.points,
      // EVIDENCE STRENGTH. A single sweep observation and six hours of continuous tracking are not
      // the same claim, and rendering both as "a stop" invites equal belief in both. One point with
      // zero duration means the rotating sweep caught it low and close ONCE — consistent with a
      // stop, and equally consistent with a low approach it then flew away from.
      evidence: r.points >= 5 && mins >= 20 ? "sustained"
              : r.points >= 2 || mins >= 5 ? "repeated"
              : "single sighting",
    });
    byIcao.set(r.icao, cur);
  }

  const aircraft = [...byIcao.values()].map((a) => {
    const t0 = new Date(a.stops[0].firstSeen).getTime();
    const t1 = new Date(a.stops[a.stops.length - 1].lastSeen).getTime();
    return {
      ...a,
      stopCount: a.stops.length,
      distinctSites: new Set(a.stops.map((s) => s.site)).size,
      spanHours: Math.round((t1 - t0) / 36e5 * 10) / 10,
      // Consecutive visits to the SAME field are separate visits (a gap split them), but printing
      // "Brize Norton -> Brize Norton -> Brize Norton" reads as three destinations rather than
      // three returns. Collapse the repeats and count them instead.
      route: a.stops.reduce((acc, s) => {
        const last = acc[acc.length - 1];
        if (last && last.site === s.site) { last.n += 1; return acc; }
        acc.push({ site: s.site, n: 1 });
        return acc;
      }, []).map((x) => (x.n > 1 ? `${x.site} (x${x.n})` : x.site)).join(" -> "),
      // How many stops rest on a single sighting. A 6-stop itinerary where 5 are single sightings
      // is a much weaker claim than one where 5 are sustained, and the difference must be visible.
      sustainedStops: a.stops.filter((s) => s.evidence === "sustained").length,
      singleSightingStops: a.stops.filter((s) => s.evidence === "single sighting").length,
      // The AIRFRAME is constant here — grouping is by ICAO address, which is tied to the
      // registration — while the CALLSIGN can change between legs. More than one callsign across
      // an itinerary is normal operational practice, not evidence of anything covert, and it is
      // reported as an observation with no motive attached.
      callsigns: a.callsignSet,
      callsignChanges: Math.max(0, a.callsignSet.length - 1),
    };
  }).sort((x, y) =>
    // Rank by EVIDENCE, not by count. Sorting on stopCount alone put a 7-stop itinerary with zero
    // sustained stops above a 6-stop one with five — the list led with its weakest result while
    // the strongest sat below it. Sustained stops first, then total stops, then the tighter span.
    y.sustainedStops - x.sustainedStops
    || y.stopCount - x.stopCount
    || x.spanHours - y.spanHours);

  return {
    enabled: true,
    windowDays: d,
    visitGapHours: VISIT_GAP_H,
    criteria: "within 10nm and below 4,000ft — consistent with using the field, not an observed landing",
    caveats: [
      "Positions only. A low overflight is indistinguishable from a stop.",
      "A gap between stops means it was not seen in between, not that it flew directly.",
      "Dwell is the OBSERVED span inside the terminal area, so it is a lower bound.",
      "The sweep rotates; a missed stop is not evidence there was none.",
      "Airfields closer than about 20nm can both register one approach — an itinerary alternating between two neighbouring fields (Eglin/Hurlburt/Duke, for example) is more likely local pattern work than separate logistics stops.",
    "A stop with no callsign means none was RECORDED for those observations. That is not the same as the aircraft withholding one: not every ADS-B message carries the flight field, so a short visit can easily be captured without it. Absence of a callsign here is not evidence of a blank callsign being broadcast.",
    "Itineraries are grouped by ICAO 24-bit address (the airframe), not by callsign. An aircraft that arrives as one callsign and departs as another is correctly kept as ONE itinerary; the callsigns field lists every one observed.",
    "If the ICAO ADDRESS itself changes — a PIA privacy address, a maintenance reprogramming, or spoofing — the legs CANNOT be linked and will appear as separate aircraft. This watch has no way to join them, and does not guess.",
    "Each stop carries an `evidence` value: sustained (5+ observations over 20+ minutes), repeated, or single sighting. A single sighting is one sweep catching the aircraft low and close once — consistent with a stop, and equally consistent with an approach it flew away from.",
    ],
    count: aircraft.length,
    aircraft,
  };
}

module.exports = {
  ageHours,
  multiStop,
  coverage, init, record, flush, history, track, heat, stats, lastSeenBySite, digestData, isReady, RETAIN_DAYS };
