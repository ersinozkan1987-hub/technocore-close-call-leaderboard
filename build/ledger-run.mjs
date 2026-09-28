// Brings the exact ledger up to date and writes data/exact.json and data/ledger/*.json.
// Runs after build/build.mjs (reads data/season.json for the referee-signed file hashes and top lists).
// State between runs: .cache/ledger.json (restored by the workflow's cache; a cold start replays every record).
//   node build/ledger-run.mjs [--limit N]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configure } from "../lib/contest.js";
import { loadLedger, saveLedger, catchUp, outputs } from "./ledger.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
try { configure(JSON.parse(fs.readFileSync(path.join(ROOT, "contest.json"), "utf8"))); } catch { /* defaults */ }
const STATE = path.join(ROOT, ".cache", "ledger.json");
const i = process.argv.indexOf("--limit"), limit = i > 0 ? Number(process.argv[i + 1]) : Infinity;

const t0 = Date.now();
const season = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "season.json"), "utf8"));
const signed = Object.fromEntries(season.sweeps.filter((s) => s.file).map((s) => [s.n, s.file]));
const L = loadLedger(STATE);
const from = L.n;
const r = await catchUp(L, { signed, limit, log: (s) => console.log(`${((Date.now() - t0) / 1e3).toFixed(0)}s ${s}`) });
saveLedger(STATE, L);
const last = season.sweeps.filter((s) => s.ref).at(-1);
const { summary, shards } = outputs(L, season, last?.ref ?? 225, new Date().toISOString(), r.latestIndexed);
summary.unsigned_records = r.unsigned;
const dir = path.join(ROOT, "data", "ledger");
fs.mkdirSync(dir, { recursive: true });
for (const [c, rows] of Object.entries(shards)) fs.writeFileSync(path.join(dir, `${c}.json`), JSON.stringify(rows));
fs.writeFileSync(path.join(ROOT, "data", "exact.json"), JSON.stringify(summary));
console.log(`ledger ${from} → ${L.n} (indexed ${r.latestIndexed}), ${summary.accounts_traded} accounts, ${summary.candidates.length} candidates, check scores ${summary.check.scores.match}/${summary.check.scores.match + (summary.check.scores.differN || 0)} positions ${summary.check.positions.match}/${summary.check.positions.match + (summary.check.positions.differN || 0)}, ${r.unsigned} records without a signed hash, ${((Date.now() - t0) / 1e3).toFixed(0)} s`);
