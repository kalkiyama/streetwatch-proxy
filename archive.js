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
        country     TEXT
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS drone_tracks_icao_ts ON drone_tracks (icao, ts DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS drone_tracks_ts ON drone_tracks (ts DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS drone_tracks_site_ts ON drone_tracks (site, ts DESC)`);
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
  ]);
  if (buffer.length >= FLUSH_MAX) flush();
}

// Write the buffer as ONE multi-row INSERT. Still fully parameterised.
async function flush() {
  if (!ready || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  const COLS = 15;   // keep in step with the INSERT column list below
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
        (icao, ts, lat, lon, alt_ft, speed_kt, heading, kind, confidence, callsign, type_code, descr, site, country, site_dist_nm)
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
         SELECT t.icao, t.kind, t.site, t.country, t.ts,
                2 * 3440.065 * asin(sqrt(
                  power(sin(radians(t.lat - s.slat) / 2), 2) +
                  cos(radians(s.slat)) * cos(radians(t.lat)) *
                  power(sin(radians(t.lon - s.slon) / 2), 2))) AS dist_nm
           FROM drone_tracks t
           LEFT JOIN unnest($2::text[], $3::float8[], $4::float8[]) AS s(site, slat, slon)
                  ON s.site = t.site
          WHERE t.ts > now() - ($1 || ' days')::interval AND t.site IS NOT NULL
       )
       SELECT site,
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
              max(ts) AS last_seen,
              round(EXTRACT(EPOCH FROM (max(ts) - min(ts))) / 3600.0)::int AS span_hours
         FROM j
        GROUP BY site
        ORDER BY count(DISTINCT icao) DESC`
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
  const [top, prev, totals] = await Promise.all([
    pool.query(
      `SELECT site, (array_agg(country ORDER BY ts DESC))[1] AS country,
              COUNT(DISTINCT icao) AS contacts,
              COUNT(DISTINCT icao) FILTER (WHERE kind = 'uav') AS uav,
              COUNT(DISTINCT icao) FILTER (WHERE kind = 'military') AS military
         FROM drone_tracks
        WHERE ts > now() - ($1 || ' days')::interval AND site IS NOT NULL
        GROUP BY site ORDER BY contacts DESC LIMIT 8`, [d]),
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

  return {
    windowDays: days,
    topNear,
    sweepRadiusNm: 250,
    nearRadiusNm: NEAR_NM,
    archiveAgeHours,
    coversPrevWindow,
    top: now,
    risers,
    newSites,
    totals: { contacts: Number(t.contacts || 0), uav: Number(t.uav || 0),
              military: Number(t.military || 0), sites: Number(t.sites || 0) },
  };
}

module.exports = { init, record, flush, history, track, heat, stats, lastSeenBySite, digestData, isReady, RETAIN_DAYS };
