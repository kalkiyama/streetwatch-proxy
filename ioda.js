// Internet outages — when a country's networks stop answering.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MEASURES, AND WHAT IT DOES NOT.
//
// IODA (Georgia Tech) watches three independent signals per country: BGP routes withdrawn,
// /24 blocks that stop responding to active probing, and telescope traffic. When enough of them
// fall below an expected level it raises an alert.
//
// So "critical" means IODA'S THRESHOLD WAS CROSSED. It does not mean a country is offline, and it
// does not say why. A government shutdown, a cable cut, a power failure and a routing mistake all
// look the same from here — the app names the observation and leaves the cause alone.
//
//   "Bolivia's networks dropped below IODA's threshold for 65 minutes" is true.
//   "Bolivia went offline" is not, and "Bolivia was shut down" invents a cause.
//
// WHY THIS BELONGS BESIDE THE CLOUDFLARE FLOWS. Cloudflare measures attack traffic as a SHARE of
// requests — it says where hostile traffic came from. This says where traffic STOPPED. Different
// question, different failure mode, and the two together answer more than either alone.
//
// AND IT PAIRS WITH THE CABLES. A submarine cable cut shows up here as outages in the countries it
// served, which is a connection no single feed provides.
// ─────────────────────────────────────────────────────────────────────────────────────────────

"use strict";

const SRC = "https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts";
const TTL_MS = 10 * 60 * 1000;   // alerts arrive in 5-minute buckets; polling faster is pointless

let cache = { at: 0, days: 0, data: null };

async function outages({ days = 7 } = {}) {
  if (cache.data && cache.days === days && Date.now() - cache.at < TTL_MS) {
    return { ...cache.data, cached: true };
  }

  const until = Math.floor(Date.now() / 1000);
  const from = until - days * 86400;
  // A HIGH LIMIT, because the API returns OLDEST first and truncates. Asking for ten gave ten
  // alerts from a week ago and silently hid everything since.
  const url = `${SRC}?from=${from}&until=${until}&entityType=country&limit=500`;

  const r = await fetch(url, { headers: { "User-Agent": "streetwatch.earth" } });
  if (!r.ok) throw new Error(`ioda ${r.status}`);
  const j = await r.json();
  const raw = Array.isArray(j.data) ? j.data : [];

  // PAIR EACH ALERT WITH ITS RECOVERY. IODA emits a "critical" when the threshold is crossed and a
  // "normal" when it is met again; on their own each is half a fact. An outage that started and an
  // outage that ended read identically in a flat list, and the useful number — how long it lasted —
  // exists only in the pair.
  const byCountry = {};
  raw.forEach((a) => {
    const name = (a.entity && a.entity.name) || null;
    if (!name) return;
    (byCountry[name] = byCountry[name] || []).push(a);
  });

  const events = [];
  Object.entries(byCountry).forEach(([name, alerts]) => {
    alerts.sort((x, y) => x.time - y.time);
    let open = null;
    alerts.forEach((a) => {
      if (a.level === "critical" && !open) {
        open = a;
      } else if (a.level === "normal" && open) {
        events.push(makeEvent(name, open, a));
        open = null;
      }
    });
    // Still degraded at the end of the window: recorded with no recovery rather than dropped,
    // because an outage that has not ended is the one most worth seeing.
    if (open) events.push(makeEvent(name, open, null));
  });

  events.sort((a, b) => b.startedAt - a.startedAt);

  const data = {
    source: "IODA — Internet Outage Detection and Analysis, Georgia Tech",
    note: "An alert means IODA's detection threshold was crossed for a country, across BGP routing, "
        + "active probing and telescope traffic. It does not mean the country is offline and it "
        + "does not say why: a shutdown, a cable fault, a power cut and a routing error all look "
        + "the same from here.",
    windowDays: days,
    fetched: new Date().toISOString(),
    ongoing: events.filter((e) => !e.endedAt).length,
    count: events.length,
    // HOW OFTEN EACH COUNTRY TRIPS. Cape Verde raised five alerts in one morning — not a network
    // failing five times, but a small country sitting close to IODA's threshold and crossing it
    // whenever traffic dips. Frequency here measures how finely a country is measured as much as
    // how reliable it is, and a reader seeing five Cape Verde entries would conclude otherwise.
    repeatOffenders: Object.entries(
      events.reduce((m, e) => { m[e.country] = (m[e.country] || 0) + 1; return m; }, {})
    ).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])
      .map(([country, n]) => ({ country, alerts: n })),
    events: events.slice(0, 60),
  };
  cache = { at: Date.now(), days, data };
  return { ...data, cached: false };
}

function makeEvent(country, start, end) {
  const startedAt = start.time * 1000;
  const endedAt = end ? end.time * 1000 : null;
  return {
    country,
    // Which signal saw it. BGP means routes were withdrawn — the country's networks stopped being
    // announced. Active probing means addresses stopped answering. They can disagree, and which
    // one fired is part of what happened.
    signal: start.datasource || null,
    startedAt,
    endedAt,
    minutes: endedAt ? Math.round((endedAt - startedAt) / 60000) : null,
    // The measured level at each end. A drop from 4,749 to 4,793 on recovery says how deep it went
    // in IODA's own units — carried rather than converted to a severity word we would have invented.
    levelAtStart: start.value == null ? null : Number(start.value),
    levelAtEnd: end && end.value != null ? Number(end.value) : null,
    ongoing: !end,
  };
}

module.exports = { outages };
