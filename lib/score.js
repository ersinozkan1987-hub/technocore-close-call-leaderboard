// Contest arithmetic shared by the page and the build. Pure functions, no I/O.
// Rules: close-call-game.md (flop-labs/technocore-close-call-challenge), rules 12, 14, 17, 18.

import { contest } from "./contest.js";

// close-1 defaults at load time; the functions below read `contest` live so configure() applies to them.
export const MINT = contest.mint;
export const POOL = contest.prize_pool;
export const PLACES = contest.prize_places;
export const LOCK_SWEEP = contest.lock_sweep;
export const LOCK = Date.parse(contest.lock);
export const FINAL_TIME = Date.parse(contest.final_price_time);
export const OPENING = Date.parse(contest.opening);

// Rule 12: each side pays the fee rate on value; the side that beat the sweep's close pays the gap instead if larger.
// Returns {buyer, seller} fees for a trade of qty at px whose sweep closed at `close`.
export function fees(qty, px, close) {
  const base = contest.fee_rate * qty * px;
  const gap = (close - px) * qty;
  return { buyer: Math.max(base, gap), seller: Math.max(base, -gap) };
}

// Position for each key in the latest top list: exact when the referee lists it, otherwise a least-squares
// slope of that key's published score against the sweep's global price over its last `window` sweeps.
// Score is linear in the mark (rule 17), so the slope is the net position. Kept only when the fit is tight.
export function estimatePositions(sweeps, window = 36, maxResidual = 1) {
  const last = sweeps[sweeps.length - 1];
  const out = new Map();
  if (!last) return out;
  for (const [k, q] of last.pos || []) out.set(k, { q: +q, how: "listed" });
  const recent = sweeps.slice(-window);
  for (const [k] of last.top || []) {
    if (out.has(k)) continue;
    const pts = [];
    for (const s of recent) {
      if (s.global == null) continue;
      const hit = (s.top || []).find(([kk]) => kk === k);
      if (hit) pts.push([+s.global, +hit[1]]);
    }
    if (pts.length < 3) { out.set(k, { q: null, how: "unknown" }); continue; }
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
    let sxx = 0, sxy = 0;
    for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
    if (sxx < 1e-6) { out.set(k, { q: null, how: "flat" }); continue; }
    const slope = sxy / sxx, icpt = my - slope * mx;
    const resid = Math.max(...pts.map(([x, y]) => Math.abs(y - (icpt + slope * x))));
    out.set(k, resid <= maxResidual ? { q: Math.round(slope * 100) / 100, how: "fitted", resid } : { q: null, how: "noisy", resid });
  }
  return out;
}

// Replayed ledger lines (data/exact.json: score = a + b·S) for keys that can reach the top. A line is used only
// while it reproduces the referee's latest signed score at its mark (published marks are rounded to the cent,
// hence half a cent per contract), i.e. the key has not traded since the records end. The settlement is then
// exact, so rounded "ties" that are not ties split (rule 18).
export function applyLedger(positions, sweep, exact) {
  if (!exact || !sweep) return 0;
  const lines = new Map();
  for (const [k, a, b] of [...(exact.candidates || []), ...(exact.check?.scores?.matched || [])]) lines.set(k, [Number(a), Number(b)]);
  const g = +sweep.global;
  let used = 0;
  for (const [k, sc] of sweep.top || []) {
    const l = lines.get(k);
    if (!l || !(g > 0) || Math.abs(l[0] + l[1] * g - sc) > 0.011 + Math.abs(l[1]) * 0.005) continue;
    positions.set(k, { q: l[1], how: "ledger", a: l[0] }); used++;
  }
  return used;
}

// Re-score the published top list at price S. settle = published + position × (S − global).
// Keys with an unknown position keep their published score and are flagged.
export function settleAt(sweep, positions, S) {
  const g = +sweep.global;
  return (sweep.top || []).map(([k, score]) => {
    const p = positions.get(k) || { q: null, how: "unknown" };
    // an exact ledger line (a + q·S) is kept to 1e-6 so near-ties that round alike stay apart (rule 18)
    if (p.how === "ledger" && p.a != null) return { key: k, score: +score, position: p.q, how: p.how, settle: Math.round((p.a + p.q * S) * 1e6) / 1e6 };
    const settle = p.q == null ? +score : +score + p.q * (S - g);
    return { key: k, score: +score, position: p.q, how: p.how, settle: Math.round(settle * 100) / 100 };
  });
}

// Rule 18: rank by score, ties share the places they span, equal thirds of the pool assumed (the rules do not
// split it). `openEnded` marks a tie that may continue past the published list.
export function prizes(rows, field = "settle") {
  const sorted = rows.slice().sort((a, b) => b[field] - a[field]);
  const out = [];
  const places = contest.prize_places, pool = contest.prize_pool;
  let place = 0;
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j < sorted.length && sorted[j][field] === sorted[i][field]) j++;
    const tied = j - i;
    const spanned = Math.max(0, Math.min(places, place + tied) - place);
    const each = spanned ? pool * spanned / places / tied : 0;
    const openEnded = j === sorted.length && tied > 1;
    for (let t = i; t < j; t++) out.push({ ...sorted[t], rank: place + 1, tie: tied, prize: Math.round(each), openEnded });
    place += tied;
    i = j;
  }
  return out;
}

// Price S at which a key with net position q and breakeven price b (score = q·(S − b)) passes a row whose
// score is s0 + p·(S − g). Returns {S, dir} or null when it can never pass.
export function priceToPass(q, b, row, g) {
  const p = row.position ?? 0, s0 = row.score;
  const d = q - p;
  if (Math.abs(d) < 1e-9) return null;
  const S = (s0 - p * g + q * b) / d;
  return { S: Math.round(S * 100) / 100, dir: d > 0 ? "above" : "below" };
}

// Group consecutive equal scores in a top list: [{score, keys:[...]}]
export function groupTies(top) {
  const groups = [];
  for (const [k, sc] of top || []) {
    const g = groups[groups.length - 1];
    if (g && g.score === sc) g.keys.push(k); else groups.push({ score: sc, keys: [k] });
  }
  return groups;
}
