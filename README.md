# StreetWatch Proxy

The backend for **[streetwatch.earth](https://streetwatch.earth)** — a zero-dependency Node
service that serves live aircraft and vessel positions, runs a tiered rotating sweep over 1,081
airspaces — active sites every ~30 minutes, the global grid every few days — watching for military
and UAV activity, archives what it sees for 90 days, and
exposes that history as queryable analysis.

Frontend lives in a separate repo. This service is usable on its own.

## The rule the API follows

Every response states its scope. A count is never returned without the window and radius it
was measured over. Contacts are separated by altitude so an aircraft overflying at 35,000 ft
is not reported as using the field beneath it. Proximity to a watched site is described as
proximity, never as arrival — the nearest *watched site* is not necessarily the nearest
*airfield*, and responses say so. An empty result means "not visible to public ADS-B", never
"nothing happened". The archive holds military and UAV contacts only; civil traffic is never
recorded, and the payload states it.

This is deliberate. The hard problem in this domain is not fetching data, it is not
overclaiming once you have it.

## Run

```bash
npm start          # node server.js, listens on $PORT (default 8080)
```

No dependencies. Node 18+.

**Render:** New → Blueprint → select repo → Apply (`render.yaml` included).

## Before every push

```bash
SWEEP_INTERVAL_MS=999999 node test-combined.js
node test-secure.js
```

Both must pass. The `SWEEP_INTERVAL_MS` override stops the sweep firing during tests.

## Endpoints

### Live
| Route | Returns |
|---|---|
| `GET /api/aircraft?lat=&lon=&radius=` | Aircraft near a point. Radius capped at 250 nm (upstream limit) |
| `GET /api/vessels?lat=&lon=&radius=` | Vessels near a point, merged across providers |
| `GET /api/usv` | Vessels matching uncrewed-surface heuristics — candidates, labelled as such |
| `GET /api/subsupport` | Surface vessels supporting underwater operations (not submarines) |
| `GET /api/drones` | Planet-wide sweep state: current military/UAV contacts by site |
| `GET /api/drones/track` | Position history for one contact |
| `GET /api/drones/coverage` | Which sites are in which rotation tier, and when each was last polled |
| `GET /api/airspace/advisories` | Airspace advisories |
| `GET /api/webcams` | Windy webcams near a point |

### Archive (90 days)
| Route | Returns |
|---|---|
| `GET /api/drones/heat?days=` | Activity per site, split into terminal / regional / overflight |
| `GET /api/drones/history?icao=&since=` | Track history for one airframe |
| `GET /api/drones/multistop` | Itineraries — one airframe across several sites, linked by ICAO address |
| `GET /api/drones/archive-stats`, `GET /api/archive/stats` | Archive size and span |

Multi-stop itineraries link legs by **ICAO 24-bit address**, not callsign. The address is tied
to the airframe; callsigns change per mission, which is why one itinerary carries several.

### AI
`GET /api/ai/digest` · `/search` · `/track` · `/correlations` · `/status`

Hard-capped: 500 calls/day, 8 per IP per 10 minutes, then a 5-minute hold, then cache-only
until UTC midnight. Responses are cached 24 h by default.

### Ops
`GET /health` · `GET /metrics`

`/metrics` returns counters only — no user data, no coordinates, no keys. Uptime, memory,
cache hit ratio, upstream latency and errors, sweep tier populations, unique API visitors.

## Configuration

All optional unless marked.

### Core
| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `ALLOW_ORIGIN` | — | Comma-separated allowed origins (CORS) |
| `RATE_LIMIT` | `120` | Requests per IP per minute |

### Aircraft
| Var | Default | Purpose |
|---|---|---|
| `ADSB_UPSTREAMS` | — | Comma-separated sources, tried in order on failure |
| `ADSB_CACHE_MS` | `20000` | Serve from cache below this age |
| `ADSB_STALE_MS` | `60000` | Serve stale instantly while refreshing in background |
| `ADSB_TIMEOUT_MS` | `5000` | Upstream timeout |

Between `ADSB_CACHE_MS` and `ADSB_STALE_MS` the response is marked `stale: true` with an
`ageSec` — served instantly, refreshed behind the request. Aircraft move ~2 nm in 20 s,
imperceptible at radar scale.

### Vessels
| Var | Default | Purpose |
|---|---|---|
| `AIS_PROVIDER` | — | Comma-separated: `digitraffic,kystverket,aisstream` |
| `AISSTREAM_KEY` | — | **Required** for aisstream |
| `DIGITRAFFIC_USER` | — | Digitraffic courtesy identifier |
| `KYSTVERKET_HOST` / `_PORT` | — | Override the Norwegian TCP feed |

| Provider | Coverage | Key | Transport |
|---|---|---|---|
| `digitraffic` | Baltic Sea | none | REST poll |
| `kystverket` | Norwegian coast + Svalbard | none | raw TCP NMEA (AIVDM decoded in-process) |
| `aisstream` | Global | free | WebSocket |

All enabled providers **merge**, deduped by MMSI, streamed records winning on overlap. The
`coverage` string is built from sources actually delivering, not sources enabled — so no
global claim is made while a global source is down. aisstream is intermittent; when it drops,
coverage degrades to the regional sources and the response says so.

### Sweep
| Var | Default | Purpose |
|---|---|---|
| `SWEEP_INTERVAL_MS` | — | Pass interval. Set high to disable during tests |
| `SWEEP_DISABLED` | — | Disable entirely |
| `SWEEP_MAX_PASS` | — | Max sites polled per pass |
| `SWEEP_HOT_HOURS` | — | How recently a site must have had a hit to count as hot |
| `SWEEP_WARM_EVERY` / `_COLD_EVERY` / `_DEEP_EVERY` | — | Rotation divisors per tier |
| `SWEEP_RESERVE` | — | Slots reserved for breadth so cold and deep never stall |
| `AMBIGUOUS_SITE_NM` | `15` | Distance below which two sites are flagged as ambiguous |

Sites are tiered hot / warm / cold / deep by recent activity. Deep cells are a global grid
that self-promotes on first hit. **Note:** `namedSites + deepCells !== sites` — `deepCells` is
a tier population that shrinks as cells promote, not a partition of the list.

`AMBIGUOUS_SITE_NM` exists because watched sites can sit close enough that one approach
plausibly belongs to either — Eglin and Hurlburt are 9.3 nm apart against a 10 nm terminal
radius. Affected sites are returned with a `nearbySites` list so the ambiguity is visible
rather than silently resolved.

### Archive
| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Postgres. Without it the archive is disabled; live endpoints still work |
| `ARCHIVE_RETAIN_DAYS` | `90` | Retention |
| `ARCHIVE_FLUSH_MS` / `_MAX` | — | Write batching (keeps a serverless Postgres idle) |
| `ARCHIVE_MAX_ROWS` | — | Hard row cap |
| `VISIT_GAP_HOURS` | — | Gap that separates two visits to the same site |

### AI
| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for `/api/ai/*` |
| `ANTHROPIC_MODEL` | — | Model override |
| `AI_DAILY_CAP` | `500` | Hard daily call cap |
| `AI_CACHE_MS` | `86400000` | Response cache TTL |

### Other
`WINDY_KEY` for webcams.

## Honest limits

- 250 nm is the upstream per-query maximum, not a setting. Wider coverage is what the sweep
  is for.
- Barometric altitude is above sea level, not above field elevation — altitude ceilings are
  less accurate at high-elevation airfields.
- The sweep's cache hit ratio is ~0 by design: a rotating sweep never re-requests the same
  location within a TTL. The cache serves user-driven radar views, which do repeat.
- No free global keyless REST AIS exists. Keyless marine is regional; global needs a free key.
- Vessel positions are held in memory with a 10-minute eviction and are **not** archived —
  there is no vessel history to query.

## Attribution
Aircraft: airplanes.live · Vessels: Fintraffic Digitraffic, Kystverket, aisstream.io ·
Webcams: Windy
