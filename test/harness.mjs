// Runs app.js in Node against live data with a minimal fake DOM, then prints every section's text.
// Usage: node test/harness.mjs          (from the repo root; reads data/ if present, else the rooms)
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const els = {};
function el(id) {
  if (els[id]) return els[id];
  const o = {
    id, innerHTML: "", textContent: "", className: "", value: "", style: {},
    addEventListener() {}, setAttribute() {}, getBoundingClientRect() { return { left: 0, width: 460 }; },
    querySelector() { return o; }, querySelectorAll() { return [o]; },
  };
  return (els[id] = o);
}
globalThis.document = { getElementById: el, documentElement: { clientWidth: 400 } };
globalThis.window = { scrollX: 0 }; globalThis.matchMedia = () => ({ matches: false }); globalThis.localStorage = { getItem: () => null, setItem() {} }; document.documentElement.getAttribute = () => null; document.documentElement.setAttribute = () => {};
globalThis.setInterval = () => 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (typeof url === "string" && url.startsWith("data/")) {
    try { const body = await readFile(path.join(ROOT, url), "utf8"); return new Response(body, { status: 200 }); }
    catch { return new Response("", { status: 404 }); }
  }
  return realFetch(url, opts);
};
globalThis.__NO_AUTO_INIT = true;

const app = await import(path.join(ROOT, "app.js"));
const t0 = Date.now();
await app.init();
const text = (id) => (els[id]?.textContent || els[id]?.innerHTML || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const fail = [];
const expect = (cond, msg) => { if (!cond) fail.push(msg); };

console.log("status   :", text("status"));
console.log("verify   :", text("verifyBadges"));
console.log("tiles    :", text("tiles").slice(0, 400));
console.log("boardNote:", text("boardNote"));
console.log("board    :", text("board").slice(0, 500));
expect(/Sweep \d+/.test(text("status")), "status has a sweep number");
expect(/verified/.test(text("verifyBadges")), "verification badge present");
expect(text("board").includes("FLOP if final"), "standings rendered");
expect(app.standings().length > 0, "standings non-empty");
expect(app.st.live.px > 0, "Hyperliquid live price fetched");

app.st.view = "board"; el("board").innerHTML = "";
await (async () => {})();
// re-render board view through the exported pieces: standings() reflects the view
expect(app.standings()[0].settle === app.standings()[0].score, "board view uses published score");
app.st.view = "live";

el("solQ").value = "44"; el("solB").value = "226.90"; app.solve();
console.log("solver   :", text("solOut").slice(0, 300));
expect(/To pass the leader/.test(text("solOut")), "solver output");

el("recIn").value = ["e781-984522 buy 5 224.77", "e781-588684 buy 5 224.76", "e781-c5b71a buy 5 225.14", "e781-1b6471 buy 5 225.06",
  "e781-e3de5a buy 5 224.45", "e781-6672dd buy 5 224.49", "e781-6d2047 buy 5 224.25", "e781-201554 buy 5 224.18",
  "e781-a4ddb1 buy 1 225.07", "e781-255361 buy 1 225.09", "e781-d40681 buy 1 224.48", "e781-ff1f26 buy 1 224.59", "e781-0477ec buy 5 225.00", "nonsense"].join("\n");
await app.reconcile();
const rec = text("recOut");
console.log("reconcile:", rec.slice(rec.indexOf("Net position"), rec.indexOf("Net position") + 260));
expect(/Net position \+44\.00 contracts/.test(rec), "reconcile: 44 long");
expect(/Fees paid 98\.85/.test(rec), "reconcile: fees 98.85");
expect(/void funds/.test(rec), "reconcile: void id found");
expect(/unreadable/.test(rec), "reconcile: bad line flagged");

for (const id of ["chartPrice", "chartScores", "chartActivity", "chartMints", "chartCluster"]) expect((els[id]?.innerHTML || "").includes("<svg"), `${id} drawn`);
console.log("leaders  :", text("leaderSum"));
console.log("positions:", text("positions").slice(0, 160));
el("didIn").value = app.st.scored.top[0][0]; app.lookup();
console.log("lookup   :", text("didOut").slice(0, 200));
expect(/On the board now #/.test(text("didOut")), "lookup finds the leader");

console.log(`done in ${Date.now() - t0} ms · sweeps ${app.st.season.sweeps.length} · source ${app.st.source} · live verified ${app.st.verify.live.ok} bad ${app.st.verify.live.bad}`);
if (fail.length) { console.error("FAILED:", fail.join("; ")); process.exit(1); }
console.log("all checks passed");

// Phase 2 sections
console.log("tape     :", text("tapeStatus"), "|", text("tapeTiles").slice(0, 200));
console.log("offers   :", text("offers").slice(0, 300));
console.log("trades   :", text("trades").slice(0, 200));
console.log("health   :", text("health").slice(0, 400));
console.log("voids    :", text("voidNote").slice(0, 120), "|", text("voids").slice(0, 200));
const f2 = [];
if (!/posts covering the last/.test(text("tapeStatus"))) f2.push("tape read");
if (!/Last sweep/.test(text("health"))) f2.push("health rendered");
if (!/funds/.test(text("voids"))) f2.push("void reasons rendered");
if (f2.length) { console.error("FAILED phase 2:", f2.join("; ")); process.exit(1); }
console.log("phase 2 checks passed");

// Simulator, tenure, sides
console.log("sim      :", text("simLabel"), "|", text("simPaid").slice(0, 200));
console.log("bands    :", text("simBands").slice(0, 300));
console.log("tenure   :", text("tenureNote"), "|", text("tenure").slice(0, 150));
const f3 = [];
if (!/S = \d/.test(text("simLabel"))) f3.push("sim label");
if (!/FLOP/.test(text("simPaid"))) f3.push("sim paid table");
if (!/S range/.test(text("simBands"))) f3.push("sim bands");
if (!(els.chartSides?.innerHTML || "").includes("<svg")) f3.push("sides chart");
if (!/distinct keys/.test(text("tenureNote"))) f3.push("tenure");
if (f3.length) { console.error("FAILED phase 3:", f3.join("; ")); process.exit(1); }
console.log("phase 3 checks passed");
