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
const URL = process.env.DATABASE_URL || "";

let pool = null;
let ready = false;
let writes = 0, writeErrors = 0;

async function init() {
  if (!URL) { console.log("[archive] disabled (no DATABASE_URL) — sweep stays in memory only"); return false; }
  let Pool;
  try { ({ Pool } = require("pg")); }
  catch { console.error("[archive] 'pg' not installed — archive disabled"); return false; }

  pool = new Pool({
    connectionString: URL,
    ssl: { rejectUnauthorized: false },   // managed Postgres (Neon/Supabase) terminates TLS
    max: 3,                               // small pool: this is a tiny service
    idleTimeoutMillis: 30000,
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
        country     TEXT
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS drone_tracks_icao_ts ON drone_tracks (icao, ts DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS drone_tracks_ts ON drone_tracks (ts DESC)`);
    ready = true;
    console.log(`[archive] connected · retaining ${RETAIN_DAYS} days`);
    prune();
    setInterval(prune, 6 * 60 * 60 * 1000);   // prune every 6h
    return true;
  } catch (e) {
    console.error("[archive] init failed:", e.message);
    return false;
  }
}

// Record one observation. Parameterised query — no string concatenation, ever.
async function record(c) {
  if (!ready) return;
  if (c.kind !== "uav" && c.kind !== "military") return;   // scope guard
  try {
    await pool.query(
      `INSERT INTO drone_tracks
        (icao, ts, lat, lon, alt_ft, speed_kt, heading, kind, confidence, callsign, type_code, descr, site, country)
       VALUES ($1, to_timestamp($2/1000.0), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [c.id, c.lastSeen || Date.now(), c.lat, c.lon,
       Number.isFinite(c.altFt) ? Math.round(c.altFt) : null,
       Number.isFinite(c.groundSpeedKt) ? Math.round(c.groundSpeedKt) : null,
       Number.isFinite(c.headingDeg) ? c.headingDeg : null,
       c.kind, c.confidence || null, c.callsign || null, c.typeCode || null,
       c.desc || null, c.site || null, c.country || null]
    );
    writes++;
  } catch (e) {
    writeErrors++;
    if (writeErrors % 25 === 1) console.error("[archive] write failed:", e.message);
  }
}

async function prune() {
  if (!ready) return;
  try {
    const r = await pool.query(`DELETE FROM drone_tracks WHERE ts < now() - ($1 || ' days')::interval`, [String(RETAIN_DAYS)]);
    if (r.rowCount) console.log(`[archive] pruned ${r.rowCount} rows older than ${RETAIN_DAYS}d`);
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

async function stats() {
  if (!ready) return { enabled: false };
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS points,
              count(DISTINCT icao)::int AS contacts,
              min(ts) AS oldest
         FROM drone_tracks`);
    return { enabled: true, retainDays: RETAIN_DAYS, writes, writeErrors, ...rows[0] };
  } catch (e) { return { enabled: true, error: e.message }; }
}

const isReady = () => ready;

module.exports = { init, record, history, track, stats, isReady, RETAIN_DAYS };
