// Strategic-asset watch — nuclear-capable types, and what can actually be seen of them.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CLAIM THIS MAKES, AND THE ONE IT DOES NOT.
//
// "Nuclear-capable" here is a property of the TYPE, never of the flight. A B-52H is certified to
// carry nuclear weapons; that is published and uncontroversial. Whether the one airborne today is
// carrying anything is not broadcast, cannot be observed, and is not claimed.
//
// So: "B-52H airborne — a nuclear-capable bomber type" is true.
//     "Nuclear bomber flight detected" describes the sortie and would be invented.
//
// Every response carries that distinction in `limits`, and the client must render it. A panel that
// says "nuclear" without saying what it cannot see is the thing this whole project exists not to
// be.
// ─────────────────────────────────────────────────────────────────────────────────────────────

"use strict";

// TYPES WATCHED, with what each actually is. Russian and Chinese types are listed deliberately
// even though none has ever appeared: they do not fit transponders that broadcast openly, so their
// absence here says nothing about whether they are flying. Watching for them costs nothing and
// would catch the rare case of one transmitting — and listing them makes the gap visible rather
// than leaving a reader to conclude the list is the world.
const TYPES = {
  B52:  { label: "B-52H Stratofortress", role: "strategic bomber", nuclear: true,  seen: true },
  B1:   { label: "B-1B Lancer",          role: "strategic bomber", nuclear: false, seen: true,
          // The B-1 was denuclearised under New START and is conventional-only. Included because
          // it flies the same strategic missions, and flagged as NOT nuclear-capable — calling it
          // one would be the easy error this file exists to avoid.
          note: "conventional only since 2011; nuclear capability removed under New START" },
  B2:   { label: "B-2A Spirit",          role: "strategic bomber", nuclear: true,  seen: false },
  B21:  { label: "B-21 Raider",          role: "strategic bomber", nuclear: true,  seen: false },
  T95:  { label: "Tu-95MS Bear",         role: "strategic bomber", nuclear: true,  seen: false },
  T160: { label: "Tu-160 Blackjack",     role: "strategic bomber", nuclear: true,  seen: false },
  T22M: { label: "Tu-22M3 Backfire",     role: "long-range bomber", nuclear: true, seen: false },
  H6:   { label: "Xian H-6",             role: "strategic bomber", nuclear: true,  seen: false },
};

const NEVER_SEEN_NOTE =
  "Russian and Chinese strategic bombers are watched for and have never appeared. They do not "
  + "broadcast ADS-B, so their absence from this list says nothing about whether they are flying.";

// No database handle here. The query lives in archive.js with every other read; this module holds
// what the types ARE and what may be said about them, which is the part that needs care.
async function strategic({ minutes = 1440, sightings = null } = {}) {
  const out = { windowMinutes: minutes, types: TYPES, aircraft: [], vessels: [] };

  if (sightings === null) {
    out.error = "archive_unavailable";
  } else {
    out.aircraft = sightings.map((r) => {
      const t = TYPES[r.type_code] || {};
      return {
        icao: r.icao,
        typeCode: r.type_code,
        label: t.label || r.type_code,
        role: t.role || null,
        nuclearCapableType: !!t.nuclear,
        typeNote: t.note || null,
        // "00000000" is a null flight field, not a callsign. Some transponders broadcast zeros
        // where nothing was entered, and printing it would invent an identifier that does not
        // exist — the ICAO address is the honest fallback.
        callsign: r.callsign && !/^0+$/.test(r.callsign.trim()) ? r.callsign.trim() : null,
        firstSite: r.first_site || null,
        lastSite: r.last_site || null,
        country: r.country || null,
        lat: r.lat == null ? null : Number(r.lat),
        lon: r.lon == null ? null : Number(r.lon),
        heading: r.heading == null ? null : Number(r.heading),
        altFt: r.alt_ft == null ? null : Number(r.alt_ft),
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        observations: Number(r.observations),
        radars: Number(r.sites),
      };
    });
  }

  return {
    ...out,
    limits: {
      payload: "Nuclear-capable describes the TYPE. Whether an aircraft is carrying anything is not "
             + "broadcast and cannot be observed here.",
      coverage: NEVER_SEEN_NOTE,
      vessels: "Vessels are shown live only. Ship movements are not archived, so there is no "
             + "history to look back through — months of tracks would build a pattern-of-life "
             + "record, which this project does not keep.",
      ads_b: "Only aircraft that broadcast appear at all. A bomber flying without a transponder is "
           + "absent, not stationary.",
    },
  };
}

module.exports = { strategic, TYPES, CODES: Object.keys(TYPES) };
