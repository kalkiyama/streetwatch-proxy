#!/usr/bin/env node
/*
 * check-feeds.js — does each URL in the catalogue still answer?
 *
 * RUN:  cd ~/streetwatch-proxy
 *       node check-feeds.js                      # every distinct URL (42 of them — see below)
 *       node check-feeds.js --sample 10          # a random subset of the distinct URLs
 *       node check-feeds.js --catalogue ~/streetwatch/dist/catalog.json
 *
 * READ THIS BEFORE READING THE OUTPUT — it is not the number you probably want.
 *
 * The catalogue holds 7,208 entries but only 42 DISTINCT URLs, across 35 hosts. 98.9% of entries
 * carry a bare provider homepage: every one of the 5,276 aviation entries points at
 * globe.adsbexchange.com/, all 1,557 marine entries at marinetraffic.com/, all 25 Guntur-style
 * traffic entries at trafficvision.live/. The `url` field is WHERE THIS FEED COMES FROM, not the
 * feed itself.
 *
 * Two consequences, both of which limit what this tool can tell you:
 *
 *   1. SAMPLING IS MOOT. 7,200 requests deduplicate to 42. Checking all of them takes seconds and
 *      is gentler than a sample of the undeduplicated list would have been, because the sample
 *      would have hit the same few hosts repeatedly. --sample exists for when you want a quick
 *      look, not because the full run is expensive.
 *
 *   2. IT CANNOT MEASURE WHAT PROPORTION OF FEEDS ARE DEAD. A camera in Guntur that stopped
 *      publishing a year ago and one that is streaming right now are the same row here, pointing
 *      at the same homepage. If trafficvision.live answers, this reports both as reachable. Per-
 *      feed liveness is not knowable from this catalogue — the catalogue does not store it.
 *      What this measures is PROVIDER REACHABILITY: is the source still on the internet at all.
 *
 * That is still worth knowing — a provider that has gone dark takes every entry behind it with it,
 * and the entry-weighted counts below say how many rows each failure would affect. It is the upper
 * bound on the damage, not the damage.
 *
 * BLOCKED IS NOT DEAD. Several of these hosts sit behind bot protection and answer a scripted
 * request with 403 or 429 while serving a browser normally. Those are reported separately and must
 * NOT be counted as dead. A 403 here means "this tool was refused", which is a fact about the tool.
 *
 * NEITHER IS A BAD HEAD. See probe() — HEAD may report good news only; anything else is confirmed
 * with GET. Three DOT sites answer HEAD with a redirect to /NotFound and GET with a live page.
 */

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };

const DEFAULT_CATALOGUE = path.join(os.homedir(), "streetwatch", "public", "catalog.json");
const CATALOGUE   = String(opt("catalogue", DEFAULT_CATALOGUE)).replace(/^~(?=$|\/)/, os.homedir());
const SAMPLE      = opt("sample", null) === null ? null : Number(opt("sample", null));
const CONCURRENCY = Number(opt("concurrency", 4));
const TIMEOUT_MS  = Number(opt("timeout", 10000));

// Identify the tool honestly. An absent or forged User-Agent gets refused by several of these
// hosts, and pretending to be a browser to get past that would make the result a lie about who
// asked.
const UA = "StreetWatch-feed-check/1.0 (catalogue reachability audit; contact: repo owner)";

for (const [name, v] of [["sample", SAMPLE], ["concurrency", CONCURRENCY], ["timeout", TIMEOUT_MS]]) {
  if (v !== null && (!Number.isFinite(v) || v <= 0)) {
    console.error(`--${name} must be a positive number, got ${JSON.stringify(opt(name, null))}`);
    process.exit(1);
  }
}
if (!fs.existsSync(CATALOGUE)) {
  console.error(`no catalogue at ${CATALOGUE}\nusage: node check-feeds.js [--catalogue <path>] [--sample N] [--concurrency 4] [--timeout 10000]`);
  process.exit(1);
}

let rows;
try {
  rows = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));
} catch (e) {
  console.error(`could not parse ${CATALOGUE}: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(rows) || !rows.length) {
  console.error("catalogue is not a non-empty array — has the format changed?");
  process.exit(1);
}

// ── group entries by URL ────────────────────────────────────────────────────
// The group size is the whole point: it is how many catalogue rows one dead host would take out.
const byUrl = new Map();
const malformed = [];
for (const r of rows) {
  if (!r || typeof r.url !== "string" || !r.url) { malformed.push(r && r.id); continue; }
  if (!byUrl.has(r.url)) byUrl.set(r.url, []);
  byUrl.get(r.url).push(r);
}

let targets = [...byUrl.entries()].map(([url, entries]) => ({ url, entries }));
targets.sort((a, b) => b.entries.length - a.entries.length);

const totalDistinct = targets.length;
const totalEntries = rows.length;

if (SAMPLE !== null && SAMPLE < targets.length) {
  // Sample the DISTINCT urls, not the entries. Sampling entries would draw adsbexchange 73% of the
  // time and tell you about one host over and over.
  const pool = [...targets];
  const picked = [];
  while (picked.length < SAMPLE && pool.length) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  targets = picked.sort((a, b) => b.entries.length - a.entries.length);
}

// ── classification ──────────────────────────────────────────────────────────
// The categories matter more than the status codes. "dead" must mean dead.
function classify(status, method) {
  if (status >= 200 && status < 400) return "ok";
  if (status === 401 || status === 403 || status === 429) return "blocked";
  // 405 means opposite things depending on which verb drew it. On HEAD it is a routing quirk and
  // the retry below turns it into a GET. On GET it cannot be read at face value: GET is THE verb
  // for fetching a page, so a server refusing it is not describing a method restriction, it is
  // refusing us. montereybayaquarium.org answers GET with 405 to this tool's User-Agent and 403
  // to a blank one — the same refusal wearing two codes. Filing it under "other" left a bot block
  // looking like a protocol curiosity.
  if (status === 405 && method === "GET") return "blocked";
  if (status === 404 || status === 410) return "gone";
  if (status >= 500) return "server-error";
  return "other";
}

async function probe(url) {
  const started = Date.now();
  let headStatus = null;
  // HEAD first — it asks for headers only, which is the lightest question that still proves the
  // host is answering. But HEAD IS ONLY EVER ALLOWED TO REPORT GOOD NEWS. A HEAD that comes back
  // anything other than ok is confirmed with a GET before we conclude anything, because a server
  // may route the verb differently from the page:
  //
  //   511ny.org/cctv, fl511.com/cctv and az511.gov/cctv answer HEAD with a 302 to /NotFound —
  //   which follows to a 404 — and answer GET with a 200 camera list. The first version of this
  //   file retried only on 405/501, reported all three as GONE, and sent me looking for
  //   replacement URLs for three pages that were never down. A cheaper request that lies is not
  //   cheaper.
  for (const method of ["HEAD", "GET"]) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        signal: ctrl.signal,
        headers: { "User-Agent": UA, Accept: "*/*" },
      });
      if (method === "HEAD" && classify(res.status, method) !== "ok") {
        headStatus = res.status;
        clearTimeout(timer);
        continue;
      }
      return {
        state: classify(res.status, method),
        status: res.status,
        ms: Date.now() - started,
        method,
        // Kept so a verb-routing quirk shows up in the output instead of being silently smoothed
        // over — it is a fact about the host worth seeing.
        headStatus: headStatus !== null && headStatus !== res.status ? headStatus : null,
        finalUrl: res.url && res.url !== url ? res.url : null,
      };
    } catch (e) {
      clearTimeout(timer);
      if (method === "HEAD") continue;          // give GET a chance before calling it unreachable
      return {
        state: "unreachable",
        status: null,
        ms: Date.now() - started,
        method,
        error: e.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : (e.cause?.code || e.message),
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return { state: "unreachable", status: null, ms: Date.now() - started, method: "GET", error: "no response" };
}

// Small fixed pool. 42 requests spread over 35 hosts needs no more than this, and it keeps the
// tool from arriving at any one host as a burst.
async function runPool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
      process.stdout.write(".");
    }
  }));
  return out;
}

(async () => {
  console.log(`\ncatalogue : ${CATALOGUE}`);
  console.log(`entries   : ${totalEntries.toLocaleString()} rows, ${totalDistinct} distinct URLs`);
  console.log(`checking  : ${targets.length} URL(s)${SAMPLE !== null && SAMPLE < totalDistinct ? " (sampled)" : ""} · concurrency ${CONCURRENCY} · timeout ${TIMEOUT_MS}ms`);
  if (malformed.length) console.log(`skipped   : ${malformed.length} entries with no usable url`);
  console.log();

  const results = await runPool(targets, CONCURRENCY, async (t) => ({ ...t, ...(await probe(t.url)) }));
  console.log("\n");

  const order = { unreachable: 0, gone: 1, "server-error": 2, other: 3, blocked: 4, ok: 5 };
  results.sort((a, b) => (order[a.state] - order[b.state]) || (b.entries.length - a.entries.length));

  const label = {
    ok: "OK", blocked: "BLOCKED (bot protection — not dead)", gone: "GONE (404/410)",
    "server-error": "SERVER ERROR (5xx)", unreachable: "UNREACHABLE", other: "OTHER",
  };

  let shown = null;
  for (const r of results) {
    if (r.state !== shown) {
      shown = r.state;
      const group = results.filter((x) => x.state === r.state);
      const rowsAffected = group.reduce((s, x) => s + x.entries.length, 0);
      console.log(`── ${label[r.state]} — ${group.length} URL(s), ${rowsAffected.toLocaleString()} catalogue entries behind them ──`);
    }
    const layers = [...new Set(r.entries.map((e) => e.layer))].join("/");
    console.log(`  ${String(r.status ?? "—").padStart(3)}  ${String(r.ms).padStart(5)}ms  ${String(r.entries.length).padStart(5)} entries  ${layers.padEnd(9)}  ${r.url}`);
    if (r.finalUrl) console.log(`         → redirected to ${r.finalUrl}`);
    if (r.headStatus) console.log(`         (HEAD said ${r.headStatus}, GET said ${r.status} — verb-routing quirk, trust the GET)`);
    if (r.error) console.log(`         ${r.error}`);
    if (r.state === shown && results.filter((x) => x.state === shown).at(-1) === r) console.log();
  }

  // ── the summary, stated in both units ────────────────────────────────────
  const tally = {};
  for (const r of results) {
    tally[r.state] = tally[r.state] || { urls: 0, entries: 0 };
    tally[r.state].urls++;
    tally[r.state].entries += r.entries.length;
  }
  const checkedEntries = results.reduce((s, r) => s + r.entries.length, 0);
  const dead = results.filter((r) => r.state === "unreachable" || r.state === "gone");
  const deadEntries = dead.reduce((s, r) => s + r.entries.length, 0);

  console.log("══════════════════════════════════════════════════════════════════════════════");
  console.log(`${results.length} URLs checked, covering ${checkedEntries.toLocaleString()} of ${totalEntries.toLocaleString()} catalogue entries`);
  for (const [state, t] of Object.entries(tally).sort((a, b) => order[a[0]] - order[b[0]])) {
    console.log(`  ${label[state].padEnd(38)} ${String(t.urls).padStart(3)} URLs  ${String(t.entries).padStart(6)} entries`);
  }
  console.log("──────────────────────────────────────────────────────────────────────────────");
  console.log(`DEAD (unreachable or gone): ${dead.length} of ${results.length} URLs`
    + ` · ${deadEntries.toLocaleString()} of ${checkedEntries.toLocaleString()} entries`
    + ` (${(100 * deadEntries / checkedEntries).toFixed(1)}%)`);
  console.log("══════════════════════════════════════════════════════════════════════════════");
  console.log("\nThat percentage is the share of catalogue ENTRIES whose PROVIDER has gone dark. It");
  console.log("is not the share of feeds that are dead: every entry behind a live provider is");
  console.log("counted as fine here, and this catalogue stores no per-feed URL that could say");
  console.log("otherwise. To learn what proportion of individual cameras still publish, the");
  console.log("catalogue would need to carry a feed-level URL per entry. Today it does not.\n");

  process.exitCode = dead.length ? 1 : 0;
})();
