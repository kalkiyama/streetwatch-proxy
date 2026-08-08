// StreetWatch — cyber activity. Three public sources, no invented relationships.
//
// WHY THIS EXISTS, AND WHAT IT REFUSES TO DO. Every well-known "live cyber attack map" — Norse
// (dead since 2016), Kaspersky, Fortinet, Check Point — animates arcs as missiles between
// countries. Those maps are marketing: their goal is a rotating globe on a trade-show screen, and
// the arc implies an attribution the data cannot support.
//
// CLOUDFLARE DOES PUBLISH REAL ORIGIN->TARGET PAIRS, so the arcs are not fabricated. What IS
// fabricated on every competitor's map is the MEANING. Read Cloudflare's own wording:
//   "top layer 3 attacks from origin to target location ... (with billing country)"
// The TARGET is where Cloudflare's CUSTOMER IS BILLED, not necessarily where the attacked server
// sits. The ORIGIN is a geolocated source IP, which for a botnet is compromised machines, not the
// operator. So "BR -> US 5.8%" honestly means: 5.8% of layer-3 attack traffic by volume came from
// IPs geolocated in Brazil, against Cloudflare customers billed in the United States.
// It is NOT "Brazil attacked America". The arc is honest; the UNLABELLED arc is the lie.
// The clearest proof sits in the data itself: US -> US at 3.35%, compromised machines inside the
// United States hitting US-billed customers. No missile animation can draw that truthfully.
//
// "LAST 24 HOURS", NEVER "LIVE". Measured before writing this: the window is hour-aligned and
// lastUpdated ran 15 minutes behind the window close. Hourly refresh is not live, and every
// competitor implies real-time.
//
// UNITS ARE BYTES. The percentage is a share of attack traffic VOLUME, not a count of attacks, so
// one large DDoS dominates the ranking. Stated in the payload rather than left for the reader.
//
// LICENCE. Cloudflare Radar is CC BY-NC 4.0 — NON-COMMERCIAL. This is the FIRST source in
// StreetWatch carrying a restriction; everything else is CC0 or open government. Fine while the
// product is free and ad-free. It would bite if that changed.

const CF = "https://api.cloudflare.com/client/v4/radar";
const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const TOKEN = process.env.CF_RADAR_TOKEN || "";

// Cloudflare recomputes hourly; KEV updates roughly daily. Caching under those cadences would just
// spend rate limit on identical answers. Separate TTLs because the sources are NOT equally fresh,
// and the payload says which is which rather than implying they refresh together.
const TTL_FLOWS = Number(process.env.CYBER_TTL_MS || 15 * 60 * 1000);
const TTL_KEV = Number(process.env.CYBER_KEV_TTL_MS || 6 * 60 * 60 * 1000);
const cache = new Map();

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return { ...hit.payload, cached: true };
  try {
    const payload = await fn();
    cache.set(key, { at: Date.now(), payload });
    return { ...payload, cached: false };
  } catch (e) {
    // STALE BEATS EMPTY. An upstream blip should not blank a panel that was correct a minute ago —
    // but the response says it is stale, because a silently old number is the defect this project
    // keeps finding.
    if (hit) return { ...hit.payload, cached: true, stale: true, error: e.message };
    throw e;
  }
}

async function cf(path) {
  if (!TOKEN) throw new Error("CF_RADAR_TOKEN not set");
  const r = await fetch(`${CF}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`cloudflare ${r.status}`);
  const j = await r.json();
  if (!j.success) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || "cloudflare error");
  return j.result;
}

// Attack flows: origin -> target pairs, share of layer-3 attack traffic BY VOLUME.
async function flows(limit = 12) {
  return cached("flows", TTL_FLOWS, async () => {
    const r = await cf(`/attacks/layer3/top/attacks?dateRange=1d&limit=${limit}&format=json`);
    const m = r.meta || {};
    const range = (m.dateRange && m.dateRange[0]) || {};
    return {
      source: "Cloudflare Radar",
      licence: "CC BY-NC 4.0",
      windowStart: range.startTime || null,
      windowEnd: range.endTime || null,
      computedAt: m.lastUpdated || null,
      units: "percentage of layer 3 attack traffic by volume (bytes)",
      // THE LABEL IS PART OF THE DATA, not a footnote the UI may drop. A client rendering an arc
      // without this is making a claim the payload explicitly does not.
      originMeans: "country of the geolocated source IP — for a botnet, compromised machines rather than the operator",
      targetMeans: "billing country of the Cloudflare customer attacked, not necessarily where the server sits",
      flows: (r.top_0 || []).map((x) => ({
        origin: x.originCountryAlpha2,
        originName: x.originCountryName,
        target: x.targetCountryAlpha2,
        targetName: x.targetCountryName,
        pct: Number(x.value),
        // Same country both ends: compromised machines attacking customers billed in their own
        // country. Roughly a third of the top flow on first measurement. Flagged because it is the
        // single clearest demonstration that these arcs are not nation-versus-nation.
        domestic: x.originCountryAlpha2 === x.targetCountryAlpha2,
      })),
    };
  });
}

// Internet outages and disruptions, with cause where Cloudflare has established one.
async function outages(days = 7, limit = 20) {
  return cached(`outages:${days}`, TTL_FLOWS, async () => {
    const r = await cf(`/annotations/outages?dateRange=${days}d&limit=${limit}&format=json`);
    return {
      source: "Cloudflare Radar",
      licence: "CC BY-NC 4.0",
      basis: "observed traffic drops, annotated by Cloudflare with a cause where one is established",
      // SOME OUTAGES ARE SCOPED TO A NETWORK, NOT A COUNTRY. TurkNet (AS12735) appeared with an
      // EMPTY locations array and its country buried in asnsDetails[].location — so a panel reading
      // `locations` alone would render a blank where a country belongs, which is the "empty means
      // unknown, not nothing" defect this project keeps finding.
      // The country is recovered from the ASN detail, and `scopedTo` says which kind it is so the
      // UI can show "TurkNet (AS12735)" rather than implying the whole of Turkey went dark.
      outages: (r.annotations || []).map((a) => {
        const asnDetails = a.asnsDetails || [];
        const fromAsn = asnDetails
          .map((x) => x.location)
          .filter((l) => l && l.code);
        const codes = (a.locations && a.locations.length)
          ? a.locations : [...new Set(fromAsn.map((l) => l.code))];
        const names = (a.locationsDetails && a.locationsDetails.length)
          ? a.locationsDetails.map((l) => l.name)
          : [...new Set(fromAsn.map((l) => l.name))];
        return {
        id: a.id,
        countries: codes,
        countryNames: names,
        // NATIONWIDE or one provider — a very different claim, and the payload should not leave
        // the client to guess from an empty array.
        scopedTo: (a.locations && a.locations.length) ? "country" : (asnDetails.length ? "network" : "unknown"),
        networks: asnDetails.map((x) => ({ asn: x.asn, name: x.name })),
        start: a.startDate,
        end: a.endDate || null,          // null = still ongoing
        cause: (a.outage && a.outage.outageCause) || null,
        scope: (a.outage && a.outage.outageType) || null,
        description: a.description || null,
        link: a.linkedUrl || null,
        };
      }),
    };
  });
}

// CISA Known Exploited Vulnerabilities — CONFIRMED under active exploitation, not merely reported.
// No key, no rate limit, US government public domain.
async function kev(limit = 25) {
  return cached(`kev:${limit}`, TTL_KEV, async () => {
    const r = await fetch(KEV_URL, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`cisa ${r.status}`);
    const j = await r.json();
    return {
      source: "CISA Known Exploited Vulnerabilities",
      licence: "US Government public domain",
      // A DIFFERENT CADENCE FROM THE CLOUDFLARE PANELS, and the client must not present them as
      // equally fresh. KEV moves roughly daily; the attack flows move hourly.
      catalogReleased: j.dateReleased || null,
      total: j.count || (j.vulnerabilities || []).length,
      basis: "vulnerabilities CISA has confirmed are being actively exploited — not a list of what exists",
      vulnerabilities: (j.vulnerabilities || [])
        .slice()
        .sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded)))
        .slice(0, limit)
        .map((v) => ({
          cve: v.cveID,
          vendor: v.vendorProject,
          product: v.product,
          name: v.vulnerabilityName,
          added: v.dateAdded,
          dueDate: v.dueDate,
          ransomware: v.knownRansomwareCampaignUse === "Known",
        })),
    };
  });
}

function configured() { return !!TOKEN; }

module.exports = { flows, outages, kev, configured };
