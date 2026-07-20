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

async function ask({ system, user, maxTokens = 300, cacheKey }) {
  rollDay();
  if (!KEY) return { ok: false, reason: "not_configured" };

  if (cacheKey) {
    const hit = cache.get(cacheKey);
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

async function narrateTrack({ geo, contact }) {
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
  return ask({ system: TRACK_SYSTEM, user, maxTokens: 220, cacheKey: "trk:" + hash(facts) });
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

async function parseSearch(query) {
  const r = await ask({
    system: SEARCH_SYSTEM,
    user: String(query || "").slice(0, 400),
    maxTokens: 200,
    cacheKey: "qry:" + hash(String(query || "").toLowerCase().trim()),
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
const DIGEST_SYSTEM = `You write a short factual briefing about changes in observed military and UAV air activity.

You are given counts that were ALREADY COMPUTED from a public archive. Use only those numbers.

Write 120-180 words, plain prose, no bullet points or headings. Lead with the largest change.
Name airspaces and figures precisely.

You must include, in your own words, that these counts come only from aircraft broadcasting
ADS-B, so aircraft with transponders switched off are not represented, and that a change in
counts may reflect changes in observation as easily as changes in activity.

Never infer intent, mission, escalation, or geopolitical meaning. Report what was observed.`;

async function writeDigest({ windowDays, top, risers, newSites, totals }) {
  const user =
`Archive window: last ${windowDays} days.
Totals: ${totals.contacts} contacts, ${totals.uav} UAV, ${totals.military} military, across ${totals.sites} airspaces.

Busiest airspaces (contacts this window):
${top.map((s) => `- ${s.site} (${s.country || "—"}): ${s.contacts} contacts, ${s.uav} UAV, ${s.military} military`).join("\n") || "- none"}

Largest increases vs the previous window:
${risers.map((s) => `- ${s.site}: ${s.prev} -> ${s.now} contacts`).join("\n") || "- none"}

Airspaces producing their first recorded contacts:
${newSites.map((s) => `- ${s.site} (${s.country || "—"}): ${s.contacts}`).join("\n") || "- none"}

Write the briefing.`;
  return ask({ system: DIGEST_SYSTEM, user, maxTokens: 420, cacheKey: "dig:" + hash({ windowDays, top, risers, newSites, totals }) });
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

async function describeCorrelations({ windowDays, pairs }) {
  const user =
`Window: last ${windowDays} days.

Computed co-occurrences (an air airspace and a marine contact within 150nm and 7 days):
${pairs.map((p) => `- ${p.site}: ${p.airContacts} air contacts; nearby marine: ${p.vessel} (${p.vesselKind}) at ${p.distanceNm}nm, ${p.daysApart} days apart`).join("\n") || "- none"}

Describe what was observed.`;
  return ask({ system: CORR_SYSTEM, user, maxTokens: 320, cacheKey: "cor:" + hash({ windowDays, pairs }) });
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
