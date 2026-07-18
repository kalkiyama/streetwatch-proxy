const assert = require("assert");
// Mock both upstreams (sandbox can't reach them).
const AIRCRAFT = { ac: [
  { hex:"a465df", flight:"UAL1310 ", r:"N38257", t:"B738", lat:51.5, lon:-0.4, alt_baro:38000, gs:339, track:276, category:"A3" },
  { hex:"ae1234", flight:"REAPER01", t:"MQ9", lat:51.6, lon:-0.5, alt_baro:22000, gs:170, track:90, category:"B6" },
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
    assert.strictEqual(j.ok, true); assert.deepStrictEqual(j.services, ["aircraft","vessels"]);
    console.log("PASS  /health -> both services up");
    r = await fetch(`${base}/api/aircraft?lat=51.47&lon=-0.45&radius=75`); j = await r.json();
    assert.strictEqual(r.status,200); assert.ok(j.count>=2 && j.aircraft.some(a=>a.callsign==="UAL1310"));
    const drone = j.aircraft.find(a=>a.category==="B6");
    assert.ok(drone && drone.isDrone === true && drone.callsign === "REAPER01", "B6 contact flagged as drone");
    console.log(`PASS  /api/aircraft -> ${j.count} aircraft (incl. 1 UAV flagged isDrone)`);
    r = await fetch(`${base}/api/vessels?lat=60.15&lon=24.95&radius=40`); j = await r.json();
    assert.strictEqual(r.status,200); assert.ok(j.count>=1 && j.vessels[0].name==="AURORA BOTNIA");
    console.log(`PASS  /api/vessels -> ${j.count} vessels`);
    r = await fetch(`${base}/nope`); assert.strictEqual(r.status,404);
    console.log("PASS  unknown route -> 404 with route hints");
    console.log("\nCOMBINED SERVICE OK");
    server.close();
  } catch(e){ console.error("FAIL:", e.message); server.close(); process.exit(1); }
});
