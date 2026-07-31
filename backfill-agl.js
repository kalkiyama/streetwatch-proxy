#!/usr/bin/env node
/*
 * backfill-agl.js — compute agl_ft for rows written before the column existed.
 *
 * RUN:  cd ~/streetwatch-proxy
 *       export $(grep -v '^#' .env.local | xargs)
 *       node backfill-agl.js            # dry run: reports what it WOULD do, writes nothing
 *       node backfill-agl.js --write    # actually writes
 *
 * WHY. agl_ft is populated from Jul 31 onward. Every row before that is NULL, and NULL fails
 * `agl_ft <= X` SILENTLY — so any historical band query would return nothing while looking like it
 * had simply found nothing. That is PP-12, the site_dist_nm defect, which was found on Jul 31 and
 * would otherwise be reproduced in a brand new column the day after.
 *
 * DRY RUN BY DEFAULT. This is the first script in the project that MODIFIES the archive. Everything
 * else — discovery, audit, backup, ladder measurement — has been read-only. A dry run that reports
 * the same numbers a real run would produce costs one extra command and removes the class of
 * mistake where you find out what a script does by watching it do it.
 *
 * RESUMABLE AND CHUNKED. Updates in batches by id, so an interruption loses at most one batch and
 * re-running continues from wherever it stopped (it only selects rows where agl_ft IS NULL). No
 * long transaction, no table lock, and the live write path keeps working throughout.
 *
 * WHAT IT CANNOT DO. Ground elevation comes from the nearest reference airfield, and returns NULL
 * where terrain is rough or nothing is in range. Expect roughly 20-25% of rows to stay NULL after
 * this runs — that is the honest answer, not a failure, and it is the same proportion the live
 * write path produces (75-83% populated). Rows without lat/lon or alt_ft stay NULL necessarily.
 */

const { Pool } = require("pg");
const airfields = require("./airfields.js");

const WRITE = process.argv.includes("--write");
const BATCH = Number((process.argv.find((a) => a.startsWith("--batch=")) || "").split("=")[1] || 2000);

(async () => {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const { rows: [pre] } = await pool.query(
    `SELECT count(*) total,
            count(*) FILTER (WHERE agl_ft IS NULL) nulls,
            count(*) FILTER (WHERE agl_ft IS NULL AND alt_ft IS NOT NULL) candidates
       FROM drone_tracks`);
  console.log(`archive     : ${(+pre.total).toLocaleString()} rows`);
  console.log(`agl_ft null : ${(+pre.nulls).toLocaleString()}`);
  console.log(`computable  : ${(+pre.candidates).toLocaleString()}  (have alt_ft; the rest cannot be computed at all)`);
  console.log(WRITE ? "\nMODE: WRITE\n" : "\nMODE: DRY RUN — nothing will be written. Add --write to apply.\n");

  let cursor = 0, seen = 0, filled = 0, unknown = 0, noAlt = 0;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id, lat, lon, alt_ft
         FROM drone_tracks
        WHERE agl_ft IS NULL AND id > $1
        ORDER BY id
        LIMIT $2`, [cursor, BATCH]);
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;

    const ids = [], vals = [];
    for (const r of rows) {
      seen++;
      if (r.alt_ft === null) { noAlt++; continue; }
      const agl = airfields.heightAboveField(r.lat, r.lon, r.alt_ft);
      if (agl === null) { unknown++; continue; }   // ground level unknown — leave NULL, do not guess
      ids.push(r.id); vals.push(Math.round(agl));
      filled++;
    }

    if (WRITE && ids.length) {
      // one statement per batch, values joined by id — no lock held beyond the update itself
      await pool.query(
        `UPDATE drone_tracks AS t SET agl_ft = v.agl
           FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::int[]) AS agl) AS v
          WHERE t.id = v.id`, [ids, vals]);
    }

    if (seen % 20000 < BATCH)
      console.log(`  ${seen.toLocaleString()} scanned · ${filled.toLocaleString()} computed · ${unknown.toLocaleString()} ground unknown · ${noAlt.toLocaleString()} no altitude`);
  }

  console.log(`\nscanned        : ${seen.toLocaleString()}`);
  console.log(`computed       : ${filled.toLocaleString()}  (${seen ? Math.round(100 * filled / seen) : 0}%)`);
  console.log(`ground unknown : ${unknown.toLocaleString()}  — rough terrain or no reference within range. Correctly left NULL.`);
  console.log(`no altitude    : ${noAlt.toLocaleString()}  — nothing to convert.`);

  if (WRITE) {
    const { rows: [post] } = await pool.query(
      `SELECT count(*) total, count(agl_ft) has FROM drone_tracks`);
    console.log(`\nAFTER: ${(+post.has).toLocaleString()} of ${(+post.total).toLocaleString()} rows have agl_ft (${Math.round(100 * post.has / post.total)}%)`);
    console.log(`\nREMEMBER: NULL means ground level is UNKNOWN, never zero. Any query filtering on`);
    console.log(`agl_ft must state its null policy explicitly or it silently drops these rows.`);
  } else {
    console.log(`\nNothing was written. Re-run with --write to apply.`);
  }
  await pool.end();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
