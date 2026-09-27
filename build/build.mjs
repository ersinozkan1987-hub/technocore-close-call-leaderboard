// Builds data/season.json, data/board.json and data/ids.json from the referee's rooms.
// Node ≥ 20, no dependencies. Every record is signature-checked; unverified records are dropped and counted.
//   node build/build.mjs            write data/
//   node build/build.mjs --check    build in memory and print a summary only
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { makeVerifier, checkRecord } from "../verify.js";
import { REFEREE, ROOMS, newSeason, applyPosts, collectIds, expand, lastScored } from "../lib/season.js";
import { estimatePositions, settleAt, prizes, groupTies } from "../lib/score.js";

export const BASE = "https://technocore.chat";
export const PAGE_URL = "https://ersinozkan1987-hub.github.io/technocore-close-call-leaderboard/";

async function fetchText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

// Reads one room's export; returns verified posts as the parsed text plus _ts/_seq, and counts.
export async function readRoom(verifier, room, text) {
  const posts = [], stats = { lines: 0, ok: 0, bad: 0 };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    stats.lines++;
    let obj; try { obj = JSON.parse(line); } catch { stats.bad++; continue; }
    const c = await checkRecord(verifier, REFEREE, room, line, obj);
    if (!c.ok) { stats.bad++; continue; }
    let t; try { t = JSON.parse(obj.text); } catch { stats.bad++; continue; }
    stats.ok++;
    t._ts = obj.ts; t._seq = obj.seq;
    posts.push(t);
  }
  return { posts, stats };
}

// The machine-readable snapshot of the latest sweep, scored at the referee's Hyperliquid reference.
export function board(season, generated) {
  const last0 = lastScored(season);
  if (!last0) return null;
  const sweeps = season.sweeps.filter((s) => s.n <= last0.n).map((s) => expand(season, s));
  const last = sweeps[sweeps.length - 1];
  const positions = estimatePositions(sweeps);
  const S = last.ref ?? last.global;
  const rows = prizes(settleAt(last, positions, S));
  const published = prizes(last.top.map(([key, score]) => ({ key, score })), "score");
  const pubRank = new Map(published.map((r) => [r.key, r]));
  const line = (rs, f) => { const paid = rs.filter((r) => r.prize > 0); return paid.length ? Math.min(...paid.map((r) => r[f])) : null; };
  const totals = season.sweeps.reduce((a, s) => { a.settled += s.settled || 0; a.void += s.void || 0; return a; }, { settled: 0, void: 0 });
  return {
    contest: "close-1", referee: REFEREE, generated, page: PAGE_URL,
    sweep: last.n, sweep_ts: last.ts, lock_sweep: 2556, verified: season.verified,
    reference: last.ref, reference_time: last.refTime, reference_age_s: last.age, global: last.global, limits: [last.lo, last.hi],
    owners: last.owners, rooms: last.rooms, longs: last.longs, shorts: last.shorts, open_contracts: last.open,
    settled_total: totals.settled, void_total: totals.void,
    prize_line_published: line(published, "score"),
    prize_line_at_reference: line(rows, "settle"),
    ties: groupTies(last.top).filter((g) => g.keys.length > 1).map((g) => ({ score: g.score, keys: g.keys.length })),
    board: rows.map((r) => ({
      key: r.key, rank_at_reference: r.rank, settle_at_reference: r.settle, published_score: r.score,
      published_rank: pubRank.get(r.key)?.rank ?? null, position: r.position, position_source: r.how,
      prize_if_final: r.prize, tie: r.tie, tie_open_ended: r.openEnded,
    })),
    positions: last.pos.map(([key, q]) => ({ key, contracts: q })),
    note: "Scores are the referee's published top list re-marked at its Hyperliquid reference (the S source). Only listed keys can be ranked; unlisted keys may outrank them. Prize split assumes equal thirds.",
  };
}

// Notable moments of the season, for the feed: leader changes, changes of the paid set at the reference,
// stale references, late sweeps and missed ranges.
export function events(season) {
  const out = [];
  const sweeps = season.sweeps.filter((s) => s.ts).map((s) => expand(season, s));
  let leader = null, paidSig = null, stale = false;
  for (let i = 0; i < sweeps.length; i++) {
    const s = sweeps[i], p = sweeps[i - 1];
    if (s.top?.length) {
      const k = s.top[0][0];
      if (leader && k !== leader) out.push({ n: s.n, ts: s.ts, kind: "leader", title: `New #1: …${k.slice(-6)} at ${s.top[0][1]} (was …${leader.slice(-6)})` });
      leader = k;
      if (s.ref != null && s.global != null) {
        const positions = estimatePositions(sweeps.slice(Math.max(0, i - 40), i + 1));
        const paid = prizes(settleAt(s, positions, s.ref)).filter((r) => r.prize > 0);
        const sig = paid.map((r) => r.key).sort().join("|");
        if (paidSig !== null && sig !== paidSig) out.push({ n: s.n, ts: s.ts, kind: "paid_set", title: `Paid keys changed at the reference ${s.ref}: ${groupTies(paid.map((r) => [r.key, r.prize])).map((g) => `${g.keys.length > 1 ? g.keys.length + " keys" : "…" + g.keys[0].slice(-6)} ${g.score}`).join(", ")}` });
        paidSig = sig;
      }
    }
    if (s.age != null) {
      if (s.age > 300 && !stale) { out.push({ n: s.n, ts: s.ts, kind: "stale_reference", title: `Reference went stale: ${s.age} s old at sweep ${s.n}` }); stale = true; }
      if (s.age <= 300 && stale) { out.push({ n: s.n, ts: s.ts, kind: "reference_fresh", title: `Reference fresh again at sweep ${s.n}` }); stale = false; }
    }
    if (p && (Date.parse(s.ts) - Date.parse(p.ts)) / 1000 > 420) out.push({ n: s.n, ts: s.ts, kind: "late_sweep", title: `Sweep ${s.n} landed ${Math.round((Date.parse(s.ts) - Date.parse(p.ts)) / 60)} min after ${p.n}` });
    if (s.missed) out.push({ n: s.n, ts: s.ts, kind: "missed", title: `Sweep ${s.n}: ${s.missed} room range(s) the referee could not read` });
  }
  return out;
}

const xml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

export function atom(evs, generated) {
  const items = evs.slice(-60).reverse();
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Close Call (close-1) leaderboard events</title>
  <link href="${PAGE_URL}"/>
  <link rel="self" href="${PAGE_URL}data/feed.xml"/>
  <id>${PAGE_URL}data/feed.xml</id>
  <updated>${generated}</updated>
${items.map((e) => `  <entry>
    <id>${PAGE_URL}#sweep-${e.n}-${e.kind}</id>
    <title>${xml(e.title)}</title>
    <link href="${PAGE_URL}"/>
    <updated>${e.ts}</updated>
    <category term="${e.kind}"/>
    <summary>Sweep ${e.n}, ${e.ts}. ${xml(e.title)}</summary>
  </entry>`).join("\n")}
</feed>
`;
}

// One small file per key that ever reached a published list: its score and position history.
export function keyFiles(season) {
  const files = new Map();
  const scored = season.sweeps.filter((s) => s.top?.length || s.pos?.length);
  for (const s of scored) {
    (s.top || []).forEach(([k, sc], i) => { const f = files.get(k) || { history: [], positions: [] }; f.history.push([s.n, sc, i + 1]); files.set(k, f); });
    (s.pos || []).forEach(([k, q]) => { const f = files.get(k) || { history: [], positions: [] }; f.positions.push([s.n, q]); files.set(k, f); });
  }
  const out = [];
  for (const [k, f] of files) {
    const scores = f.history.map((h) => h[1]);
    out.push({ key: season.keys[k], data: {
      key: season.keys[k], contest: "close-1", generated: season.generated,
      sweeps_in_top: f.history.length, at_one: f.history.filter((h) => h[2] === 1).length,
      best: scores.length ? Math.max(...scores) : null, last: f.history.at(-1) || null, last_position: f.positions.at(-1) || null,
      history: f.history, positions: f.positions,
      note: "history: [sweep, published score, rank]; positions: [sweep, contracts]. Only sweeps where the referee listed this key.",
    } });
  }
  return out;
}

export async function build() {
  const verifier = await makeVerifier(REFEREE);
  if (!verifier) throw new Error("no Ed25519 verifier available");
  const texts = await Promise.all(ROOMS.map((r) => fetchText(`${BASE}/r/${r}/export`)));
  const season = newSeason();
  const verified = { ok: 0, bad: 0, rooms: {} };
  let ids = { settled: {}, void: {} };
  for (let i = 0; i < ROOMS.length; i++) {
    const { posts, stats } = await readRoom(verifier, ROOMS[i], texts[i]);
    applyPosts(season, ROOMS[i], posts);
    if (ROOMS[i] === "d-close1-flow") ids = collectIds(posts, ids);
    verified.rooms[ROOMS[i]] = stats; verified.ok += stats.ok; verified.bad += stats.bad;
  }
  const generated = new Date().toISOString();
  season.generated = generated; season.verified = verified;
  ids.generated = generated;
  return { season, board: board(season, generated), ids };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const check = process.argv.includes("--check");
  const t0 = Date.now();
  const { season, board: b, ids } = await build();
  const last = lastScored(season);
  console.log(`sweeps ${season.sweeps.length} (1..${season.sweeps.at(-1)?.n}) keys ${season.keys.length} verified ${season.verified.ok} bad ${season.verified.bad} ids ${Object.keys(ids.settled).length}/${Object.keys(ids.void).length} in ${Date.now() - t0} ms`);
  if (season.verified.ok === 0 || !last) { console.error("build: nothing verified"); process.exit(1); }
  if (!check) {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "season.json"), JSON.stringify(season));
    await writeFile(path.join(dir, "board.json"), JSON.stringify(b, null, 1));
    await writeFile(path.join(dir, "ids.json"), JSON.stringify(ids));
    const evs = events(season);
    await writeFile(path.join(dir, "events.json"), JSON.stringify({ generated: season.generated, events: evs }));
    await writeFile(path.join(dir, "feed.xml"), atom(evs, season.generated));
    const kdir = path.join(dir, "key");
    await mkdir(kdir, { recursive: true });
    const kf = keyFiles(season);
    for (const { key, data } of kf) await writeFile(path.join(kdir, `${key}.json`), JSON.stringify(data));
    console.log(`wrote data/season.json data/board.json data/ids.json data/events.json (${evs.length}) data/feed.xml data/key/*.json (${kf.length})`);
  } else {
    console.log("prize line pub/ref:", b.prize_line_published, b.prize_line_at_reference);
    console.log("top at reference:", b.board.slice(0, 5).map((r) => `${r.key.slice(-6)} ${r.settle_at_reference} (${r.position_source} ${r.position}) ${r.prize_if_final}`).join(" | "));
  }
}
