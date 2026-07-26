// StreetWatch — Claude proxy.
//
// ARCHITECTURE RULE, enforced throughout this file:
//   Compute what is computable; use the model only for language and open vocabulary.
//   Every endpoint here passes the model FACTS THAT WERE ALREADY COMPUTED (by geometry.js,
//   by SQL aggregates) and asks only for English. The model is never asked to measure a
//   distance, count a contact, or decide whether an aircraft is military — those answers
//   exist in the data and a model would only add doubt to them.
//
// Consequences of that rule, visible below:
//   - prompts contain numbers, never raw coordinate lists to "interpret"
//   - responses are capped short: this is narration, not analysis-from-scratch
//   - every response is returned with the computed facts alongside, so a reader can check
//     the words against the numbers
//
// COST: the API is billed per token. Guards here: small model by default, low max_tokens,
// aggressive caching keyed on the computed facts (identical facts => no second call),
// a hard daily call ceiling, and NOTHING runs automatically per-contact — narration is
// on-demand only.

const KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const API = "https://api.anthropic.com/v1/messages";
const DAILY_CAP = Number(process.env.AI_DAILY_CAP || 500);      // hard ceiling on calls/day
const CACHE_TTL_MS = Number(process.env.AI_CACHE_MS || 24 * 60 * 60 * 1000);

const cache = new Map();          // factsHash -> { at, payload }
let spend = { day: new Date().toISOString().slice(0, 10), calls: 0, inTok: 0, outTok: 0, errors: 0 };

function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (spend.day !== today) spend = { day: today, calls: 0, inTok: 0, outTok: 0, errors: 0 };
}

function hash(obj) {
  const s = JSON.stringify(obj);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

function configured() { return !!KEY; }

async function ask({ system, user, maxTokens = 300, cacheKey, cacheOnly = false }) {
  rollDay();
  if (!KEY) return { ok: false, reason: "not_configured" };

  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (!hit && cacheOnly) {
      // The caller's address is in cache-only mode (rate-limit escalation). Previously
      // generated analyses stay available; NEW model calls are refused until the window ends.
      // Same contract every other failure uses, so routes surface it without special cases.
      return { ok: false, reason: "cache_only" };
    }
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, text: hit.text, cached: true };
  }
  if (spend.calls >= DAILY_CAP) return { ok: false, reason: "daily_cap_reached" };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: ctrl.signal,
    });
    spend.calls++;
    if (!res.ok) {
      spend.errors++;
      let detail = "";
      try { detail = (await res.text()).slice(0, 300); } catch { /* body gone */ }
      return { ok: false, reason: `upstream_${res.status}`, detail };
    }
    const json = await res.json();
    if (json.usage) { spend.inTok += json.usage.input_tokens || 0; spend.outTok += json.usage.output_tokens || 0; }
    const text = (json.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    if (cacheKey) cache.set(cacheKey, { at: Date.now(), text });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return { ok: true, text };
  } catch (e) {
    spend.errors++;
    return { ok: false, reason: e.name === "AbortError" ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// 1. Track narration — geometry computed, model writes English
// ---------------------------------------------------------------------------
const TRACK_SYSTEM = `You explain aircraft track measurements to an informed reader in plain English.

You are given measurements that were ALREADY COMPUTED from recorded ADS-B positions. Never
recompute, contradict, or invent figures — use exactly the numbers provided.

Write 2-3 sentences, maximum 65 words. State what the flight profile looks like and what kind
of activity it is consistent with. Be specific about the numbers that justify your reading.

Rules you must follow:
- Say "consistent with" or "typical of", never assert intent or mission.
- Never name an operator, unit, or country unless it appears in the data given to you.
- Never speculate about what an aircraft was doing on the ground or why.
- If the data is thin (few points, short duration), say the reading is tentative.
- No preamble, no bullet points, no headings. Plain prose only.`;

async function narrateTrack({ geo, contact }, opts = {}) {
  const facts = {
    verdict: geo.verdict, points: geo.points, durationMin: geo.durationMin,
    pathNm: geo.pathNm, netNm: geo.netNm, straightness: geo.straightness,
    approxLaps: geo.approxLaps, meanRadiusNm: geo.meanRadiusNm,
    meanAltFt: geo.meanAltFt, altSpreadFt: geo.altSpreadFt, meanSpeedKt: geo.meanSpeedKt,
    callsign: contact && contact.callsign, kind: contact && contact.kind,
    confidence: contact && contact.confidence, site: contact && contact.site,
    country: contact && contact.country, type: contact && contact.typeCode,
  };
  const user =
`Computed track measurements:
${Object.entries(facts).filter(([, v]) => v != null && v !== "").map(([k, v]) => `- ${k}: ${v}`).join("\n")}

Notes on the measurements:
- straightness is net displacement divided by path length: 1.0 is a straight transit, near 0 means it returned to where it started.
- approxLaps is total accumulated turning divided by 360.
- These positions come only from the aircraft's own ADS-B broadcasts, sampled by a sweep that revisits each airspace periodically, so gaps are expected.

Explain this flight profile.`;
  return ask({ system: TRACK_SYSTEM, user, maxTokens: 220, cacheKey: "trk:" + hash(facts) , cacheOnly: !!opts.cacheOnly });
}

// ---------------------------------------------------------------------------
// 2. Natural-language search — model emits a FILTER, never data
// ---------------------------------------------------------------------------
const SEARCH_SYSTEM = `You convert a plain-English request into a JSON filter for a feed catalogue.

Respond with ONLY a JSON object, no markdown fence, no commentary.

Schema (omit any key you cannot determine — never guess):
{
  "layer": "aviation"|"marine"|"weather"|"webcam"|"wildlife"|"traffic"|"space",
  "text": "free-text terms to match against feed names and cities",
  "country": "country name as commonly written in English",
  "continent": "Europe"|"Asia"|"Africa"|"North America"|"South America"|"Oceania"|"Oceans",
  "bbox": [southLat, westLon, northLat, eastLon],
  "uavOnly": true,
  "days": 1-90,
  "intent": "browse"|"drones"|"activity"
}

Guidance:
- "drone"/"military"/"UAV" activity => "intent":"drones" and "uavOnly":true.
- "activity"/"busiest"/"hotspots"/"over the last N days" => "intent":"activity" with "days".
- Named seas and regions become a bbox. Black Sea is [40.9,27.4,46.6,41.8]. Baltic Sea is [53.9,9.4,65.9,30.3]. South China Sea is [3.0,105.0,23.0,121.0]. Persian Gulf is [23.5,47.5,30.5,57.0]. Mediterranean is [30.2,-6.0,45.8,36.2]. Norwegian coast is [57.9,4.0,71.4,31.1].
- If the request is vague, return only "text" with the user's key terms.`;

async function parseSearch(query, opts = {}) {
  const r = await ask({
    system: SEARCH_SYSTEM,
    user: String(query || "").slice(0, 400),
    maxTokens: 200,
    cacheKey: "qry:" + hash(String(query || "").toLowerCase().trim()),
    cacheOnly: !!opts.cacheOnly,
  });
  if (!r.ok) return r;
  let filter = null;
  try {
    filter = JSON.parse(r.text.replace(/```json|```/g, "").trim());
  } catch {
    return { ok: false, reason: "unparseable_filter", raw: r.text.slice(0, 200) };
  }
  return { ok: true, filter, cached: r.cached };
}

// ---------------------------------------------------------------------------
// 3. Weekly digest — deltas computed by SQL, model writes the briefing
// ---------------------------------------------------------------------------
const DIGEST_SYSTEM = `You write a short factual briefing about observed military and UAV air activity.

You are given counts that were ALREADY COMPUTED from a public archive. Use only those numbers.

CRITICAL — what the counts mean. Each airspace is polled over a 250 nautical mile radius, so a
site's headline figure counts aircraft across a WHOLE REGION, not aircraft at that base. Within
250nm of Eglin AFB, for example, lie many other airfields. You must never write "N contacts at
X" or "X recorded N contacts". Write "within 250nm of X" or "in the region around X". Where a
25nm figure is supplied, that one may be described as close to the base itself.

You are given TWO rankings: aircraft within 250nm (a whole region) and aircraft within 25nm
(the airfield itself). You must use BOTH. Lead with the 25nm ranking, because that is the one
that describes activity at bases. Where the two rankings disagree, say so explicitly and
explain what the difference means: a site with a large 250nm count and a small 25nm count sits
inside busy airspace without being busy itself. That divergence is the most useful thing in
this data — never omit it when it is present.

Write 120-180 words of PLAIN PROSE ONLY. No markdown, no "#" headings, no title, no bold, no
bullet points. Begin with the first sentence of the briefing itself.

You must include, in your own words, that these counts come only from aircraft broadcasting
ADS-B, so aircraft with transponders switched off are not represented, and that a difference in
counts may reflect observation coverage as easily as activity.

NEVER SAY "WORLDWIDE", "GLOBAL", or "ACROSS THE WORLD". The watch polls a rotating set of named
airspaces and grid cells — wide in reach, but nowhere near all global aviation, and each site is
revisited only periodically. Totals describe WHAT THIS WATCH RECORDED in the airspaces it polled
during the window. Say "across the watched airspaces" or "in the airspaces polled", never anything
that implies complete worldwide coverage.

UAV AND MILITARY COUNTS OVERLAP — they are not a breakdown of the total. Classification is stored
per observation, so an aircraft seen as military on one pass and as a UAV on another is counted in
both. When bothKinds is above zero, never present the two as if they sum to the total; say the
overlap exists if it is worth mentioning at all.

LEAD WITH GEOGRAPHY AND WITH THE FIELD-LEVEL RANKING. A digest that opens with a list of eight
airbase names tells the reader nothing about where in the world anything happened — start from the
country rollup, then name specific sites. And when you say a base was busy, use the AT THE FIELD
ranking, never the 250nm one. Where the two orderings DISAGREE, that disagreement is the most
interesting thing in the data and is worth stating plainly.

CRITICAL — OVERFLIGHT IS NOT USE. A contact counted "at" a site may simply have flown over it.
One aircraft crossing a continent passes within range of many sites and is counted at each. When a
site has a terminal figure (aircraft observed within 10nm BELOW 10,000ft — consistent with
arriving or departing), that is the figure that speaks to activity AT the base; the larger contact
count describes the surrounding airspace. Never describe a site as busy or active on the strength
of the regional count alone. And the terminal figure is an INFERENCE from altitude and proximity,
not an observed landing — say "consistent with" or "suggests", never "landed" or "took off".

CRITICAL — ABSENCE IS NOT EVIDENCE. Coverage is wildly uneven. The receiver network is
volunteer-fed and dense over North America, Europe and Japan; it is sparse over Russia, China,
Central Asia, Africa, and most oceans. Military aircraft in many countries do not broadcast at
all. Therefore you must NEVER write or imply that a region is quiet, inactive, or has no
military aviation because few or no contacts were recorded there. A low or zero count in such a
region means only that little was VISIBLE to public ADS-B. If a region with known sparse
coverage appears in the data with low counts, either omit it or state explicitly that the
figure reflects visibility rather than activity.

If told the archive does not yet cover the comparison window, say plainly that no
week-on-week comparison is possible yet and do not describe anything as new, rising or a first
appearance.

Never infer intent, mission, escalation, or geopolitical meaning. Report what was observed.`;

async function writeDigest(args, opts = {}) {
  const { windowDays, top, topNear, topField, countries, risers, newSites, totals,
                             sweepRadiusNm = 250, nearRadiusNm = 25, fieldRadiusNm = 10,
                             fieldCeilingFt = 4000, coversPrevWindow = true, archiveAgeHours = null } = args;
  const user =
`Archive window: last ${windowDays} days.
Each figure below counts DISTINCT aircraft seen within ${sweepRadiusNm}nm of the named site — a region, not the base itself.
Totals: ${totals.contacts} aircraft, ${totals.uav} UAV, ${totals.military} military, across ${totals.sites} airspaces.

BY COUNTRY — where the activity was, geographically:
${(countries || []).map((c) =>
  `- ${c.country}: ${c.contacts} aircraft across ${c.sites} airspaces (${c.uav} UAV); ${c.terminal} seen at a field`).join("\n") || "- none"}

Busiest AT THE FIELD — ranked by aircraft within ${fieldRadiusNm}nm AND below ${fieldCeilingFt}ft
(consistent with using the field rather than passing over it). THIS is the ranking that answers
"which bases were actually busy":
${(topField || []).map((s) =>
  `- ${s.site} (${s.country || "—"}): ${s.terminal} at the field; ${s.contacts} in the surrounding ${sweepRadiusNm}nm`).join("\n") || "- none recorded at field level in this window"}

Busiest LOCAL AIRSPACE — ranked by aircraft within ${nearRadiusNm}nm of the site:
${(topNear && topNear.length ? topNear : top).map((s) =>
  `- ${s.site} (${s.country || "—"}): ${s.nearContacts != null ? s.nearContacts : "?"} within ${nearRadiusNm}nm; ${s.contacts} within ${sweepRadiusNm}nm`).join("\n") || "- none"}

Busiest REGIONS — ranked by aircraft within ${sweepRadiusNm}nm (a region, not a base):
${top.map((s) => `- ${s.site} (${s.country || "—"}): ${s.contacts} aircraft, ${s.uav} UAV, ${s.military} military` +
    (s.nearContacts != null ? `; only ${s.nearContacts} within ${nearRadiusNm}nm` : "") +
    (s.terminal != null ? `; ${s.terminal} at the field` : "")).join("\n") || "- none"}

${coversPrevWindow
  ? `Largest increases vs the previous window:\n${risers.map((s) => `- ${s.site}: ${s.prev} -> ${s.now}`).join("\n") || "- none"}\n\nRegions producing their first recorded aircraft:\n${newSites.map((s) => `- ${s.site} (${s.country || "—"}): ${s.contacts}`).join("\n") || "- none"}`
  : `NO COMPARISON AVAILABLE: the archive only reaches back ${archiveAgeHours != null ? archiveAgeHours + " hours" : "less than the comparison window"}, which is shorter than the previous ${windowDays}-day window. Do not describe anything as new, rising, or a first appearance. State that week-on-week comparison is not yet possible.`}

Write the briefing.`;
  return ask({ system: DIGEST_SYSTEM, user, maxTokens: 420, cacheKey: "dig:" + hash({ windowDays, top, topNear, topField, countries, risers, newSites, totals, coversPrevWindow }) , cacheOnly: !!opts.cacheOnly });
}

// ---------------------------------------------------------------------------
// 4. Cross-domain correlation — co-occurrence computed, model proposes what to look at
// ---------------------------------------------------------------------------
const CORR_SYSTEM = `You describe co-occurrences between separate public datasets for a reader deciding what is worth a closer look.

You are given co-occurrences that were ALREADY COMPUTED. Use only those figures.

Write 80-140 words, plain prose. For each item, say plainly what was observed near what, and when.

You MUST state clearly that these are co-occurrences in time and space only, that no causal
link is implied or observable from public data, and that both datasets are incomplete
(aircraft with transponders off and vessels outside AIS coverage are absent).

Never suggest an operation, exercise, response, or intent. Never name a unit or adversary.`;

async function describeCorrelations({ windowDays, pairs }, opts = {}) {
  const user =
`Window: last ${windowDays} days.

Computed co-occurrences (an air airspace and a marine contact within 150nm and 7 days):
${pairs.map((p) => `- ${p.site}: ${p.airContacts} air contacts; nearby marine: ${p.vessel} (${p.vesselKind}) at ${p.distanceNm}nm, ${p.daysApart} days apart`).join("\n") || "- none"}

Describe what was observed.`;
  return ask({ system: CORR_SYSTEM, user, maxTokens: 320, cacheKey: "cor:" + hash({ windowDays, pairs }) , cacheOnly: !!opts.cacheOnly });
}

function status() {
  rollDay();
  return {
    configured: configured(),
    model: MODEL,
    dailyCap: DAILY_CAP,
    today: { calls: spend.calls, inputTokens: spend.inTok, outputTokens: spend.outTok, errors: spend.errors },
    cacheEntries: cache.size,
  };
}

module.exports = { configured, narrateTrack, parseSearch, writeDigest, describeCorrelations, status, _ask: ask, _cache: cache };
