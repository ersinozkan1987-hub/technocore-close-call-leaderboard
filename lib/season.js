// Turns referee posts into one compact record per sweep. Pure, shared by the build and the page.
// A season is {keys:[did...], sweeps:[{n, ts, ref, global, ..., top:[[keyIndex, score]], pos:[[keyIndex, q]]}]}.

export const REFEREE = "did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte";
export const ROOMS = ["d-close1-price", "d-close1-flow", "d-close1-positions", "d-close1-pnl", "d-close1-state"];

const num = (v) => (v == null || v === "" ? null : +v);

export function newSeason() {
  return { contest: "close-1", referee: REFEREE, seed: null, final: null, keys: [], sweeps: [] };
}

// Applies verified posts (each with _ts) from `room` onto `season`. Posts for sweeps already present are merged.
export function applyPosts(season, room, posts) {
  const by = new Map(season.sweeps.map((s) => [s.n, s]));
  const at = (n) => { if (!by.has(n)) { const s = { n }; by.set(n, s); season.sweeps.push(s); } return by.get(n); };
  const kidx = new Map(season.keys.map((d, i) => [d, i]));
  const kid = (d) => { if (!kidx.has(d)) { kidx.set(d, season.keys.length); season.keys.push(d); } return kidx.get(d); };
  for (const p of posts) {
    if (room === "d-close1-price") {
      if (p.t === "seed") { season.seed = { price: p.price, time: p.trade?.time, tid: p.trade?.tid, package: p.package, rooms: p.rooms }; continue; }
      if (p.t === "final") { season.final = { price: p.price, time: p.trade?.time, tid: p.trade?.tid, ts: p._ts }; continue; }
      if (p.n == null || !p.ref) continue;
      const s = at(p.n);
      s.ts = p._ts; s.ref = num(p.ref.px); s.refTime = p.ref.time; s.age = num(p.age_s);
      s.global = num(p.global); s.lo = num(p.limits?.[0]); s.hi = num(p.limits?.[1]);
    } else if (room === "d-close1-flow") {
      if (p.n == null) continue;
      const s = at(p.n);
      s.ts ??= p._ts;
      const om = p.omitted || {};
      s.settled = (p.settled?.length || 0) + (om.settled || 0);
      s.void = (p.void?.length || 0) + (om.void || 0);
      s.mints = (p.mints?.length || 0) + (om.mints || 0);
      s.roomsListed = p.rooms?.length || 0;
      s.unlisted = p.unlisted?.length || 0;
      s.missed = p.missed?.length || 0;
      if (p.void?.length) { s.vr = {}; for (const [, r] of p.void) s.vr[r] = (s.vr[r] || 0) + 1; }
    } else if (room === "d-close1-positions") {
      if (p.n == null) continue;
      const s = at(p.n);
      s.open = num(p.open); s.longs = num(p.longs); s.shorts = num(p.shorts);
      s.pos = (p.top || []).map(([d, q]) => [kid(d), +q]);
    } else if (room === "d-close1-pnl") {
      if (p.n == null) continue;
      const s = at(p.n);
      s.mark = num(p.mark);
      s.top = (p.top || []).map(([d, sc]) => [kid(d), +sc]);
    } else if (room === "d-close1-state") {
      if (p.n == null) continue;
      const s = at(p.n);
      s.owners = num(p.owners); s.rooms = num(p.rooms); s.root = p.root;
    }
  }
  season.sweeps.sort((a, b) => a.n - b.n);
  return season;
}

// Listed trade ids → sweep and outcome, for the reconciliation tool.
export function collectIds(flowPosts, into = { settled: {}, void: {} }) {
  for (const p of flowPosts) {
    if (p.n == null) continue;
    for (const id of p.settled || []) into.settled[id] ??= p.n;
    for (const [id, r] of p.void || []) (into.void[id] ??= []).push([p.n, r]);
  }
  return into;
}

// Key indexes back to DIDs, for code that works on one sweep.
export function expand(season, s) {
  return { ...s, top: (s.top || []).map(([i, v]) => [season.keys[i], v]), pos: (s.pos || []).map(([i, v]) => [season.keys[i], v]) };
}

// The last sweep that has a published top list.
export function lastScored(season) {
  for (let i = season.sweeps.length - 1; i >= 0; i--) if (season.sweeps[i].top?.length) return season.sweeps[i];
  return null;
}
