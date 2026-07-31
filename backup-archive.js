#!/usr/bin/env node
/*
 * backup-archive.js — dump drone_tracks to a gzipped CSV using only `pg`, which is already a
 * dependency. No pg_dump, no Homebrew, no PATH surgery.
 *
 * RUN:  cd ~/streetwatch-proxy
 *       export $(grep -v '^#' .env.local | xargs)
 *       node backup-archive.js
 *
 * WHY THIS EXISTS. The archive is the ONLY irreplaceable asset in the project. The code is in git
 * and can be rebuilt; 166,000 rows of observed military and UAV movement cannot. It underpins the
 * discovery work, the Raumai Air Weapons Range find, and any future week-over-week finding. It
 * lives in a single Neon instance with no backup, and "monthly pg_dump" had been sitting in the
 * DEFERRED list — deferred is not the same as safe.
 *
 * READ-ONLY. One SELECT, batched. Safe to run against production at any time.
 *
 * RESTORE. The output is CSV with a header row, so it goes back with:
 *     gunzip -c streetwatch-archive-YYYYMMDD.csv.gz | psql "$DATABASE_URL" \
 *       -c "\copy drone_tracks FROM STDIN WITH CSV HEADER"
 * That needs psql, which is not installed here either — but a restore is a rare, planned event
 * where installing a tool is acceptable. A backup you cannot take today is worse than a restore
 * that needs ten minutes of setup on the day you actually need it.
 */

const { Pool } = require("pg");
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const BATCH = 5000;
const out = path.join(process.env.HOME,
  // TIMESTAMP, not just a date. A date-only name silently OVERWRITES an earlier backup taken the
  // same day — and if the second run fails partway it has destroyed the good copy while writing a
  // truncated one. Happened on Jul 31: a re-run replaced a dump already sent off-machine, leaving
  // the off-machine copy a schema version behind with nothing to indicate it.
  `streetwatch-archive-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}.csv.gz`);

// CSV escaping: quote anything containing a comma, quote, newline or carriage return, and double
// any embedded quotes. Nulls become empty fields, which is what \copy ... WITH CSV expects.
const cell = (v) => {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

(async () => {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const { rows: [{ n }] } = await pool.query("SELECT count(*)::int n FROM drone_tracks");
  console.log(`archive: ${n.toLocaleString()} rows`);
  if (!n) { console.log("nothing to back up"); await pool.end(); return; }

  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'drone_tracks' ORDER BY ordinal_position`);
  const names = cols.map((c) => c.column_name);
  console.log(`columns: ${names.join(", ")}\n`);

  const gz = zlib.createGzip({ level: 9 });
  const file = fs.createWriteStream(out);
  gz.pipe(file);
  const write = (s) => new Promise((res) => (gz.write(s) ? res() : gz.once("drain", res)));

  await write(names.join(",") + "\n");

  let done = 0, last = 0;
  while (done < n) {
    const { rows } = await pool.query(
      `SELECT * FROM drone_tracks ORDER BY id LIMIT $1 OFFSET $2`, [BATCH, done]);
    if (!rows.length) break;
    await write(rows.map((r) => names.map((k) => cell(r[k])).join(",")).join("\n") + "\n");
    done += rows.length;
    const pct = Math.floor((100 * done) / n);
    if (pct >= last + 10) { process.stdout.write(`  ${pct}% (${done.toLocaleString()} rows)\n`); last = pct; }
  }

  await new Promise((res) => { gz.end(); file.on("close", res); });
  await pool.end();

  const size = fs.statSync(out).size;
  console.log(`\nwrote ${out}`);
  console.log(`${done.toLocaleString()} rows · ${(size / 1024 / 1024).toFixed(1)} MB gzipped`);
  if (done !== n) console.log(`WARNING: expected ${n} rows, wrote ${done} — the table changed during the dump`);
  console.log(`\nVERIFY before trusting it:`);
  console.log(`  gunzip -c "${out}" | wc -l      # expect ${done + 1} (rows + header)`);
  console.log(`  gunzip -c "${out}" | head -2`);
  console.log(`\nThis file lives on ONE MACHINE. Copy it somewhere else — that is the entire point.`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
