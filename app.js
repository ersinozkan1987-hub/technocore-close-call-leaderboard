import { makeVerifier, checkRecord, nonceDigits } from "./verify.js";
import { newSeason, applyPosts, collectIds, expand, lastScored } from "./lib/season.js";
import { contest, configure, refereeRooms, lockMs } from "./lib/contest.js";
import { lastTrade } from "./lib/hl.js";
import { estimatePositions, settleAt, prizes, priceToPass, groupTies, fees } from "./lib/score.js";

let BASE = contest.chat, REFEREE = contest.referee, ROOMS = refereeRooms();
const SEASON_MAX_AGE = 2 * 3600e3;

const st = {
  season: null, source: "", buildAt: null,
  verify: { build: null, live: { ok: 0, bad: 0 }, available: true },
  live: { px: null, at: null, err: 0 },
  view: "live", ids: null, positions: new Map(), rows: [], scored: null, exact: null, shards: new Map(),
};
let verifier = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (x, d = 2) => Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const int = (x) => Math.round(Number(x)).toLocaleString("en-US");
const sign = (x, d = 2) => (x > 0 ? "+" : "") + fmt(x, d);
const cls = (x) => (x > 0 ? "pos" : x < 0 ? "neg" : "");
const shortDid = (d) => (d.length > 26 ? d.slice(0, 14) + "…" + d.slice(-6) : d);
const when = (t) => new Date(t).toISOString().slice(5, 16).replace("T", " ") + " UTC";
const flop = (x) => (x >= 1e6 ? (x / 1e6).toFixed(2) + "M" : x >= 1e3 ? Math.round(x / 1e3) + "K" : String(x));

/* ---------- loading ---------- */

async function loadSeasonFile() {
  const r = await fetch("data/season.json", { cache: "no-store" });
  if (!r.ok) throw new Error("season.json " + r.status);
  const s = await r.json();
  if (Date.now() - Date.parse(s.generated) > SEASON_MAX_AGE) throw new Error("season.json is stale");
  return s;
}

// Fallback: read every room's export and verify it here.
async function loadExports() {
  const season = newSeason();
  const v = { ok: 0, bad: 0, rooms: {} };
  for (const room of ROOMS) {
    const r = await fetch(`${BASE}/r/${room}/export`);
    if (!r.ok) throw new Error(`${room}: HTTP ${r.status}`);
    const posts = [], stats = { lines: 0, ok: 0, bad: 0 };
    for (const line of (await r.text()).split("\n")) {
      if (!line.trim()) continue;
      stats.lines++;
      let obj; try { obj = JSON.parse(line); } catch { stats.bad++; continue; }
      const c = await checkRecord(verifier, REFEREE, room, line, obj);
      if (!c.ok) { stats.bad++; continue; }
      let t; try { t = JSON.parse(obj.text); } catch { stats.bad++; continue; }
      stats.ok++; t._ts = obj.ts; posts.push(t);
    }
    applyPosts(season, room, posts);
    v.rooms[room] = stats; v.ok += stats.ok; v.bad += stats.bad;
  }
  season.generated = new Date().toISOString(); season.verified = v;
  return season;
}

// Latest posts of each room; everything newer than what we hold is verified here and merged.
async function tail() {
  const last = st.season.sweeps.at(-1)?.n ?? 0;
  let added = 0;
  for (const room of ROOMS) {
    const r = await fetch(`${BASE}/r/${room}?format=json&limit=20`);
    if (!r.ok) continue;
    const text = await r.text();
    const j = JSON.parse(text);
    const nonces = [...text.matchAll(/"nonce"\s*:\s*"?(\d+)"?/g)].map((m) => m[1]);
    const posts = [];
    (j.messages || []).forEach((m, i) => {
      let t; try { t = JSON.parse(m.text); } catch { return; }
      const n = t.n ?? (t.t === "final" ? Infinity : -1);
      if (n <= last - 1 && t.t !== "final") return; // allow the newest held sweep to complete
      posts.push({ m, t, nonce: nonces[i] ?? String(m.nonce) });
    });
    for (const { m, t, nonce } of posts) {
      const line = `{"nonce":${nonce}}`; // only the nonce digits are read from the line
      const c = await checkRecord(verifier, REFEREE, room, line, m);
      if (!c.ok) { if (m.from === REFEREE) st.verify.live.bad++; continue; }
      if (c.verified) st.verify.live.ok++;
      t._ts = m.ts;
      applyPosts(st.season, room, [t]);
      if ((t.n ?? 0) > last) added++;
    }
  }
  return added;
}

async function hlPrice() {
  try {
    const { px, time } = await lastTrade();
    st.live = { px, at: Date.now(), trade: time, err: 0 }; return true;
  } catch { /* fall through */ }
  st.live.err++;
  return false;
}

/* ---------- derived ---------- */

function recompute() {
  const s0 = lastScored(st.season);
  if (!s0) return;
  const sweeps = st.season.sweeps.filter((s) => s.n <= s0.n).map((s) => expand(st.season, s));
  st.scored = sweeps[sweeps.length - 1];
  st.positions = estimatePositions(sweeps);
  // keys whose replayed ledger matches the referee's signed score: exact position from the per-sweep records
  for (const [k, , b] of st.exact?.check?.scores?.matched || []) {
    const p = st.positions.get(k);
    if (!p || p.how !== "listed") st.positions.set(k, { q: Number(b), how: "ledger" });
  }
}

function currentS() {
  if (st.live.px && Date.now() - st.live.at < 120e3) return { S: st.live.px, src: "last Hyperliquid trade" };
  if (st.scored?.ref) return { S: st.scored.ref, src: "referee reference (live price unavailable)" };
  return { S: st.scored?.global, src: "global mark" };
}

function standings() {
  const s = st.scored;
  if (!s) return [];
  if (st.view === "board") return prizes(s.top.map(([key, score]) => ({ key, score, position: st.positions.get(key)?.q ?? null, how: st.positions.get(key)?.how, settle: score })), "score");
  return prizes(settleAt(s, st.positions, currentS().S));
}

function prizeLine(rows, f) {
  const paid = rows.filter((r) => r.prize > 0);
  return paid.length ? Math.min(...paid.map((r) => r[f])) : null;
}

/* ---------- render: header ---------- */

function renderStatus() {
  const s = st.season.sweeps.at(-1), sc = st.scored;
  const el = $("status");
  el.className = "status";
  el.textContent = `Sweep ${s?.n ?? "–"} of ${contest.lock_sweep} · referee post ${sc?.ts ? when(sc.ts) : "–"} · ${st.source} · live tail every minute, Hyperliquid every 5 s`;
  const b = st.verify.build, l = st.verify.live;
  let html = "";
  if (!st.verify.available) html += `<span class="badge warn">signature check unavailable in this browser</span>`;
  if (b) html += `<span class="badge ${b.bad ? "warn" : "ok"}">build: ${int(b.ok)} referee posts verified${b.bad ? `, ${b.bad} rejected` : ""} · ${when(st.buildAt)}</span>`;
  if (l.ok || l.bad) html += `<span class="badge ${l.bad ? "warn" : "ok"}">live: ${l.ok} verified here${l.bad ? `, ${l.bad} rejected` : ""}</span>`;
  $("verifyBadges").innerHTML = html;
}

function renderTiles() {
  const s = st.scored, last = st.season.sweeps.at(-1);
  const rows = standings();
  const left = lockMs() - Date.now();
  const lockTxt = left > 0 ? `${Math.floor(left / 864e5)}d ${Math.floor((left % 864e5) / 36e5)}h ${Math.floor((left % 36e5) / 6e4)}m` : "locked";
  const live = st.live.px;
  const lead = rows[0];
  const pl = prizeLine(rows, "settle");
  const tiles = [
    ["Live NVDA (Hyperliquid)", live ? fmt(live) : "–", live ? `${Math.round((Date.now() - st.live.at) / 1000)} s ago · S source` : "unavailable", "live"],
    ["Referee reference", s?.ref != null ? fmt(s.ref) : "–", s?.refTime ? `HL trade ${new Date(s.refTime).toISOString().slice(11, 19)} UTC · age ${s.age ?? "?"} s` : ""],
    ["Board mark (global)", s?.global != null ? fmt(s.global) : "–", s?.ref != null && s?.global != null ? `${sign(s.global - s.ref)} vs reference` : ""],
    ["Leader", lead ? sign(lead.settle) : "–", lead ? (st.view === "live" ? "at live price" : "published") + ` · ${lead.tie > 1 ? lead.tie + " keys tied" : shortDid(lead.key)}` : ""],
    ["Prize line", pl != null ? sign(pl) : "–", "lowest score still paid"],
    ["Owners", last?.owners != null ? int(last.owners) : "–", last?.rooms != null ? `${last.rooms} rooms` : ""],
    ["Open interest", last?.open != null ? int(last.open) : "–", last?.longs != null ? `${int(last.longs)} long · ${int(last.shorts)} short keys` : ""],
    ["Lock in", lockTxt, new Date(lockMs()).toUTCString().replace(/:\d\d GMT$/, " UTC").slice(5)],
  ];
  $("tiles").innerHTML = tiles.map(([k, v, s, c]) => `<div class="tile ${c || ""}"><div class="k">${k}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join("");
}

/* ---------- render: standings ---------- */

function renderBoard() {
  const s = st.scored;
  if (!s) { $("board").innerHTML = "<tr><td>No published scores yet.</td></tr>"; return; }
  const rows = standings();
  const { S, src } = currentS();
  const pub = new Map(prizes(s.top.map(([key, score]) => ({ key, score })), "score").map((r) => [r.key, r.rank]));
  $("boardNote").textContent = st.view === "live"
    ? `Published scores re-marked at ${fmt(S)} (${src}), global mark ${fmt(s.global)}. Position: listed by the referee, exact from the per-sweep records (R), fitted from the key's score history (≈), or unknown (?) — unknown keys keep their published score.`
    : `The referee's top ${s.top.length} exactly as signed at sweep ${s.n}, marked at the global price ${fmt(s.global)}.`;
  // group consecutive equal scores
  const groups = [];
  for (const r of rows) {
    const g = groups[groups.length - 1];
    if (g && g.settle === r.settle) g.rows.push(r); else groups.push({ settle: r.settle, rows: [r] });
  }
  let html = `<tr><th>Rank</th><th>Key</th><th class="num">Published</th><th class="num">Position</th><th class="num">${st.view === "live" ? "At live price" : "Score"}</th><th class="num">FLOP if final</th></tr>`;
  for (const g of groups) {
    const first = g.rows[0];
    const rank = g.rows.length > 1 ? `${first.rank}–${first.rank + g.rows.length - 1}` : `${first.rank}`;
    const open = g.rows.some((r) => r.openEnded) ? "+" : "";
    const shown = g.rows.slice(0, 4), more = g.rows.length - shown.length;
    const keys = shown.map((r) => {
      const pr = pub.get(r.key), d = pr != null ? pr - r.rank : 0;
      const mv = st.view === "live" && d ? `<span class="mv ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"}${Math.abs(d)}</span>` : "";
      return `<div class="did" title="${esc(r.key)}">${esc(shortDid(r.key))} ${mv}</div>`;
    }).join("") + (more ? `<div class="muted">+${more} more</div>` : "");
    const posTxt = (r) => r.position == null ? `<span class="muted">?</span>` : `${r.how === "fitted" ? "≈" : ""}${sign(r.position)}${r.how === "ledger" ? `<sup title="exact, from the per-sweep records">R</sup>` : ""}`;
    const posCol = g.rows.length === 1 ? posTxt(first) : [...new Set(g.rows.map(posTxt))].join(" / ");
    const pubCol = g.rows.length === 1 ? sign(first.score) : [...new Set(g.rows.map((r) => sign(r.score)))].join(" / ");
    html += `<tr><td>${rank}${open}</td><td>${keys}</td><td class="num ${cls(first.score)}">${pubCol}</td><td class="num">${posCol}</td><td class="num ${cls(g.settle)}"><b>${sign(g.settle)}</b>${g.rows.length > 1 ? `<span class="chip">${g.rows.length} keys</span>` : ""}</td><td class="num">${first.prize ? flop(first.prize) + (g.rows.length > 1 ? " each" : "") : "–"}</td></tr>`;
  }
  $("board").innerHTML = html;
}

/* ---------- solver ---------- */

function solve() {
  const q = Number($("solQ").value), b = Number($("solB").value);
  const out = $("solOut");
  if (!q || !(b > 0)) { out.innerHTML = `<p class="neg">Enter a non-zero position and a breakeven price.</p>`; return; }
  const rows = prizes(settleAt(st.scored, st.positions, currentS().S));
  const { S } = currentS();
  const g = st.scored.global;
  const lead = rows[0];
  const paid = rows.filter((r) => r.prize > 0);
  const line = paid[paid.length - 1];
  const mine = q * (S - b);
  const txt = (r, label) => {
    const p = priceToPass(q, b, { score: r.score, position: r.position }, g);
    const now = r.settle;
    if (!p) return `<tr><td>${label}</td><td class="num">never (same position size, ${sign(now)} now)</td></tr>`;
    return `<tr><td>${label} (${sign(now)} at ${fmt(S)}${r.position == null ? ", position unknown" : ""})</td><td class="num">S ${p.dir} <b>${fmt(p.S)}</b> <span class="muted">(${sign((p.S / S - 1) * 100, 1)}%)</span></td></tr>`;
  };
  out.innerHTML = `<table class="kv">
    <tr><td>Your score at ${fmt(S)}</td><td class="num ${cls(mine)}">${sign(mine)}</td></tr>
    ${txt(lead, "To pass the leader")}
    ${line ? txt(line, "To reach the prize line") : ""}
  </table><p class="muted" style="margin-top:6px">Leader and prize line are the listed keys re-marked at S; keys the referee does not publish are unknown.</p>`;
}

/* ---------- price simulator ---------- */

const sim = { S: null, touched: false };

function simRange() {
  const c = currentS().S;
  return { lo: c * 0.95, hi: c * 1.05, c };
}

function simPaid(S) {
  return prizes(settleAt(st.scored, st.positions, S)).filter((r) => r.prize > 0);
}

function renderSim() {
  if (!st.scored) return;
  const { lo, hi, c } = simRange();
  const slider = $("simS");
  if (!sim.touched || sim.S == null) { sim.S = c; slider.value = "300"; }
  const S = sim.S;
  $("simLabel").textContent = `S = ${fmt(S)} (${sign((S / c - 1) * 100, 2)}% from ${fmt(c)})`;
  const paid = simPaid(S);
  const groups = [];
  for (const r of paid) { const g = groups[groups.length - 1]; if (g && g.settle === r.settle) g.rows.push(r); else groups.push({ settle: r.settle, rows: [r] }); }
  $("simPaid").innerHTML = `<tr><th>Place</th><th>Key</th><th class="num">Score at S</th><th class="num">FLOP</th></tr>` + groups.map((g) => {
    const f = g.rows[0];
    return `<tr><td>${f.rank}${g.rows.length > 1 ? `–${f.rank + g.rows.length - 1}` : ""}${g.rows.some((r) => r.openEnded) ? "+" : ""}</td><td>${g.rows.slice(0, 3).map((r) => `<div class="did" title="${esc(r.key)}">${esc(shortDid(r.key))}</div>`).join("")}${g.rows.length > 3 ? `<div class="muted">+${g.rows.length - 3} more</div>` : ""}</td><td class="num ${cls(g.settle)}">${sign(g.settle)}</td><td class="num">${flop(f.prize)}${g.rows.length > 1 ? " each" : ""}</td></tr>`;
  }).join("");
  // bands: walk the price range and merge consecutive prices with the same paid set
  const bands = [];
  const step = Math.max(0.01, Math.round((hi - lo) / 400 * 100) / 100);
  for (let p = lo; p <= hi + 1e-9; p += step) {
    const P = Math.round(p * 100) / 100;
    const set = simPaid(P);
    const sig = set.map((r) => r.key).sort().join("|");
    const b = bands[bands.length - 1];
    if (b && b.sig === sig) b.to = P; else bands.push({ sig, from: P, to: P, set });
  }
  $("simBands").innerHTML = `<tr><th>S range</th><th>Paid keys</th></tr>` + bands.map((b) => {
    const g = groupTies(b.set.map((r) => [r.key, r.prize]));
    const who = g.map((x) => `${x.keys.length > 1 ? x.keys.length + " keys" : shortDid(x.keys[0])} <span class="muted">(${flop(x.score)}${x.keys.length > 1 ? " each" : ""})</span>`).join(", ");
    const cur = S >= b.from - step / 2 && S <= b.to + step / 2;
    return `<tr${cur ? ' style="font-weight:600"' : ""}><td class="num" style="text-align:left;white-space:nowrap">${fmt(b.from)} – ${fmt(b.to)}${b.from <= lo + step / 2 ? " ↓" : ""}${b.to >= hi - step ? " ↑" : ""}</td><td class="did" style="font-family:inherit">${who}</td></tr>`;
  }).join("");
}

$("simS").addEventListener("input", (e) => {
  const { lo, hi } = simRange();
  sim.touched = true;
  sim.S = Math.round((lo + (hi - lo) * (+e.target.value / 600)) * 100) / 100;
  renderSim();
});

/* ---------- reconcile ---------- */

async function loadIds() {
  if (st.ids) return st.ids;
  $("recStatus").textContent = "loading the referee's trade lists…";
  const r = await fetch("data/ids.json", { cache: "no-store" });
  if (r.ok) { st.ids = await r.json(); return st.ids; }
  // No build output: read the flow room's export here and verify it.
  const e = await fetch(`${BASE}/r/${contest.rooms.flow}/export`);
  if (!e.ok) throw new Error("flow export " + e.status);
  const posts = [];
  for (const line of (await e.text()).split("\n")) {
    if (!line.trim()) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    const c = await checkRecord(verifier, REFEREE, contest.rooms.flow, line, obj);
    if (!c.ok) continue;
    try { posts.push(JSON.parse(obj.text)); } catch { /* skip */ }
  }
  st.ids = { generated: new Date().toISOString(), ...collectIds(posts) };
  return st.ids;
}

function parseTrades(text, me) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("{")) {
      try {
        const j = JSON.parse(line), t = j.terms || j;
        if (!t.id || !t.side || !t.qty || !t.px) { out.push({ bad: line }); continue; }
        let side = t.side;
        if (me && t.maker && t.maker !== me) side = t.side === "buy" ? "sell" : "buy";
        else if (!me && t.maker) { out.push({ bad: line, why: "terms JSON needs your did:key to know your side" }); continue; }
        out.push({ id: t.id, side, qty: +t.qty, px: +t.px });
      } catch { out.push({ bad: line }); }
      continue;
    }
    const m = line.split(/[\s,]+/);
    if (m.length >= 4 && /^(buy|sell)$/i.test(m[1]) && +m[2] > 0 && +m[3] > 0) out.push({ id: m[0], side: m[1].toLowerCase(), qty: +m[2], px: +m[3] });
    else out.push({ bad: line });
  }
  return out;
}

async function reconcile() {
  const out = $("recOut");
  const trades = parseTrades($("recIn").value, $("recDid").value.trim());
  if (!trades.length) { out.innerHTML = `<p class="neg">Nothing to check.</p>`; return; }
  let ids;
  try { ids = await loadIds(); } catch (e) { out.innerHTML = `<p class="neg">${esc(e.message)}</p>`; return; }
  $("recStatus").textContent = `lists from ${when(ids.generated)}`;
  const refAt = new Map(st.season.sweeps.map((s) => [s.n, s.ref]));
  let q = 0, cost = 0, fee = 0, settled = 0;
  const { S } = currentS();
  let html = `<tr><th>Id</th><th>Outcome</th><th class="num">Side · qty @ px</th><th class="num">Fee</th></tr>`;
  for (const t of trades) {
    if (t.bad) { html += `<tr><td colspan="4" class="neg">unreadable: ${esc(t.bad.slice(0, 60))}${t.why ? " — " + esc(t.why) : ""}</td></tr>`; continue; }
    const n = ids.settled[t.id];
    const v = ids.void[t.id];
    let outcome, f = null;
    if (n != null) {
      const close = refAt.get(n);
      const ff = fees(t.qty, t.px, close ?? t.px);
      f = t.side === "buy" ? ff.buyer : ff.seller;
      const dir = t.side === "buy" ? 1 : -1;
      q += dir * t.qty; cost += dir * t.qty * t.px; fee += f; settled++;
      outcome = `<span class="pos">settled</span> sweep ${n}${close != null ? ` (close ${fmt(close)})` : ""}`;
    } else if (v) outcome = `<span class="neg">void</span> ${v.map(([vn, r]) => `${r} @${vn}`).join(", ")}`;
    else outcome = `<span class="muted">not listed</span>`;
    html += `<tr><td class="did">${esc(t.id)}</td><td>${outcome}</td><td class="num">${t.side} ${fmt(t.qty)} @ ${fmt(t.px)}</td><td class="num">${f != null ? fmt(f) : "–"}</td></tr>`;
  }
  let summary = "";
  if (settled) {
    const avg = q ? cost / q : null;
    const be = q ? (cost + (q > 0 ? fee : -fee)) / q : null;
    const score = q * S - cost - fee;
    summary = `<table class="kv" style="margin-top:10px">
      <tr><td>Net position</td><td class="num ${cls(q)}">${sign(q)} contracts</td></tr>
      <tr><td>Average entry</td><td class="num">${avg != null ? fmt(avg) : "–"}</td></tr>
      <tr><td>Fees paid</td><td class="num">${fmt(fee)} POLF</td></tr>
      <tr><td>Breakeven S</td><td class="num">${be != null ? fmt(be) : "–"}</td></tr>
      <tr><td>Score at ${fmt(S)} (${currentS().src})</td><td class="num ${cls(score)}">${sign(score)} POLF</td></tr>
      <tr><td>Free POLF (if these are all your trades)</td><td class="num">${fmt(contest.mint - Math.abs(cost) - fee)}</td></tr>
    </table>`;
  }
  out.innerHTML = `<div class="scroll"><table>${html}</table></div>${summary}<p class="muted" style="margin-top:6px">"Not listed" means the id is in no published list; the referee omits most ids on busy sweeps, so it may still have settled.</p>`;
}

/* ---------- charts ---------- */

function sample(arr, max) {
  if (arr.length <= max) return arr;
  const step = arr.length / max, out = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

// Multi-series line chart on one axis, optional band, crosshair tooltip showing every series.
function chart(el, { series, band = null, fmtY = (v) => fmt(v), zero = false }) {
  const all = series.flatMap((s) => s.pts);
  if (all.length < 2) { el.innerHTML = `<p class="muted">Not enough data yet.</p>`; return; }
  const W = 460, H = 210, L = 54, R = 10, T = 10, B = 26;
  let x0 = Math.min(...all.map((p) => p.t)), x1 = Math.max(...all.map((p) => p.t));
  let y0 = Math.min(...all.map((p) => p.y), ...(band ? band.map((b) => b.lo) : [])), y1 = Math.max(...all.map((p) => p.y), ...(band ? band.map((b) => b.hi) : []));
  if (zero) y0 = Math.min(0, y0);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
  const X = (t) => L + (t - x0) / (x1 - x0) * (W - L - R);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  let g = "";
  for (let i = 0; i <= 3; i++) {
    const v = y0 + (y1 - y0) * i / 3, y = Y(v);
    g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="var(--grid)"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(fmtY(v))}</text>`;
  }
  for (let i = 0; i <= 2; i++) {
    const t = x0 + (x1 - x0) * i / 2, d = new Date(t);
    const lab = `${d.getUTCDate()} ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${String(d.getUTCHours()).padStart(2, "0")}:00`;
    g += `<text x="${X(t)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === 2 ? "end" : "middle"}" font-size="11" fill="var(--muted)">${lab}</text>`;
  }
  let bandPath = "";
  if (band && band.length > 1) {
    const up = band.map((b, i) => `${i ? "L" : "M"}${X(b.t).toFixed(1)},${Y(b.hi).toFixed(1)}`).join("");
    const dn = band.slice().reverse().map((b) => `L${X(b.t).toFixed(1)},${Y(b.lo).toFixed(1)}`).join("");
    bandPath = `<path d="${up}${dn}Z" fill="var(--band)"/>`;
  }
  const paths = series.map((s) => `<path d="${s.pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.y).toFixed(1)}`).join("")}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join("");
  const dots = series.map((_, i) => `<circle class="dot" data-i="${i}" r="4" fill="${series[i].color}" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>`).join("");
  el.innerHTML = `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(", "))}">${g}${bandPath}${paths}
    <line class="xh" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-dasharray="3 3" visibility="hidden"/>${dots}
    <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/></svg>`;
  const svg = el.querySelector("svg"), xh = svg.querySelector(".xh"), dots2 = [...svg.querySelectorAll(".dot")], tip = $("tip");
  const nearest = (pts, t) => { let b = pts[0]; for (const p of pts) if (Math.abs(p.t - t) < Math.abs(b.t - t)) b = p; return b; };
  svg.addEventListener("pointermove", (ev) => {
    const bb = svg.getBoundingClientRect();
    const t = x0 + ((ev.clientX - bb.left) / bb.width * W - L) / (W - L - R) * (x1 - x0);
    const ref = nearest(all, t);
    xh.setAttribute("x1", X(ref.t)); xh.setAttribute("x2", X(ref.t)); xh.setAttribute("visibility", "visible");
    const lines = series.map((s, i) => {
      const p = nearest(s.pts, ref.t);
      const on = Math.abs(p.t - ref.t) < 6e5;
      dots2[i].setAttribute("visibility", on ? "visible" : "hidden");
      if (on) { dots2[i].setAttribute("cx", X(p.t)); dots2[i].setAttribute("cy", Y(p.y)); }
      return on ? `<span style="color:${s.color}">●</span> ${esc(s.name)} <b>${esc(fmtY(p.y))}</b>` : "";
    }).filter(Boolean).join("<br>");
    tip.innerHTML = `${lines}<br><span class="muted">${when(ref.t)} · sweep ${ref.n}</span>`;
    tip.style.display = "block";
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(ev.pageX + 12, window.scrollX + document.documentElement.clientWidth - tw - 8) + "px";
    tip.style.top = (ev.pageY - 34) + "px";
  });
  svg.addEventListener("pointerleave", () => { xh.setAttribute("visibility", "hidden"); dots2.forEach((d) => d.setAttribute("visibility", "hidden")); tip.style.display = "none"; });
}

function dataTable(el, series, fmtY = fmt) {
  const base = sample(series[0].pts, 24).slice().reverse();
  const at = (s, n) => s.pts.find((p) => p.n === n);
  el.innerHTML = `<tr><th>Sweep</th><th>Time (UTC)</th>${series.map((s) => `<th class="num">${esc(s.name)}</th>`).join("")}</tr>` +
    base.map((p) => `<tr><td>${p.n}</td><td>${when(p.t).slice(0, 11)}</td>${series.map((s) => { const q = at(s, p.n); return `<td class="num">${q ? fmtY(q.y) : "–"}</td>`; }).join("")}</tr>`).join("");
}

function renderCharts() {
  const sw = st.season.sweeps;
  const pts = (f) => sample(sw.filter((s) => s.ts && f(s) != null).map((s) => ({ t: Date.parse(s.ts), y: f(s), n: s.n })), 500);
  const price = [{ name: "Hyperliquid reference", color: "var(--s1)", pts: pts((s) => s.ref) }, { name: "Global (contest VWAP)", color: "var(--s2)", pts: pts((s) => s.global) }];
  const band = sample(sw.filter((s) => s.ts && s.lo != null).map((s) => ({ t: Date.parse(s.ts), lo: s.lo, hi: s.hi })), 500);
  chart($("chartPrice"), { series: price, band });
  dataTable($("tablePrice"), price);

  const scored = sw.filter((s) => s.ts && s.top?.length);
  const lineOf = (s) => { const r = prizes(s.top.map(([k, sc]) => ({ key: k, score: sc })), "score"); return prizeLine(r, "score"); };
  const scores = [
    { name: "Leader", color: "var(--s1)", pts: sample(scored.map((s) => ({ t: Date.parse(s.ts), y: s.top[0][1], n: s.n })), 500) },
    { name: "Prize line", color: "var(--s3)", pts: sample(scored.map((s) => ({ t: Date.parse(s.ts), y: lineOf(s), n: s.n })).filter((p) => p.y != null), 500) },
  ];
  chart($("chartScores"), { series: scores, fmtY: (v) => sign(v), zero: true });
  dataTable($("tableScores"), scores, (v) => sign(v));

  const act = [{ name: "Settled", color: "var(--s3)", pts: pts((s) => s.settled) }, { name: "Voided", color: "var(--s2)", pts: pts((s) => s.void) }];
  chart($("chartActivity"), { series: act, fmtY: int, zero: true });
  dataTable($("tableActivity"), act, int);

  const mints = [{ name: "New owners", color: "var(--s1)", pts: pts((s) => s.mints) }];
  chart($("chartMints"), { series: mints, fmtY: int, zero: true });
  dataTable($("tableMints"), mints, int);

  const cl = [{ name: "Keys in largest group", color: "var(--s4)", pts: sample(scored.map((s) => ({ t: Date.parse(s.ts), y: Math.max(...groupTies(s.top).map((g) => g.keys.length)), n: s.n })), 500) }];
  chart($("chartCluster"), { series: cl, fmtY: int, zero: true });
  dataTable($("tableCluster"), cl, int);
}

/* ---------- history tables ---------- */

function renderLeaders() {
  const keys = st.season.keys;
  const stints = [];
  for (const p of st.season.sweeps) {
    if (!p.top?.length || !p.ts) continue;
    const did = keys[p.top[0][0]], sc = p.top[0][1], s = stints[stints.length - 1];
    if (s && s.did === did) { s.to = p.n; s.toT = p.ts; s.peak = Math.max(s.peak, sc); }
    else stints.push({ did, from: p.n, to: p.n, fromT: p.ts, toT: p.ts, peak: sc });
  }
  if (!stints.length) { $("leaders").innerHTML = ""; $("leaderSum").textContent = ""; return; }
  const distinct = new Set(stints.map((s) => s.did)).size;
  $("leaderSum").textContent = `The #1 published spot changed hands ${stints.length - 1} times between ${distinct} keys over ${st.season.sweeps.filter((s) => s.top?.length).length} sweeps. Latest first.`;
  const dur = (s) => { const m = (Date.parse(s.toT) - Date.parse(s.fromT)) / 6e4 + 5; return m >= 120 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`; };
  $("leaders").innerHTML = `<tr><th>Key</th><th>From (UTC)</th><th class="num">Held</th><th class="num">Peak</th></tr>` +
    stints.slice().reverse().slice(0, 15).map((s) => `<tr><td class="did" title="${esc(s.did)}">${esc(shortDid(s.did))}</td><td>${when(s.fromT).slice(0, 11)} <span class="muted">#${s.from}</span></td><td class="num">${dur(s)}</td><td class="num ${cls(s.peak)}">${sign(s.peak)}</td></tr>`).join("");
}

function renderPositions() {
  const s = st.scored;
  if (!s?.pos?.length) { $("positions").innerHTML = "<tr><td>No data yet.</td></tr>"; return; }
  $("positions").innerHTML = `<tr><th>#</th><th>Key</th><th class="num">Contracts</th><th class="num">Published score</th></tr>` +
    s.pos.map(([d, x], i) => { const sc = s.top.find(([k]) => k === d)?.[1]; return `<tr><td>${i + 1}</td><td class="did" title="${esc(d)}">${esc(shortDid(d))}</td><td class="num ${cls(x)}">${sign(x)}</td><td class="num">${sc != null ? sign(sc) : "<span class='muted'>not in top list</span>"}</td></tr>`; }).join("");
}

function lookup() {
  const did = $("didIn").value.trim(), out = $("didOut");
  if (!/^did:key:z[1-9A-HJ-NP-Za-km-z]{20,}$/.test(did)) { out.innerHTML = `<p class="neg">Enter a full did:key.</p>`; return; }
  const ki = st.season.keys.indexOf(did);
  const scored = st.season.sweeps.filter((s) => s.top?.length);
  if (ki < 0) { out.innerHTML = `<p>Not found in the top lists of ${scored.length} sweeps. The referee does not publish scores below the top of the board.</p>`; return; }
  let seen = 0, best = null, last = null, lastPos = null, atOne = 0;
  for (const p of scored) {
    const i = p.top.findIndex(([k]) => k === ki);
    if (i < 0) continue;
    seen++; if (i === 0) atOne++;
    const sc = p.top[i][1];
    last = { n: p.n, t: p.ts, s: sc, rank: i + 1 };
    if (!best || sc > best.s) best = { n: p.n, t: p.ts, s: sc };
  }
  for (const p of st.season.sweeps) { const hit = (p.pos || []).find(([k]) => k === ki); if (hit) lastPos = { n: p.n, q: hit[1] }; }
  const cur = standings().find((r) => r.key === did);
  const pe = st.positions.get(did);
  out.innerHTML = `<table class="kv">
    <tr><td>On the board now</td><td class="num">${cur ? `#${cur.rank} · ${sign(cur.settle)} at live price` : "no"}</td></tr>
    <tr><td>Sweeps in the top list</td><td class="num">${seen} of ${scored.length} (${atOne} at #1)</td></tr>
    ${best ? `<tr><td>Best published score</td><td class="num ${cls(best.s)}">${sign(best.s)} <span class="muted">(sweep ${best.n})</span></td></tr>` : ""}
    ${last ? `<tr><td>Last seen</td><td class="num ${cls(last.s)}">${sign(last.s)} <span class="muted">(#${last.rank}, sweep ${last.n}, ${when(last.t)})</span></td></tr>` : ""}
    ${lastPos ? `<tr><td>Last listed position</td><td class="num ${cls(lastPos.q)}">${sign(lastPos.q)} <span class="muted">(sweep ${lastPos.n})</span></td></tr>` : ""}
    ${pe && pe.how === "fitted" ? `<tr><td>Fitted position</td><td class="num ${cls(pe.q)}">≈${sign(pe.q)} <span class="muted">(from score history)</span></td></tr>` : ""}
  </table>`;
}

async function ledgerRow(did) {
  const c = did.slice(12, 13);
  if (!st.shards.has(c)) {
    const r = await fetch(`data/ledger/${c}.json`, { cache: "no-store" });
    st.shards.set(c, r.ok ? await r.json() : {});
  }
  return st.shards.get(c)[did] || null;
}

async function lookupLedger(did) {
  const box = $("didLedger");
  if (!st.exact) { box.innerHTML = ""; return; }
  const row = await ledgerRow(did).catch(() => null);
  const x = st.exact, n = x.sweep;
  if (!row) { box.innerHTML = `<p class="muted">No settled public trade for this key up to sweep ${n} in the per-sweep records. Private-room trades are redacted there.</p>`; return; }
  const [a, b, cash, fee, t] = row;
  const { S } = currentS();
  const at = Number(a) + Number(b) * S;
  const differs = (x.check.scores.differ || []).find(([k]) => k === did);
  const matches = (x.check.scores.matched || []).some(([k]) => k === did);
  box.innerHTML = `<h3 style="margin:14px 0 6px">Exact ledger, sweep ${n}</h3><table class="kv">
    <tr><td>Position</td><td class="num ${cls(Number(b))}">${sign(Number(b))}</td></tr>
    <tr><td>Cash (POLF)</td><td class="num">${fmt(Number(cash))}</td></tr>
    <tr><td>Fees paid</td><td class="num">${fmt(Number(fee))}</td></tr>
    <tr><td>Settled public trades</td><td class="num">${t}</td></tr>
    <tr><td>Score at ${fmt(S)}</td><td class="num ${cls(at)}"><b>${sign(at)}</b></td></tr>
  </table><p class="muted" style="margin-top:6px">Replayed from the organisers' per-sweep records with the rules' own arithmetic. Score at S = ${esc(a)} + ${esc(b)} × S.
  ${matches ? "Matches the referee's signed score at this sweep." : differs ? `<span class="neg">Differs from the referee's signed score (${sign(differs[1])} vs ${sign(differs[2])}): this key also traded in a private room, which the records redact.</span>` : "If this key also traded in a private room, those trades are redacted and not included."}</p>`;
}

function renderRecords() {
  const x = st.exact, out = $("records");
  if (!out) return;
  if (!x) { out.innerHTML = `<p class="muted">Per-sweep records not loaded.</p>`; return; }
  const c = x.check, tr = x.trades;
  out.innerHTML = `<table class="kv">
    <tr><td>Records replayed</td><td class="num">sweeps 1–${x.sweep} <span class="muted">(${x.latest_indexed} indexed)</span></td></tr>
    <tr><td>Record hashes vs the referee's signed <code>file</code></td><td class="num ${x.unsigned_records ? "" : "pos"}">${x.unsigned_records ? `${x.unsigned_records} without a signed post yet` : "all match"}</td></tr>
    <tr><td>Public trades settled / void</td><td class="num">${tr.settled_public.toLocaleString("en-US")} / ${tr.void_public.toLocaleString("en-US")}</td></tr>
    <tr><td>Redacted (private rooms, outcome hidden)</td><td class="num">${tr.redacted.toLocaleString("en-US")}</td></tr>
    <tr><td>Fees recomputed by rule 12 that differ</td><td class="num ${tr.fee_mismatch ? "neg" : "pos"}">${tr.fee_mismatch}</td></tr>
    <tr><td>Accounts with a public trade</td><td class="num">${x.accounts_traded.toLocaleString("en-US")}</td></tr>
    <tr><td>Referee top list matched (sweep ${c.sweep})</td><td class="num">${c.scores.match} of ${c.scores.match + (c.scores.differN || 0)} scores, ${c.positions.match} of ${c.positions.match + (c.positions.differN || 0)} positions</td></tr>
  </table><p class="muted" style="margin-top:6px">A listed key that does not match traded in a private room: its trades are redacted in the records, so only the referee knows its balance.</p>`;
}

/* ---------- live tape (room close1) ---------- */

const tape = { msgs: [], lastSeq: 0, at: null, firstAt: null };

async function loadTape() {
  const r = await fetch(`${BASE}/r/${contest.rooms.trading}?format=json&limit=200`);
  if (!r.ok) return false;
  const j = await r.json();
  for (const m of j.messages || []) {
    if (m.seq <= tape.lastSeq) continue;
    tape.lastSeq = m.seq;
    let t; try { t = JSON.parse(m.text); } catch { continue; }
    if (t.season && t.season !== contest.id) continue;
    if (t.t === "trade" && t.terms) tape.msgs.push({ kind: "trade", seq: m.seq, ts: m.ts, from: m.from, terms: t.terms, taker: t.taker });
    else if (t.t === "offer" && t.terms) tape.msgs.push({ kind: "offer", seq: m.seq, ts: m.ts, from: m.from, terms: t.terms });
    else if (t.t === "owner") tape.msgs.push({ kind: "owner", seq: m.seq, ts: m.ts, from: m.from });
    else if (t.t === "room") tape.msgs.push({ kind: "room", seq: m.seq, ts: m.ts, from: m.from });
  }
  tape.firstAt ??= Date.now();
  tape.at = Date.now();
  const cutoff = Date.now() - 30 * 60e3;
  tape.msgs = tape.msgs.filter((m) => Date.parse(m.ts) > cutoff);
  return true;
}

function nextSweep() {
  const s = st.season.sweeps.at(-1);
  // the price post says which sweep it prices ("n") and its limits apply to the next one
  return s ? s.n + 1 : null;
}

function renderTape() {
  const now = Date.now();
  const win = Math.min(10 * 60e3, tape.msgs.length ? now - Math.min(...tape.msgs.map((m) => Date.parse(m.ts))) : 10 * 60e3);
  const recent = tape.msgs.filter((m) => now - Date.parse(m.ts) <= win);
  const perMin = (k) => (recent.filter((m) => m.kind === k).length / Math.max(win / 60e3, 0.5));
  const s = st.season.sweeps.at(-1);
  const lo = s?.lo, hi = s?.hi, nxt = nextSweep();
  const live = currentS().S;
  // open offers: taker any, until ≥ next sweep, inside the band, not already countersigned in the tape
  const taken = new Set(tape.msgs.filter((m) => m.kind === "trade").map((m) => m.terms.id));
  const seenIds = new Set();
  const offers = tape.msgs.filter((m) => m.kind === "offer" && m.terms.taker === "any" && !taken.has(m.terms.id))
    .filter((m) => { if (seenIds.has(m.terms.id)) return false; seenIds.add(m.terms.id); return true; })
    .filter((m) => nxt == null || +m.terms.until >= nxt)
    .filter((m) => lo == null || (+m.terms.px >= lo && +m.terms.px <= hi))
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 25);
  const span = tape.msgs.length ? (now - Math.min(...tape.msgs.map((m) => Date.parse(m.ts)))) / 1000 : 0;
  $("tapeStatus").textContent = tape.at ? `${tape.msgs.length} posts covering the last ${span >= 120 ? Math.round(span / 60) + " min" : Math.round(span) + " s"} · read ${Math.round((now - tape.at) / 1000)} s ago` : "reading…";
  $("tapeTiles").innerHTML = [
    ["Trades posted / min", perMin("trade").toFixed(1), "countersigned, awaiting the sweep"],
    ["Offers posted / min", perMin("offer").toFixed(1), "taker any or named"],
    ["Registrations / min", perMin("owner").toFixed(1), "new owner keys"],
    ["Open offers now", String(offers.length), `valid for sweep ${nxt ?? "?"}`],
  ].map(([k, v, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join("");
  $("offers").innerHTML = offers.length
    ? `<tr><th>Maker</th><th>Side</th><th class="num">Qty @ px</th><th class="num">vs live</th><th class="num">Until</th></tr>` +
      offers.map((m) => {
        const t = m.terms, d = live ? (t.px / live - 1) * 1e4 : null;
        return `<tr><td class="did" title="${esc(t.maker)}">${esc(shortDid(t.maker))}</td><td>${esc(t.side)}s</td><td class="num">${fmt(t.qty)} @ ${fmt(t.px)}</td><td class="num ${d == null ? "" : (t.side === "sell" ? (d < 0 ? "pos" : "neg") : (d > 0 ? "pos" : "neg"))}">${d == null ? "–" : sign(d, 0) + " bp"}</td><td class="num">sweep ${esc(t.until)}</td></tr>`;
      }).join("")
    : `<tr><td class="muted">No open "any" offers in the last 30 minutes of the room.</td></tr>`;
  const trades = tape.msgs.filter((m) => m.kind === "trade").sort((a, b) => b.seq - a.seq).slice(0, 15);
  $("trades").innerHTML = trades.length
    ? `<tr><th>Time</th><th>Maker → taker</th><th>Maker side</th><th class="num">Qty @ px</th></tr>` +
      trades.map((m) => `<tr><td>${new Date(m.ts).toISOString().slice(11, 19)}</td><td class="did">${esc(shortDid(m.terms.maker))} → ${esc(shortDid(m.taker || "?"))}</td><td>${esc(m.terms.side)}</td><td class="num">${fmt(m.terms.qty)} @ ${fmt(m.terms.px)}</td></tr>`).join("")
    : `<tr><td class="muted">No trades posted in the last 30 minutes.</td></tr>`;
}

/* ---------- referee health + void reasons ---------- */

function renderHealth() {
  const sw = st.season.sweeps.filter((s) => s.ts);
  const last = sw.at(-1);
  if (!last) { $("health").innerHTML = ""; return; }
  const now = Date.now();
  const dayAgo = now - 24 * 3600e3;
  const day = sw.filter((s) => Date.parse(s.ts) > dayAgo);
  const sinceLast = (now - Date.parse(last.ts)) / 1000;
  const expectedGap = 300;
  const lateBy = sinceLast - expectedGap;
  const staleRef = day.filter((s) => s.age != null && s.age > 300);
  const missed = day.reduce((a, s) => a + (s.missed || 0), 0);
  const unlisted = day.reduce((a, s) => a + (s.unlisted || 0), 0);
  // mints listed+omitted should equal the growth in owners between consecutive state posts
  let mintGap = 0, mintChecked = 0;
  for (let i = 1; i < day.length; i++) {
    const a = day[i - 1], b = day[i];
    if (a.owners == null || b.owners == null || b.mints == null) continue;
    mintChecked++;
    if (b.owners - a.owners !== b.mints) mintGap++;
  }
  const gaps = [];
  for (let i = 1; i < day.length; i++) { const d = (Date.parse(day[i].ts) - Date.parse(day[i - 1].ts)) / 1000; if (d > 420) gaps.push({ n: day[i].n, d }); }
  const badge = (ok, warn, txt) => `<span class="badge ${ok ? "ok" : warn ? "warn" : "bad"}">${txt}</span>`;
  const rows = [
    [badge(lateBy < 60, lateBy < 600, lateBy < 60 ? "on time" : `late ${Math.round(lateBy / 60)} min`), "Last sweep", `#${last.n} at ${when(last.ts)}; sweeps are due every 5 minutes`],
    [badge(last.age == null || last.age <= 300, last.age <= 3600, last.age == null ? "?" : last.age <= 300 ? "fresh" : `${Math.round(last.age / 60)} min old`), "Hyperliquid reference", `${staleRef.length} of ${day.length} sweeps in 24 h used a reference older than 5 min (rule 11: the last one stands)`],
    [badge(gaps.length === 0, gaps.length < 5, gaps.length ? `${gaps.length} gaps` : "none"), "Sweep gaps > 7 min (24 h)", gaps.length ? gaps.slice(-5).map((g) => `#${g.n} +${Math.round(g.d / 60)} min`).join(", ") : "every sweep landed in time"],
    [badge(missed === 0, missed < 10, String(missed)), "Missed ranges (24 h)", "room ranges the referee reported it could not read"],
    [badge(unlisted === 0, true, String(unlisted)), "Rooms unlisted (24 h)", "registered rooms dropped from the list (undocumented, see issue #11)"],
    [badge(mintGap === 0, mintGap < 3, mintChecked ? `${mintChecked - mintGap}/${mintChecked}` : "?"), "Mints vs owner growth (24 h)", "sweeps where listed + omitted mints equal the change in owners"],
  ];
  $("health").innerHTML = `<table>${rows.map(([b, k, v]) => `<tr><td style="white-space:nowrap">${b}</td><td><b>${k}</b><br><span class="muted">${esc(v)}</span></td></tr>`).join("")}</table>`;
}

const VOID_REASONS = { funds: "funds: free POLF does not cover the contracts opened plus fee", limits: "limits: price outside ±5 % of the reference", expired: "expired: sweep later than until", settled: "settled: id already settled once", not_owner: "not_owner: a side is not a registered owner", taker: "taker: named taker did not countersign", shape: "shape: malformed terms", locked: "locked: after the lock" };

function renderVoids() {
  const sw = st.season.sweeps;
  const tot = {}; let listed = 0, all = 0;
  for (const s of sw) { all += s.void || 0; for (const [r, c] of Object.entries(s.vr || {})) { tot[r] = (tot[r] || 0) + c; listed += c; } }
  const entries = Object.entries(tot).sort((a, b) => b[1] - a[1]);
  $("voidNote").textContent = `Reasons are published for ${int(listed)} of ${int(all)} voided trades this season; the referee trims its lists on busy sweeps, so shares describe that sample.`;
  $("voids").innerHTML = entries.length ? `<table>${entries.map(([r, c]) => { const pct = c / listed * 100; return `<tr><td>${esc(VOID_REASONS[r] || r)}</td><td class="num" style="white-space:nowrap">${pct.toFixed(1)} % · ${int(c)}</td><td style="width:30%"><div style="height:8px;border-radius:4px;background:var(--s2);width:${pct.toFixed(1)}%"></div></td></tr>`; }).join("")}</table>` : `<p class="muted">No voided trade listed yet.</p>`;
}

/* ---------- tenure, sides, theme ---------- */

function renderTenure() {
  const keys = st.season.keys;
  const scored = st.season.sweeps.filter((s) => s.top?.length);
  const stat = new Map();
  for (const s of scored) {
    s.top.forEach(([k, sc], i) => {
      const t = stat.get(k) || { n: 0, one: 0, best: -Infinity, bestRank: 99, first: s.n, last: s.n };
      t.n++; if (i === 0) t.one++; if (sc > t.best) t.best = sc; if (i + 1 < t.bestRank) t.bestRank = i + 1; t.last = s.n;
      stat.set(k, t);
    });
  }
  const rows = [...stat.entries()].sort((a, b) => b[1].n - a[1].n || b[1].one - a[1].one).slice(0, 15);
  $("tenureNote").textContent = `${stat.size} distinct keys have appeared in the published top list over ${scored.length} sweeps.`;
  $("tenure").innerHTML = `<tr><th>Key</th><th class="num">Sweeps in top 25</th><th class="num">At #1</th><th class="num">Best</th><th class="num">Seen</th></tr>` +
    rows.map(([k, t]) => `<tr><td class="did" title="${esc(keys[k])}">${esc(shortDid(keys[k]))}</td><td class="num">${t.n}</td><td class="num">${t.one}</td><td class="num ${cls(t.best)}">${sign(t.best)} <span class="muted">#${t.bestRank}</span></td><td class="num muted">${t.first}–${t.last}</td></tr>`).join("");
}

function renderSides() {
  const sw = st.season.sweeps;
  const pts = (f) => sample(sw.filter((s) => s.ts && f(s) != null).map((s) => ({ t: Date.parse(s.ts), y: f(s), n: s.n })), 500);
  const series = [{ name: "Keys long", color: "var(--s3)", pts: pts((s) => s.longs) }, { name: "Keys short", color: "var(--s2)", pts: pts((s) => s.shorts) }];
  chart($("chartSides"), { series, fmtY: int, zero: true });
  dataTable($("tableSides"), series, int);
}

function initTheme() {
  const root = document.documentElement;
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch { /* private mode */ }
  if (saved === "dark" || saved === "light") root.setAttribute("data-theme", saved);
  $("theme").addEventListener("click", () => {
    const dark = root.getAttribute("data-theme") === "dark" || (!root.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
    const next = dark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch { /* ignore */ }
  });
}

/* ---------- identical-score groups across sweeps ---------- */

function renderClusters() {
  const keys = st.season.keys;
  const scored = st.season.sweeps.filter((s) => s.top?.length);
  const clusters = [];
  for (const s of scored) {
    for (const g of groupTies(s.top)) {
      if (g.keys.length < 2) continue;
      const set = new Set(g.keys);
      let best = null, bestJ = 0;
      for (const c of clusters) {
        const inter = [...set].filter((k) => c.members.has(k)).length;
        const j = inter / (set.size + c.members.size - inter);
        if (j > bestJ) { bestJ = j; best = c; }
      }
      if (best && bestJ >= 0.5) {
        best.last = s.n; best.sweeps++; best.maxSize = Math.max(best.maxSize, set.size); best.size = set.size; best.score = g.score;
        for (const k of set) best.members.add(k);
      } else clusters.push({ members: new Set(set), first: s.n, last: s.n, sweeps: 1, maxSize: set.size, size: set.size, score: g.score });
    }
  }
  const lastN = scored.at(-1)?.n;
  clusters.sort((a, b) => b.sweeps - a.sweeps);
  const rows = clusters.slice(0, 12);
  $("clusterNote").textContent = `${clusters.length} groups seen over ${scored.length} sweeps; ${clusters.filter((c) => c.last === lastN).length} present in the latest sweep. Keys that share one exact published score in the same sweep, followed across sweeps (a group persists while at least half of its keys stay together). The rules allow any number of keys per operator, so a group is an observation, not a violation.`;
  $("clusters").innerHTML = `<tr><th>Group</th><th class="num">Keys now / ever</th><th class="num">Sweeps together</th><th class="num">Seen</th><th class="num">Position</th><th class="num">Last score</th></tr>` +
    rows.map((c) => {
      const ids = [...c.members];
      const pos = ids.map((k) => st.positions.get(keys[k])).filter((p) => p && p.q != null).map((p) => p.q);
      const posTxt = pos.length ? `${pos.length === ids.length ? "" : "≈"}${sign(Math.min(...pos))}${Math.max(...pos) - Math.min(...pos) > 0.5 ? ` … ${sign(Math.max(...pos))}` : ""}` : "?";
      const now = c.last === lastN;
      return `<tr${now ? "" : ' class="muted"'}><td class="did" title="${esc(ids.slice(0, 5).map((k) => keys[k]).join("\n"))}">${esc(shortDid(keys[ids[0]]))} +${ids.length - 1}</td><td class="num">${now ? c.size : 0} / ${ids.length}</td><td class="num">${c.sweeps}</td><td class="num muted">${c.first}–${c.last}</td><td class="num">${posTxt}</td><td class="num ${cls(c.score)}">${sign(c.score)}</td></tr>`;
    }).join("");
}

/* ---------- season-long consistency checks ---------- */

let consistencyFindings = null;

function consistency() {
  const sw = st.season.sweeps.filter((s) => s.ts);
  const findings = [];
  const counts = { gap_in_numbering: 0, late_sweep: 0, mints_vs_owners: 0, stale_reference: 0, missed_ranges: 0, rooms_unlisted: 0, no_top_list: 0 };
  for (let i = 0; i < sw.length; i++) {
    const s = sw[i], p = sw[i - 1];
    if (p) {
      if (s.n !== p.n + 1) { counts.gap_in_numbering++; findings.push({ n: s.n, check: "gap_in_numbering", detail: `previous sweep is #${p.n}` }); }
      const d = (Date.parse(s.ts) - Date.parse(p.ts)) / 1000;
      if (d > 420) { counts.late_sweep++; findings.push({ n: s.n, check: "late_sweep", detail: `${Math.round(d)} s after #${p.n}` }); }
      if (p.owners != null && s.owners != null && s.mints != null && s.owners - p.owners !== s.mints) { counts.mints_vs_owners++; findings.push({ n: s.n, check: "mints_vs_owners", detail: `owners +${s.owners - p.owners}, mints listed+omitted ${s.mints}` }); }
    }
    if (s.age != null && s.age > 300) { counts.stale_reference++; findings.push({ n: s.n, check: "stale_reference", detail: `reference ${s.age} s old` }); }
    if (s.missed) { counts.missed_ranges++; findings.push({ n: s.n, check: "missed_ranges", detail: `${s.missed} range(s) not read` }); }
    if (s.unlisted) { counts.rooms_unlisted++; findings.push({ n: s.n, check: "rooms_unlisted", detail: `${s.unlisted} room(s) dropped` }); }
    if (!s.top?.length && s.n > 1) { counts.no_top_list++; findings.push({ n: s.n, check: "no_top_list", detail: "no pnl post for this sweep" }); }
  }
  return { generated: new Date().toISOString(), contest: contest.id, referee: REFEREE, sweeps: sw.length, first: sw[0]?.n, last: sw.at(-1)?.n, verified: st.verify.build, counts, findings };
}

const CHECK_TEXT = {
  gap_in_numbering: "Sweep numbers without a gap",
  late_sweep: "Sweeps landing within 7 minutes of the previous one (rule 13: every five minutes)",
  mints_vs_owners: "Mints (listed + omitted) equal to the growth in owners (rule 3)",
  stale_reference: "Reference newer than 5 minutes (rule 11: a stale one stands, but the price room must say so)",
  missed_ranges: "No room ranges the referee could not read",
  rooms_unlisted: "No registered rooms dropped from the list (rule 5 says only deleted rooms leave it; see #11)",
  no_top_list: "A pnl post for every sweep",
};

function renderConsistency() {
  const c = consistency();
  consistencyFindings = c;
  $("consistency").innerHTML = `<table>${Object.entries(c.counts).map(([k, v]) => `<tr><td style="white-space:nowrap"><span class="badge ${v === 0 ? "ok" : v < 5 ? "warn" : "bad"}">${v === 0 ? "pass" : v + " sweeps"}</span></td><td>${esc(CHECK_TEXT[k])}</td></tr>`).join("")}</table>`;
  $("consNote").textContent = `${c.findings.length} findings over sweeps ${c.first}–${c.last}`;
}

$("consDl").addEventListener("click", () => {
  if (!consistencyFindings) return;
  const blob = new Blob([JSON.stringify(consistencyFindings, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `${contest.id}-referee-consistency-${consistencyFindings.last}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

/* ---------- orchestration ---------- */

function renderAll() {
  recompute();
  renderStatus(); renderTiles(); renderBoard(); renderSim(); renderCharts(); renderSides(); renderLeaders(); renderTenure(); renderClusters(); renderPositions(); renderHealth(); renderRecords(); renderConsistency(); renderVoids(); renderTape();
}
function renderFast() { renderTiles(); renderBoard(); renderSim(); }

async function init() {
  try { initTheme(); } catch { /* no DOM */ }
  try { const r = await fetch("contest.json", { cache: "no-store" }); if (r.ok) { configure(await r.json()); BASE = contest.chat; REFEREE = contest.referee; ROOMS = refereeRooms(); } } catch { /* defaults */ }
  verifier = await makeVerifier(REFEREE);
  st.verify.available = !!verifier;
  try {
    st.season = await loadSeasonFile();
    st.source = "season file";
    st.buildAt = st.season.generated;
    st.verify.build = st.season.verified;
  } catch (e) {
    $("status").textContent = `Reading the referee rooms directly (${e.message})…`;
    try {
      st.season = await loadExports();
      st.source = "rooms read directly";
      st.buildAt = st.season.generated;
      st.verify.build = st.season.verified;
    } catch (e2) {
      $("status").className = "status err";
      $("status").textContent = "Could not read the referee rooms: " + e2.message;
      return;
    }
  }
  const loadExact = async () => { const r = await fetch("data/exact.json", { cache: "no-store" }); if (r.ok) st.exact = await r.json(); };
  await Promise.all([tail().catch(() => 0), hlPrice(), loadTape().catch(() => false), loadExact().catch(() => null)]);
  renderAll();
  setInterval(async () => { try { if (await tail()) renderAll(); else renderStatus(); } catch { /* next minute */ } }, 60_000);
  setInterval(async () => { if (await hlPrice()) renderFast(); }, 5_000);
  // the room's text view caps at 200 posts (≈10–30 s at contest volume), so read often and accumulate
  setInterval(async () => { try { if (await loadTape()) renderTape(); } catch { /* next time */ } }, 15_000);
}

$("viewLive").addEventListener("click", () => { st.view = "live"; $("viewLive").className = "on"; $("viewBoard").className = ""; renderFast(); });
$("viewBoard").addEventListener("click", () => { st.view = "board"; $("viewBoard").className = "on"; $("viewLive").className = ""; renderFast(); });
$("solBtn").addEventListener("click", solve);
$("recBtn").addEventListener("click", () => reconcile().catch((e) => { $("recOut").innerHTML = `<p class="neg">${esc(e.message)}</p>`; }));
const lookupAll = () => { lookup(); const d = $("didIn").value.trim(); if (/^did:key:z/.test(d)) lookupLedger(d).catch(() => {}); };
$("didBtn").addEventListener("click", lookupAll);
$("didIn").addEventListener("keydown", (e) => { if (e.key === "Enter") lookupAll(); });

export { init, st, solve, reconcile, lookup, standings };
if (!globalThis.__NO_AUTO_INIT) init();
