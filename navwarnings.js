// Navigational warnings — what states have DECLARED, not what is happening.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⚠️  NOT FOR NAVIGATION. Mariners must use official broadcast services under SOLAS. This is a
//     derived, possibly delayed view. Every entry carries its message number; check the source.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// WHAT THIS IS. Before doing something dangerous at sea — firing, laying cable, testing a missile —
// a state is obliged to warn shipping. Those warnings are published as text with coordinates and
// dates. The US NGA collects them worldwide and serves them as JSON without a key.
//
// THE SEMANTIC THAT MATTERS: a warning says a state DECLARED a danger area. It does not say what
// is happening inside it, and it usually does not say why. The Venezuela message below reads
// "HAZARDOUS OPERATIONS IN PROGRESS UNTIL FURTHER NOTICE" and names no activity at all. Reporting
// that as a missile test would be inventing the interesting part — the same reason
// airspace-advisories.js refuses to say "airspace closed" when an advisory merely binds one
// authority's operators.
//
// HOW THIN THIS ACTUALLY IS. Of 386 active warnings measured on 2026-09-06: 64 were broken
// navigation lights, 24 cable operations, 3 hazardous-operations zones, 1 missile, 1 firing. The
// forward-looking military signal is roughly five messages worldwide at any moment. That is why
// there is no dedicated tab — a panel that is usually empty teaches people not to open it. Each
// warning goes where its subject already lives.

"use strict";

const SRC = "https://msi.nga.mil/api/publications/broadcast-warn?status=active&output=json";
const TTL_MS = 30 * 60 * 1000;   // warnings are issued over hours, not seconds

let cache = { at: 0, data: null };

// Coordinates arrive as "13-05.00N 066-43.00W" — degrees, then minutes with a decimal, then a
// hemisphere letter. Anything that does not match this exactly is left alone rather than guessed
// at: a danger zone drawn in the wrong place is worse than one not drawn.
const COORD = /(\d{1,3})-(\d{2}(?:\.\d+)?)([NS])\s+(\d{1,3})-(\d{2}(?:\.\d+)?)([EW])/g;

function parseCoords(text) {
  const out = [];
  let m;
  COORD.lastIndex = 0;
  while ((m = COORD.exec(text)) !== null) {
    const lat = (Number(m[1]) + Number(m[2]) / 60) * (m[3] === "S" ? -1 : 1);
    const lon = (Number(m[4]) + Number(m[5]) / 60) * (m[6] === "W" ? -1 : 1);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) out.push([lat, lon]);
  }
  return out;
}

// Classified by what the message SAYS, not by inference about intent. A message mentioning cable
// work is a cable operation; one declaring a hazardous area is a hazardous area. Where a message
// matches neither it is dropped, because this app has no use for a broken buoy.
function classify(text) {
  const t = text.toUpperCase();
  if (/\bCABLE\s+(OPERATIONS|LAYING|REPAIR|WORK)/.test(t) || /CABLESHIP|CABLE SHIP/.test(t)) return "cable";
  if (/HAZARDOUS OPERATIONS|LIVE FIRE|GUNNERY|FIRING EXERCISE|MISSILE|ROCKET LAUNCH/.test(t)) return "hazard";
  return null;
}

// Dates appear inside the free text as "22 AUG THRU 02 SEP" or "UNTIL FURTHER NOTICE". Extracted
// verbatim rather than parsed into a timestamp — "thru 02 SEP" has no year in the message, and
// inventing one to make a date object would be adding information the source does not carry.
function windowText(text) {
  // Whitespace normalised FIRST. These are teleprinter messages wrapped at about 50 characters,
  // so "UNTIL FURTHER\nNOTICE" and "22 AUG\nTHRU 02 SEP" both split mid-phrase — matching the raw
  // text found neither, and the layer showed no dates at all on messages that plainly carry them.
  const t = text.toUpperCase().replace(/\s+/g, " ");
  const m = t.match(/(\d{1,2}\s+[A-Z]{3}\s+(?:THRU|TO|-)\s+\d{1,2}\s+[A-Z]{3})/)
    || t.match(/(UNTIL FURTHER NOTICE)/);
  return m ? m[1].toLowerCase() : null;
}

async function fetchWarnings() {
  if (cache.data && Date.now() - cache.at < TTL_MS) return { ...cache.data, cached: true };
  const r = await fetch(SRC, { headers: { "User-Agent": "streetwatch.earth" } });
  if (!r.ok) throw new Error(`nga ${r.status}`);
  const j = await r.json();
  const raw = j["broadcast-warn"] || [];

  const items = [];
  for (const w of raw) {
    const kind = classify(w.text || "");
    if (!kind) continue;
    const coords = parseCoords(w.text || "");
    // No coordinates means nothing to draw. Kept out rather than placed at a guessed centre.
    if (!coords.length) continue;
    items.push({
      kind,
      id: `${w.navArea}-${w.msgYear}-${w.msgNumber}`,
      area: w.navArea,
      issued: w.issueDate || null,
      authority: w.authority || null,
      // The first line or two is the place; the rest is the detail. Both kept — a reader deciding
      // whether a warning matters to them needs the actual words, not a summary of them.
      text: (w.text || "").trim(),
      when: windowText(w.text || ""),
      coords,
      // A single point is a position; three or more corners is an area. Said explicitly so the
      // client does not have to infer it from the length of an array.
      // A TRACKLINE IS NOT AN AREA. "ALONG TRACKLINE JOINING" lists points a cable ship follows —
      // a path. "IN AREA BOUND BY" lists corners enclosing a zone. Counting points cannot tell
      // them apart, and drawing the Nigeria cable route as a filled polygon would claim a whole
      // gulf was affected when the message describes a line through it. The text says which.
      shape: /ALONG TRACKLINE|TRACKLINES JOINING/.test((w.text || "").toUpperCase().replace(/\s+/g, " "))
        ? "line"
        : coords.length >= 3 ? "area" : "point",
      ref: "https://msi.nga.mil/NavWarnings",
    });
  }

  const data = {
    source: "US NGA Maritime Safety Information — broadcast warnings, active",
    note: "A warning means a state DECLARED a danger area or announced work. It does not say what "
        + "is happening inside it, and usually does not say why. Not for navigation: mariners must "
        + "use official broadcast services.",
    fetched: new Date().toISOString(),
    totalActive: raw.length,
    count: items.length,
    items,
  };
  cache = { at: Date.now(), data };
  return { ...data, cached: false };
}

module.exports = { fetchWarnings };
