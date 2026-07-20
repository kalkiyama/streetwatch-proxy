// Track geometry, computed — NOT inferred by a language model.
// An LLM asked "is this a racetrack orbit?" from raw coordinates will guess, confidently,
// and sometimes wrongly. Trigonometry does not guess. Compute the facts here; the model's
// job is only to explain them in English.
const R_NM = 3440.065;
const rad = (d) => d * Math.PI / 180;

function nm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat/2)**2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon/2)**2;
  return 2 * R_NM * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
            Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function analyse(points) {
  if (!points || points.length < 3) return { verdict: "insufficient", points: points ? points.length : 0 };
  const p = [...points].sort((a, b) => new Date(a.ts) - new Date(b.ts));

  let dist = 0;
  const legs = [];
  for (let i = 1; i < p.length; i++) {
    const d = nm(p[i-1], p[i]);
    dist += d;
    legs.push({ d, brg: bearing(p[i-1], p[i]),
      mins: (new Date(p[i].ts) - new Date(p[i-1].ts)) / 60000 });
  }
  const durMin = (new Date(p[p.length-1].ts) - new Date(p[0].ts)) / 60000;

  // net displacement vs path length: the single most diagnostic ratio.
  // ~1 = straight transit. ~0 = went nowhere (orbit, loiter, station-keeping).
  const net = nm(p[0], p[p.length-1]);
  const straightness = dist > 0 ? net / dist : 0;

  // centroid + radial spread: a tight radius with high path length means orbit
  const cLat = p.reduce((s, x) => s + x.lat, 0) / p.length;
  const cLon = p.reduce((s, x) => s + x.lon, 0) / p.length;
  const radii = p.map((x) => nm({lat:cLat,lon:cLon}, x));
  const rMean = radii.reduce((a,b)=>a+b,0) / radii.length;
  const rVar = Math.sqrt(radii.reduce((s,r)=>s+(r-rMean)**2,0) / radii.length);

  // cumulative turning: an orbit accumulates ~360°/lap; a transit accumulates ~0
  let turn = 0;
  for (let i = 1; i < legs.length; i++) {
    let d = legs[i].brg - legs[i-1].brg;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    turn += Math.abs(d);
  }

  const alts = p.map((x) => x.altFt).filter(Number.isFinite);
  const altSpread = alts.length ? Math.max(...alts) - Math.min(...alts) : null;
  const altMean = alts.length ? alts.reduce((a,b)=>a+b,0)/alts.length : null;
  const spd = dist / (durMin / 60);

  // deterministic verdict — thresholds, auditable, no model involved
  let verdict = "unclassified";
  if (straightness > 0.8) verdict = "transit";
  else if (straightness < 0.25 && turn > 300 && rVar / (rMean || 1) < 0.6) verdict = "orbit/loiter";
  else if (straightness < 0.5 && turn > 180) verdict = "manoeuvring";
  if (altSpread != null && altSpread > 15000 && straightness > 0.5) verdict += " with major altitude change";

  return {
    verdict, points: p.length,
    durationMin: Math.round(durMin),
    pathNm: +dist.toFixed(1), netNm: +net.toFixed(1),
    straightness: +straightness.toFixed(3),
    meanRadiusNm: +rMean.toFixed(1), radiusVarNm: +rVar.toFixed(1),
    totalTurnDeg: Math.round(turn),
    approxLaps: +(turn / 360).toFixed(1),
    meanAltFt: altMean ? Math.round(altMean) : null,
    altSpreadFt: altSpread,
    meanSpeedKt: Number.isFinite(spd) ? Math.round(spd) : null,
  };
}
module.exports = { analyse };
