const assert = require("assert");
// Mock both upstreams (sandbox can't reach them).
const AIRCRAFT = { ac: [
  { hex:"a465df", flight:"UAL1310 ", r:"N38257", t:"B738", lat:51.5, lon:-0.4, alt_baro:38000, gs:339, track:276, category:"A3" },
  { hex:"ae1234", flight:"REAPER01", t:"MQ9", lat:51.6, lon:-0.5, alt_baro:22000, gs:170, track:90, category:"B6" },
  { hex:"ae5678", flight:"RCH471", t:"C17", lat:51.7, lon:-0.6, alt_baro:28000, gs:420, track:180, category:"A5", dbFlags:1 },
  { hex:"abcd01", flight:"N12345", t:"C182", desc:"CESSNA 182 Skylane", lat:51.8, lon:-0.7, alt_baro:4000, gs:120, track:45, category:"B6" },
], now:Date.now() };
const DT_LOC = { features: [{ mmsi:230012340, geometry:{ type:"Point", coordinates:[24.95,60.15] }, properties:{ sog:12, cog:145, navStat:0, heading:147 } }] };
const DT_VES = [{ mmsi:230012340, name:"AURORA BOTNIA", shipType:60 }];
const real = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url) => {
  const s = String(url);
  if (s.includes("airplanes.live") || s.includes("/v2/point")) return { ok:true, status:200, json: async()=>AIRCRAFT };
  if (s.includes("digitraffic") && s.includes("/locations")) return { ok:true, status:200, json: async()=>DT_LOC };
  if (s.includes("digitraffic") && s.includes("/vessels")) return { ok:true, status:200, json: async()=>DT_VES };
  return real(url);
};
const { createServer } = require("./server.js");
const server = createServer().listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${base}/health`); let j = await r.json();
    assert.strictEqual(j.ok, true); assert.deepStrictEqual(j.services, ["aircraft","vessels","drones"]);
    console.log("PASS  /health -> both services up");
    r = await fetch(`${base}/api/aircraft?lat=51.47&lon=-0.45&radius=75`); j = await r.json();
    assert.strictEqual(r.status,200); assert.ok(j.count>=4 && j.aircraft.some(a=>a.callsign==="UAL1310"));
    const drone = j.aircraft.find(a=>a.category==="B6");
    assert.ok(drone && drone.isDrone === true && drone.callsign === "REAPER01", "B6 contact flagged as drone");
    console.log(`PASS  /api/aircraft -> ${j.count} aircraft (incl. 1 UAV flagged isDrone)`);
    r = await fetch(`${base}/api/vessels?lat=60.15&lon=24.95&radius=40`); j = await r.json();
    assert.strictEqual(r.status,200); assert.ok(j.count>=1 && j.vessels[0].name==="AURORA BOTNIA");
    console.log(`PASS  /api/vessels -> ${j.count} vessels`);

    // global drone sweep: force one pass, then read the aggregate
    await require("./drone-sweep.js")._sweepOnce();
    r = await fetch(`${base}/api/drones`); j = await r.json();
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(j.drones) && j.sweep && j.sweep.sites >= 20, "drones payload shape");
    assert.ok(j.drones.some((d) => d.id === "ae1234" && d.kind === "uav"), "B6 contact classified as uav");
    assert.ok(j.drones.some((d) => d.id === "ae5678" && d.kind === "military"), "dbFlags contact classified as military");
    assert.ok(j.counts && j.counts.uav >= 1 && j.counts.military >= 1, "counts by kind");
    const cess = j.drones.find((d) => d.id === "abcd01");
    assert.ok(cess && cess.confidence === "disputed", "B6-claiming Cessna marked disputed");
    // ae1234 carries BOTH a registry type (MQ9) and category B6; registry type wins, and the
    // label now says so. Under the old blanket "confirmed" this precedence was invisible.
    assert.ok(j.drones.find((d) => d.id === "ae1234").confidence === "registry_type", "registry type takes precedence over self-declared category");
    assert.ok(j.counts.disputed >= 1, "disputed counted");
    assert.ok(j.drones[0].site && j.drones[0].country, "sighting carries site + country");
    console.log(`PASS  /api/drones -> ${j.count} live drone(s) across ${j.sweep.sites} sites`);
    r = await fetch(`${base}/api/drones/track?id=ae1234`); j = await r.json();
    assert.strictEqual(r.status, 200); assert.ok(Array.isArray(j.track) && j.track.length >= 1, "track returned");
    console.log(`PASS  /api/drones/track -> ${j.track.length} point(s)`);
    // Two entries at the same coordinates are the SAME AIRFIELD under two names. Name-based
    // dedupe cannot see this: on Jul 26 an exact-name pass caught six duplicates, but
    // Vladivostok/Baku/Yerevan each appeared twice at 0.1-0.3nm under DIFFERENT names and
    // survived both that pass and a duplicate-name check run the same day. No radius fixes a
    // 0.1nm pair — it collides at every threshold, and tightening only makes the wrong
    // attribution more confident — so it has to be caught at the LIST, not at query time.
    // 1nm, not 5nm: 5nm fails on legitimately close neighbours (Eglin/Hurlburt 9.3nm are fine
    // as separate sites); what this catches is duplicate ENTRY, not close geography.
    {
      const { SITES } = require("./drone-sweep.js");
      const named = SITES.filter((s) => s[1] !== "Deep sweep");
      const nmBetween = (a, b, c, d) => {
        const rad = (x) => (x * Math.PI) / 180, dLa = rad(c - a), dLo = rad(d - b);
        const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLo / 2) ** 2;
        return 2 * (6371.0088 / 1.852) * Math.asin(Math.sqrt(h));
      };
      const collisions = [];
      for (let i = 0; i < named.length; i++)
        for (let k = i + 1; k < named.length; k++) {
          const d = nmBetween(named[i][2], named[i][3], named[k][2], named[k][3]);
          if (d < 1) collisions.push(`${named[i][0]} <-> ${named[k][0]} (${d.toFixed(2)}nm)`);
        }
      assert.strictEqual(collisions.length, 0,
        `named sites within 1nm of each other:\n  ${collisions.join("\n  ")}`);
      const dupNames = {};
      named.forEach((s) => { dupNames[s[0]] = (dupNames[s[0]] || 0) + 1; });
      const dupes = Object.keys(dupNames).filter((k) => dupNames[k] > 1);
      assert.strictEqual(dupes.length, 0, `duplicate site names: ${dupes.join(", ")}`);
      console.log(`PASS  site list -> ${named.length} named sites, no pair within 1nm, no duplicate names`);
    }
    r = await fetch(`${base}/nope`); assert.strictEqual(r.status,404);
    console.log("PASS  unknown route -> 404 with route hints");
    console.log("\nCOMBINED SERVICE OK");
    server.close();
  } catch(e){ console.error("FAIL:", e.message); server.close(); process.exit(1); }
});
