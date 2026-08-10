"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// CelesTrak GP element sets (TLEs) for the satellite layer.
//
// HONESTY RULE FOR THIS WHOLE MODULE: positions derived from these elements are
// COMPUTED by SGP4 propagation, never observed. That is a different data class
// from ADS-B and AIS, which are broadcast by the object itself. The UI must say
// so, and `computed: true` rides along in every response so it cannot be
// quietly dropped.
//
// CelesTrak asks clients to cache rather than poll. Element sets change a few
// times a day, so a 6h TTL is generous to them and invisible to us.
// ─────────────────────────────────────────────────────────────────────────────

const CT = "https://celestrak.org/NORAD/elements/gp.php";
const TTL = 6 * 60 * 60 * 1000;
const cache = new Map();

// Groups offered to the UI. `cap` is the HARD render limit.
//
// WHY CAPS EXIST: Starlink alone is ~7,000 objects and the full active catalogue
// is ~28,000. Rendering all of them kills the map — the exact culling problem
// WorldMap was built to avoid. When a group is capped the response says so, and
// the UI must say so too ("showing 200 of 7,412"). Never imply completeness.
const GROUPS = {
  stations:       { label: "Space stations",    cap: 30 },
  "last-30-days": { label: "Recent launches",   cap: 250 },
  "gps-ops":      { label: "GPS",               cap: 40 },
  galileo:        { label: "Galileo",           cap: 40 },
  weather:        { label: "Weather",           cap: 80 },
  resource:       { label: "Earth observation", cap: 120 },
  geo:            { label: "Geostationary",     cap: 200 },
  starlink:       { label: "Starlink",          cap: 200 },
};

function parseTle(text) {
  const lines = text.split(/\r?\n/).map((s) => s.trimEnd()).filter((s) => s.length);
  const out = [];
  for (let i = 0; i + 2 <= lines.length; i += 3) {
    const name = lines[i], l1 = lines[i + 1], l2 = lines[i + 2];
    if (!l1 || !l2 || l1[0] !== "1" || l2[0] !== "2") continue;
    out.push({ name: name.trim(), id: Number(l1.slice(2, 7)), l1, l2 });
  }
  return out;
}

// Epoch age is the honesty number for this layer. A TLE hours old is accurate to
// metres; one weeks old can be kilometres off. Surfacing it stops a stale element
// set masquerading as a live position — the same defect class as the label/data
// mismatch caught on Jul 23.
function epochAgeHours(l1) {
  const yy = Number(l1.slice(18, 20));
  const doy = Number(l1.slice(20, 32));
  if (!Number.isFinite(yy) || !Number.isFinite(doy)) return null;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const ms = Date.UTC(year, 0, 1) + (doy - 1) * 86400000;
  return (Date.now() - ms) / 3600000;
}

async function group(name) {
  const g = GROUPS[name];
  if (!g) throw new Error(`unknown group ${name}`);

  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL) return { ...hit.payload, cached: true };

  try {
    const r = await fetch(`${CT}?GROUP=${encodeURIComponent(name)}&FORMAT=tle`, {
      headers: { "User-Agent": "streetwatch.earth (contact via site)" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error(`celestrak ${r.status}`);

    const all = parseTle(await r.text());
    if (!all.length) throw new Error("celestrak returned no element sets");

    const sats = all.slice(0, g.cap);
    const ages = sats.map((s) => epochAgeHours(s.l1)).filter((n) => Number.isFinite(n));

    const payload = {
      group: name,
      label: g.label,
      total: all.length,
      served: sats.length,
      capped: all.length > sats.length,
      oldestEpochHours: ages.length ? Math.round(Math.max(...ages) * 10) / 10 : null,
      source: "CelesTrak GP",
      computed: true,
      sats,
    };
    cache.set(name, { at: Date.now(), payload });
    return { ...payload, cached: false };
  } catch (e) {
    // STALE BEATS EMPTY, the same rule as cyber-proxy: an upstream blip should not
    // blank a panel that was correct an hour ago. But the response admits it, because
    // a silently old number is the defect this project keeps finding.
    if (hit) return { ...hit.payload, cached: true, stale: true, error: e.message };
    throw e;
  }
}

function groups() {
  return Object.entries(GROUPS).map(([k, v]) => ({ group: k, label: v.label, cap: v.cap }));
}

module.exports = { group, groups, GROUPS };
