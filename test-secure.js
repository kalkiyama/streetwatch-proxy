const assert = require("assert");
const http = require("http");
process.env.ALLOW_ORIGIN = "https://streetwatch-blond.vercel.app";
process.env.RATE_LIMIT = "5";
const AIRCRAFT = { ac: [{ hex:"a465df", flight:"UAL1310 ", lat:51.5, lon:-0.4, alt_baro:38000, gs:339, track:276 }], now:Date.now() };
const DT_LOC = { features: [{ mmsi:230012340, geometry:{ coordinates:[24.95,60.15] }, properties:{ sog:12, cog:145, heading:147 } }] };
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
const ALLOWED = "https://streetwatch-blond.vercel.app";
const server = createServer().listen(0, async () => {
  const port = server.address().port;
  const req = (path, origin) => new Promise((resolve, reject) => {
    http.get({ host:"127.0.0.1", port, path, headers: origin ? { Origin: origin } : {} }, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode, acao: res.headers["access-control-allow-origin"], body: d }));
    }).on("error", reject);
  });
  try {
    let r = await req("/api/aircraft?lat=51.47&lon=-0.45&radius=75", ALLOWED);
    assert.strictEqual(r.acao, ALLOWED, "echoes allowed origin");
    console.log("PASS  allowed origin -> ACAO echoed");
    r = await req("/api/aircraft?lat=51.47&lon=-0.45&radius=75", "https://evil.example.com");
    assert.strictEqual(r.acao, undefined, "no ACAO for disallowed origin");
    console.log("PASS  disallowed origin -> ACAO withheld");
    r = await req("/api/vessels?lat=60.15&lon=24.95&radius=40", ALLOWED); let j = JSON.parse(r.body);
    assert.ok(j.count >= 1 && j.vessels[0].name === "AURORA BOTNIA");
    console.log("PASS  /api/vessels via central handler works");
    r = await req("/api/aircraft?lat=999&lon=0"); assert.strictEqual(r.status, 400);
    console.log("PASS  bad params -> 400");
    let got429 = false;
    for (let i = 0; i < 8; i++) { const rr = await req("/api/aircraft?lat=1&lon=1&radius=10"); if (rr.status === 429) { got429 = true; break; } }
    assert.ok(got429, "rate limiter trips");
    console.log("PASS  exceeding RATE_LIMIT -> 429");
    r = await req("/health"); j = JSON.parse(r.body); assert.strictEqual(j.ok, true);
    console.log("PASS  /health exempt from rate limit");
    console.log("\nSECURITY HARDENING OK");
    server.close();
  } catch(e){ console.error("FAIL:", e.message); server.close(); process.exit(1); }
});
