// Exact ledger from the organisers' per-sweep records (challenges.technocore.chat/close-1, issue #12, 28 September).
// Each record is the fold's input (owners, trades in applied order) and output (outcome and fees per trade). This
// replays the settled public trades with the rules' own arithmetic (close_call_fold.py Account.apply), in integers
// scaled by 1e8 so ties stay exact. Private-room trades are redacted in both input and output, so a key that also
// traded in a private room is off by those trades; `check()` compares every key against the referee's signed top
// lists and says which ones match.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { contest } from "../lib/contest.js";

export const RECORDS = "https://challenges.technocore.chat/" + contest.id + "/";
const SCALE = 10n ** 8n;

// "224.68" → 22468000000n; at most 8 decimals, which every price, quantity and fee in the records fits.
export function dec(s) {
  const m = /^(-?)(\d+)(?:\.(\d{1,8}))?$/.exec(String(s));
  if (!m) throw new Error(`bad decimal ${s}`);
  const v = BigInt(m[2]) * SCALE + BigInt((m[3] || "").padEnd(8, "0"));
  return m[1] ? -v : v;
}
export function str(v) {
  const neg = v < 0n; if (neg) v = -v;
  const f = (v % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + (v / SCALE).toString() + (f ? "." + f : "");
}
const mul = (a, b) => (a * b) / SCALE; // both 2-decimal inputs here, so this never truncates

export function newLedger() {
  return { version: 1, n: 0, accounts: {}, settled: 0, voided: 0, hidden: 0, selfTrades: 0, feeMismatch: 0, fees: 0n, files: {} };
}

// Account: { c: cash, l: [[qty, px], ...] FIFO, all long (qty > 0) or all short, f: fees, t: settled trades }
function account(L, key) {
  return (L.accounts[key] ??= { c: dec(contest.mint), l: [], f: 0n, t: 0 });
}
function apply(a, side, qty, px, fee) {
  a.c -= fee; a.f += fee; a.t++;
  let left = qty;
  while (left > 0n && a.l.length && a.l[0][0] * BigInt(side) < 0n) {
    const [lq, lp] = a.l[0];
    const size = left < (lq < 0n ? -lq : lq) ? left : (lq < 0n ? -lq : lq);
    a.c += side < 0 ? mul(size, px) : mul(size, 2n * lp - px);
    left -= size;
    if (size === (lq < 0n ? -lq : lq)) a.l.shift(); else a.l[0][0] = lq + BigInt(side) * size;
  }
  if (left > 0n) { a.c -= mul(left, px); a.l.push([BigInt(side) * left, px]); }
}
// Fee the rules charge (fold side_fees), to cross-check the referee's own figures.
function sideFees(side, qty, px, close) {
  const base = mul(dec(contest.fee_rate), mul(qty, px));
  const gap = mul(close - px, qty);
  const buyer = base > gap ? base : gap, seller = base > -gap ? base : -gap;
  return side > 0 ? [buyer, seller] : [seller, buyer];
}

// Score is a line in S: a + b·S, b = position. Longs add q·S; shorts add −q·(2p − S) = −2qp + q·S.
export function line(a) {
  let b = 0n, k = a.c - dec(contest.mint);
  for (const [q, p] of a.l) { b += q; if (q < 0n) k -= 2n * mul(q, p); }
  return [k, b];
}

export function applySweep(L, n, rec) {
  const { input, output } = rec;
  if (input.n !== n || Number(output.sweep) !== n) throw new Error(`record ${n}: sweep number mismatch`);
  if (input.trades.length !== output.trades.length) throw new Error(`record ${n}: input/output length mismatch`);
  const close = dec(output.close);
  for (let i = 0; i < input.trades.length; i++) {
    const t = input.trades[i], o = output.trades[i];
    if (t.redacted || o.redacted) { L.hidden++; continue; }
    if (o.id !== t.id) throw new Error(`record ${n}: trade ${i} id mismatch`);
    if (o.outcome !== "settled") { L.voided++; continue; }
    const side = t.side === "buy" ? 1 : -1, qty = dec(t.qty), px = dec(t.px);
    const mf = dec(o.maker_fee), tf = dec(o.taker_fee);
    const [cm, ct] = sideFees(side, qty, px, close);
    if (cm !== mf || ct !== tf) L.feeMismatch++;
    L.fees += mf + tf; L.settled++;
    if (t.maker === t.countersigner) { const a = account(L, t.maker); a.c -= mf + tf; a.f += mf + tf; a.t++; L.selfTrades++; continue; }
    apply(account(L, t.maker), side, qty, px, mf);
    apply(account(L, t.countersigner), -side, qty, px, tf);
  }
  L.n = n;
}

// State file: BigInts as strings.
export function saveLedger(file, L) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(L, (k, v) => (typeof v === "bigint" ? "#" + v.toString() : v)));
}
export function loadLedger(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8"), (k, v) => (typeof v === "string" && /^#-?\d+$/.test(v) ? BigInt(v.slice(1)) : v)); }
  catch { return newLedger(); }
}

// Fetch the index and every record after L.n in order. `signed` maps sweep → the file hash the referee signed in its
// posts; a full record must hash to it, a redacted one to the sha256 the index lists (the redaction is not signed).
export async function catchUp(L, { signed = {}, log = console.log, limit = Infinity, concurrency = 6 } = {}) {
  const idx = await (await fetch(RECORDS + "index.json", { signal: AbortSignal.timeout(60_000) })).json();
  const todo = idx.sweeps.filter((s) => s.n > L.n).sort((a, b) => a.n - b.n).slice(0, limit);
  const get = async (s) => {
    for (let tries = 0; ; tries++) {
      try {
        const r = await fetch(RECORDS + s.path, { signal: AbortSignal.timeout(120_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        const h = crypto.createHash("sha256").update(buf).digest("hex");
        const want = s.status === "full" ? s.file : s.sha256;
        if (h !== want) throw new Error(`sweep ${s.n}: sha256 ${h.slice(0, 12)} ≠ ${String(want).slice(0, 12)}`);
        return JSON.parse(buf);
      } catch (e) { if (tries >= 3 || /sha256/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 2000 * (tries + 1))); }
    }
  };
  let unsigned = 0, done = 0;
  const pending = new Map();
  for (let i = 0; i < todo.length; i++) {
    for (let j = i; j < Math.min(todo.length, i + concurrency); j++) if (!pending.has(j)) pending.set(j, get(todo[j]));
    const s = todo[i];
    if (signed[s.n] && signed[s.n] !== s.file) throw new Error(`sweep ${s.n}: index file ${s.file.slice(0, 12)} ≠ signed ${signed[s.n].slice(0, 12)}`);
    if (!signed[s.n]) unsigned++;
    const rec = await pending.get(i); pending.delete(i);
    applySweep(L, s.n, rec);
    L.files[s.n] = s.status === "full" ? "full" : "redacted";
    if (++done % 50 === 0) log(`ledger: sweep ${s.n}, ${Object.keys(L.accounts).length} accounts`);
  }
  return { applied: done, latestIndexed: idx.sweeps.at(-1)?.n ?? 0, unsigned };
}

// Keys that can be in the top `depth` at some S within ±`band` of `ref`: for each position size keep the best
// `depth` intercepts (ties included), then keep those that reach the top `depth` at some S on a 5-cent grid.
export function candidates(L, ref, { depth = 30, band = 0.1 } = {}) {
  const byB = new Map();
  for (const [key, a] of Object.entries(L.accounts)) {
    if (!a.t) continue;
    const [k, b] = line(a);
    const row = { key, k, b, kf: Number(k) / 1e8, bf: Number(b) / 1e8 };
    (byB.get(b) || byB.set(b, []).get(b)).push(row);
  }
  let pool = [];
  for (const rows of byB.values()) {
    rows.sort((x, y) => (y.k > x.k ? 1 : y.k < x.k ? -1 : 0));
    const cut = rows[Math.min(depth, rows.length) - 1].k;
    pool.push(...rows.filter((r) => r.k >= cut));
  }
  // top `depth` at each grid price: a small sorted buffer per price instead of sorting the pool
  const keep = new Set();
  for (let S = ref * (1 - band); S <= ref * (1 + band); S += 0.05) {
    const top = [];
    for (const r of pool) {
      const v = r.kf + r.bf * S;
      if (top.length >= depth && v < top[top.length - 1] - 1e-6) continue;
      let i = top.length; while (i > 0 && top[i - 1] < v) i--;
      top.splice(i, 0, v); if (top.length > depth * 4) top.length = depth * 4;
    }
    const cut = top[Math.min(depth, top.length) - 1] - 1e-6;
    for (const r of pool) if (r.kf + r.bf * S >= cut) keep.add(r);
  }
  return [...keep];
}

// Compare the ledger with the referee's signed lists for sweep L.n: published score at the global mark, and
// listed positions. A key that also traded in a private room will not match.
export function check(L, season) {
  const s = season.sweeps.find((x) => x.n === L.n);
  const out = { sweep: L.n, scores: { match: 0, differ: [] }, positions: { match: 0, differ: [] } };
  if (!s) return out;
  const g = s.global;
  for (const [kid, sc] of s.top || []) {
    const key = season.keys[kid], a = L.accounts[key];
    const [k, b] = a ? line(a) : [0n, 0n];
    const ours = Number(k) / 1e8 + (Number(b) / 1e8) * g;
    // the published mark is the global price rounded to the cent, so allow half a cent per contract
    if (Math.abs(ours - sc) <= 0.011 + Math.abs(Number(b) / 1e8) * 0.005) { out.scores.match++; (out.scores.matched ||= []).push([key, str(k), str(b)]); } else { if (out.scores.differ.length < 30) out.scores.differ.push([key, sc, Math.round(ours * 100) / 100]); out.scores.differN = (out.scores.differN || 0) + 1; }
  }
  for (const [kid, q] of s.pos || []) {
    const key = season.keys[kid], a = L.accounts[key];
    const b = a ? Number(line(a)[1]) / 1e8 : 0;
    if (Math.abs(b - q) < 0.005) out.positions.match++; else { if (out.positions.differ.length < 30) out.positions.differ.push([key, q, b]); out.positions.differN = (out.positions.differN || 0) + 1; }
  }
  return out;
}

// data/exact.json (summary + candidates) and data/ledger/<c>.json, one shard per character after "did:key:z6Mk".
// Row: [score intercept a, position b, cash, fees, settled trades]; score at S = a + b·S (exact decimals as strings).
export function outputs(L, season, ref, generated, latestIndexed) {
  const shards = {};
  for (const [key, a] of Object.entries(L.accounts)) {
    const [k, b] = line(a);
    const c = key.slice(12, 13);
    (shards[c] ||= {})[key] = [str(k), str(b), str(a.c), str(a.f), a.t];
  }
  const cands = candidates(L, ref).map((r) => [r.key, str(r.k), str(r.b)]);
  const summary = {
    contest: contest.id, generated, source: RECORDS, sweep: L.n, latest_indexed: latestIndexed,
    accounts_traded: Object.values(L.accounts).filter((a) => a.t).length,
    trades: { settled_public: L.settled, void_public: L.voided, redacted: L.hidden, self: L.selfTrades, fee_mismatch: L.feeMismatch },
    fees: str(L.fees), check: check(L, season), candidates: cands,
    note: "Replayed from the organisers' per-sweep records with the rules' arithmetic. Score at S = a + b·S. Private-room trades are redacted (outcome included), so a key that traded there is off by those trades; `check` compares with the referee's signed lists.",
  };
  return { summary, shards };
}
