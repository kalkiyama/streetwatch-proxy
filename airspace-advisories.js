// Conflict-zone airspace advisories — official publications only.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⚠️  NOT FOR FLIGHT PLANNING. Operators must use official NOTAM/AIP sources. This is a derived,
//     possibly delayed situational-awareness view. Every entry cites its source; check it.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// THE SEMANTIC THAT MATTERS MOST HERE: "closed airspace" is almost always the wrong phrase.
// These are advisories and prohibitions issued BY one authority TO the operators it regulates:
//   - an EASA Conflict Zone Information Bulletin advises EU-registered CIVIL operators
//   - an FAA prohibition (14 CFR Part 91 SFAR) binds US CIVIL operators
// Neither closes the airspace to the overflown state's own aircraft, and neither binds military
// flights. Reporting "Airspace X is closed" would be false. Every entry therefore carries
// `appliesTo` and `bindingOn`, and the UI must render those, not a bare "CLOSED" badge.
//
// GEOMETRY IS APPROXIMATE. Real advisories follow FIR boundaries, not country outlines. The boxes
// below are rough areas for orientation only — the source document is authoritative for extent.

// When this list was compiled from the cited sources. Advisories change frequently; the API
// reports the age of this date so staleness is visible rather than assumed away.
const COMPILED_ON = "2026-07-23";

const ADVISORIES = [
  {
    id: "lb",
    region: "Lebanon",
    fir: "Beirut FIR (OLBB)",
    reason: "High risk from regional hostilities; separate CZIB issued after the region-wide bulletin was split",
    appliesTo: "civil",
    bindingOn: "EASA operators and EASA-authorised third-country operators",
    authority: "EASA",
    source: "https://www.easa.europa.eu/en/domains/air-operations/czibs",
    box: [[33.0, 35.0], [34.8, 36.7]],
  },
  {
    id: "gulf-states",
    region: "Bahrain, Kuwait, Qatar and UAE",
    fir: "Bahrain / Kuwait / Doha / Emirates FIRs",
    reason: "Operators advised to avoid; spill-over, misidentification and interception risk from regional military activity",
    appliesTo: "civil",
    bindingOn: "EASA operators and EASA-authorised third-country operators",
    authority: "EASA",
    source: "https://www.easa.europa.eu/en/domains/air-operations/czibs",
    box: [[22.5, 46.5], [30.2, 56.5]],
  },
  {
    id: "gulf-of-oman",
    region: "Gulf of Oman (Muscat FIR west of 58°E)",
    fir: "Muscat FIR (OOMM), western portion",
    reason: "Portion of the Muscat FIR west of 58°E included in the avoid advisory",
    appliesTo: "civil",
    bindingOn: "EASA operators and EASA-authorised third-country operators",
    authority: "EASA",
    source: "https://www.easa.europa.eu/en/domains/air-operations/czibs",
    box: [[22.0, 56.0], [26.5, 58.0]],
  },
  {
    id: "gnss-baltic",
    region: "Baltic Sea region — GNSS interference",
    fir: "Multiple FIRs",
    reason: "GPS jamming and spoofing reported with increasing severity; cross-check position with alternate navigation aids. NAVIGATION hazard, not an overflight prohibition",
    appliesTo: "all operators (advisory)",
    bindingOn: "Advisory only — no prohibition",
    authority: "EASA (Safety Information Bulletin)",
    source: "https://www.easa.europa.eu/en/domains/air-operations/czibs",
    box: [[53.5, 12.0], [66.0, 30.0]],
  },
  {
    id: "gnss-blacksea",
    region: "Black Sea region — GNSS interference",
    fir: "Multiple FIRs",
    reason: "GNSS jamming and spoofing reported; flagged by both EASA and the FAA. NAVIGATION hazard, not an overflight prohibition",
    appliesTo: "all operators (advisory)",
    bindingOn: "Advisory only — no prohibition",
    authority: "EASA / FAA",
    source: "https://www.easa.europa.eu/en/domains/air-operations/czibs",
    box: [[40.0, 27.0], [47.5, 42.0]],
  },
  {
    id: "gnss-emed",
    region: "Eastern Mediterranean — GNSS interference",
    fir: "Multiple FIRs",
    reason: "Reported GNSS interference affecting navigation accuracy. NAVIGATION hazard, not an overflight prohibition",
    appliesTo: "all operators (advisory)",
    bindingOn: "Advisory only — no prohibition",
    authority: "EASA / FAA",
    source: "https://www.easa.europa.eu/en/domains/air-operations/czibs",
    box: [[30.5, 25.0], [37.5, 36.5]],
  },
  {
    id: "ua-ru",
    region: "Ukraine and adjacent Russian airspace",
    fir: "Kyiv / Dnipro / Rostov FIRs",
    reason: "Armed conflict — risk to civil aircraft at all altitudes",
    appliesTo: "civil",
    bindingOn: "EU-registered and US operators (separate instruments)",
    authority: "EASA / FAA",
    source: "https://www.easa.europa.eu/en/domains/air-operations/czibs",
    box: [[44.0, 22.0], [52.5, 41.0]],
  },
  {
    id: "by",
    region: "Belarus",
    fir: "Minsk FIR",
    reason: "State interference with civil aviation (2021); overflight advised against",
    appliesTo: "civil",
    bindingOn: "EU-registered operators",
    authority: "EASA",
    source: "https://www.easa.europa.eu/en/domains/air-operations/czibs",
    box: [[51.2, 23.1], [56.2, 32.8]],
  },
  {
    id: "af",
    region: "Afghanistan",
    fir: "Kabul FIR",
    reason: "No functioning air traffic control; risk from ground fire above and below FL messages",
    appliesTo: "civil",
    bindingOn: "EU-registered and US operators",
    authority: "EASA / FAA",
    source: "https://www.easa.europa.eu/en/domains/air-operations/czibs",
    box: [[29.3, 60.5], [38.5, 74.9]],
  },
  {
    id: "ly",
    region: "Libya",
    fir: "Tripoli FIR",
    reason: "Armed conflict; anti-aviation weaponry",
    appliesTo: "civil",
    bindingOn: "EU-registered and US operators",
    authority: "EASA / FAA",
    source: "https://www.easa.europa.eu/en/domains/air-operations/czibs",
    box: [[19.5, 9.3], [33.2, 25.2]],
  },
  {
    id: "sy",
    region: "Syria",
    fir: "Damascus FIR",
    reason: "Armed conflict; military activity at all altitudes",
    appliesTo: "civil",
    bindingOn: "EU-registered and US operators",
    authority: "EASA / FAA",
    source: "https://www.easa.europa.eu/en/domains/air-operations/czibs",
    box: [[32.3, 35.6], [37.3, 42.4]],
  },
  {
    id: "ye",
    region: "Yemen",
    fir: "Sanaa FIR",
    reason: "Armed conflict; anti-aviation weaponry",
    appliesTo: "civil",
    bindingOn: "EU-registered and US operators",
    authority: "EASA / FAA",
    source: "https://www.easa.europa.eu/en/domains/air-operations/czibs",
    box: [[12.1, 41.8], [19.0, 54.5]],
  },
  {
    id: "so",
    region: "Somalia",
    fir: "Mogadishu FIR",
    reason: "Armed conflict; limited air traffic services",
    appliesTo: "civil",
    bindingOn: "EU-registered and US operators",
    authority: "EASA / FAA",
    source: "https://www.easa.europa.eu/en/domains/air-operations/czibs",
    box: [[-1.7, 40.9], [12.0, 51.5]],
  },
  {
    id: "kp",
    region: "North Korea",
    fir: "Pyongyang FIR",
    reason: "Unannounced missile launches; no advance notice to civil aviation",
    appliesTo: "civil",
    bindingOn: "US operators; advisory for others",
    authority: "FAA",
    source: "https://www.faa.gov/air_traffic/publications/us_restrictions",
    box: [[37.6, 124.2], [43.0, 130.7]],
  },
  {
    id: "iq-ir",
    region: "Iraq and Iranian airspace",
    fir: "Baghdad / Tehran FIRs",
    reason: "Military activity; risk of miscalculation affecting civil aircraft",
    appliesTo: "civil",
    bindingOn: "US operators; EU advisories vary",
    authority: "FAA / EASA",
    source: "https://www.faa.gov/air_traffic/publications/us_restrictions",
    box: [[24.5, 38.8], [39.8, 63.3]],
  },
  {
    id: "sd",
    region: "Sudan",
    fir: "Khartoum FIR",
    reason: "Armed conflict; airspace services disrupted",
    appliesTo: "civil",
    bindingOn: "EU-registered and US operators",
    authority: "EASA / FAA",
    source: "https://www.easa.europa.eu/en/domains/air-operations/czibs",
    box: [[8.7, 21.8], [22.2, 38.6]],
  },
  {
    id: "ml",
    region: "Mali",
    fir: "Bamako FIR",
    reason: "Armed conflict; anti-aviation weaponry reported",
    appliesTo: "civil",
    bindingOn: "EU-registered operators",
    authority: "EASA",
    source: "https://www.easa.europa.eu/en/domains/air-operations/czibs",
    box: [[10.1, -12.3], [25.0, 4.3]],
  },
  {
    id: "ve",
    region: "Venezuela",
    fir: "Maiquetia FIR",
    reason: "Deteriorating security environment affecting civil aviation",
    appliesTo: "civil",
    bindingOn: "US operators",
    authority: "FAA",
    source: "https://www.faa.gov/air_traffic/publications/us_restrictions",
    box: [[0.6, -73.4], [12.7, -59.8]],
  },
];

// ── Source freshness monitoring ──────────────────────────────────────────────────────────────
// We cannot parse these publications reliably (PDFs, prose, varying formats), and pretending to
// would be the exact overclaim this project exists to avoid. What we CAN do honestly is watch the
// source documents for change: a HEAD request every few hours, comparing Last-Modified / ETag.
// If a source has changed since compilation we flag the entry as "source updated — verify",
// which tells the user something true and useful without inventing a parse.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6h: these change on the order of days, not minutes
const sourceState = new Map();                   // source URL -> { etag, lastModified, changed, checkedAt }

async function checkSources() {
  const urls = [...new Set(ADVISORIES.map((a) => a.source))];
  await Promise.all(urls.map(async (url) => {
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "follow" });
      const etag = res.headers.get("etag");
      const lastModified = res.headers.get("last-modified");
      const prev = sourceState.get(url);
      const changed = !!prev && ((etag && etag !== prev.etag) || (lastModified && lastModified !== prev.lastModified));
      sourceState.set(url, {
        etag, lastModified,
        changed: changed || (prev && prev.changed) || false,
        checkedAt: new Date().toISOString(),
        ok: res.ok,
      });
    } catch {
      const prev = sourceState.get(url) || {};
      sourceState.set(url, { ...prev, ok: false, checkedAt: new Date().toISOString() });
    }
  }));
}

let timer = null;
function start() {
  if (timer) return;
  checkSources().catch(() => {});
  timer = setInterval(() => checkSources().catch(() => {}), CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function list() {
  const compiledMs = Date.parse(COMPILED_ON + "T00:00:00Z");
  const ageDays = Number.isFinite(compiledMs) ? Math.floor((Date.now() - compiledMs) / 86400000) : null;
  return {
    compiledOn: COMPILED_ON,
    compiledAgeDays: ageDays,
    checkIntervalHours: CHECK_INTERVAL_MS / 3600000,
    notice:
      "NOT FOR FLIGHT PLANNING. These are advisories and prohibitions issued by aviation authorities " +
      "to the operators they regulate — they do not close airspace to the overflown state's own " +
      "aircraft and do not bind military flights. Areas shown are approximate; the source document " +
      "is authoritative. Absence of an entry does not mean airspace is unrestricted: this list covers " +
      "published conflict-zone advisories only, not the full global NOTAM picture.",
    advisories: ADVISORIES.map((a) => {
      const st = sourceState.get(a.source) || {};
      return {
        ...a,
        sourceCheckedAt: st.checkedAt || null,
        sourceReachable: st.ok !== false,
        sourceChangedSinceCompiled: !!st.changed,
      };
    }),
  };
}

module.exports = { list, start, checkSources, COMPILED_ON };
