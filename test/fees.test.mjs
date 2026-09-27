// Checks lib/score.js fees() and prizes() against the official fold's sample season
// (flop-labs/technocore-close-call-challenge examples/, copied to test/fixtures/).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fees, prizes } from "../lib/score.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const events = (await readFile(path.join(dir, "sample-season.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const expected = JSON.parse(await readFile(path.join(dir, "sample-season.expected.json"), "utf8"));

let checked = 0; const bad = [];
for (const ev of events) {
  if (ev.t !== "sweep") continue;
  const exp = expected.sweeps.find((s) => s.sweep === ev.n);
  const close = +ev.close;
  const seen = new Set();
  for (const tr of ev.trades) {
    // the fold settles an id at most once; the first settled outcome for this id is the one to compare
    const out = exp.trades.filter((x) => x.id === tr.id && x.outcome === "settled")[0];
    if (!out || seen.has(tr.id)) continue;
    seen.add(tr.id);
    const f = fees(+tr.qty, +tr.px, close);
    const maker = tr.side === "buy" ? f.buyer : f.seller, taker = tr.side === "buy" ? f.seller : f.buyer;
    checked++;
    if (Math.abs(maker - +out.maker_fee) > 1e-6 || Math.abs(taker - +out.taker_fee) > 1e-6)
      bad.push(`${tr.id}: ours ${maker.toFixed(4)}/${taker.toFixed(4)} fold ${out.maker_fee}/${out.taker_fee}`);
  }
}
console.log(`fees: ${checked} settled trades compared, ${bad.length} mismatches`);
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }

// Tie handling: 4 tied at the top span places 1–4, three prize places → 1,000,000 × 3/3 / 4 each.
const p = prizes([{ key: "a", settle: 10 }, { key: "b", settle: 10 }, { key: "c", settle: 10 }, { key: "d", settle: 10 }, { key: "e", settle: 5 }]);
const ok = p.slice(0, 4).every((r) => r.prize === 250000 && r.rank === 1 && r.tie === 4) && p[4].prize === 0 && p[4].rank === 5;
// Two tied at #2 share places 2 and 3: 1,000,000 × 2/3 / 2 each.
const p2 = prizes([{ key: "a", settle: 10 }, { key: "b", settle: 8 }, { key: "c", settle: 8 }, { key: "d", settle: 1 }]);
const ok2 = p2[0].prize === 333333 && p2[1].prize === 333333 && p2[2].prize === 333333 && p2[3].prize === 0;
console.log(`prizes: 4-way tie ${ok ? "ok" : "WRONG"}, 2-way tie at #2 ${ok2 ? "ok" : "WRONG"}`);
if (!ok || !ok2) process.exit(1);
