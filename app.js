import { makeVerifier, checkRecord, nonceDigits } from "./verify.js";
import { REFEREE, ROOMS, newSeason, applyPosts, expand, lastScored } from "./lib/season.js";
import { estimatePositions, settleAt, prizes, priceToPass, groupTies, fees, LOCK, LOCK_SWEEP, MINT } from "./lib/score.js";

const BASE = "https://technocore.chat";
const HL = "https://api.hyperliquid.xyz/info";
const SEASON_MAX_AGE = 2 * 3600e3;

const st = {
  season: null, source: "", buildAt: null,
  verify: { build: null, live: { ok: 0, bad: 0 }, available: true },
  live: { px: null, at: null, err: 0 },
  view: "live", ids: null, positions: new Map(), rows: [], scored: null,
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
    const r = await fetch(HL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids", dex: "xyz" }) });
    const j = await r.json();
    const px = Number(j["xyz:NVDA"]);
    if (px > 0) { st.live = { px, at: Date.now(), err: 0 }; return true; }
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
}

function currentS() {
  if (st.live.px && Date.now() - st.live.at < 120e3) return { S: st.live.px, src: "live Hyperliquid mid" };
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
  el.textContent = `Sweep ${s?.n ?? "–"} of ${LOCK_SWEEP} · referee post ${sc?.ts ? when(sc.ts) : "–"} · ${st.source} · live tail every minute, Hyperliquid every 5 s`;
  const b = st.verify.build, l = st.verify.live;
  let html = "";
  if (!st.verify.available) html += `<span class="badge warn">signature check unavailable in this browser</span>`;
  if (b) html += `<span class="badge ${b.bad ? "warn" : "ok"}">build: ${int(b.ok)} referee posts verified${b.bad ? `, ${b.bad} rejected` : ""} · ${when(st.buildAt)}</span>`;
  if (l.ok || l.bad) html += `<span class="badge ${l.bad ? "warn" : "ok"}">live: ${l.ok} verified here${l.bad ? `, ${l.bad} rejected` : ""}</span>`;
  $("verify").innerHTML = html;
}

function renderTiles() {
  const s = st.scored, last = st.season.sweeps.at(-1);
  const rows = standings();
  const left = LOCK - Date.now();
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
    ["Lock in", lockTxt, "4 Oct 09:00 UTC"],
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
    ? `Published scores re-marked at ${fmt(S)} (${src}), global mark ${fmt(s.global)}. Position: listed by the referee, or fitted from the key's score history (≈), or unknown (?) — unknown keys keep their published score.`
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
    const posTxt = (r) => r.position == null ? `<span class="muted">?</span>` : `${r.how === "fitted" ? "≈" : ""}${sign(r.position)}`;
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

/* ---------- reconcile ---------- */

async function loadIds() {
  if (st.ids) return st.ids;
  $("recStatus").textContent = "loading the referee's trade lists…";
  const r = await fetch("data/ids.json", { cache: "no-store" });
  if (!r.ok) throw new Error("ids.json " + r.status);
  st.ids = await r.json();
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
      <tr><td>Free POLF (if these are all your trades)</td><td class="num">${fmt(MINT - Math.abs(cost) - fee)}</td></tr>
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

/* ---------- orchestration ---------- */

function renderAll() {
  recompute();
  renderStatus(); renderTiles(); renderBoard(); renderCharts(); renderLeaders(); renderPositions();
}
function renderFast() { renderTiles(); renderBoard(); }

async function init() {
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
  await Promise.all([tail().catch(() => 0), hlPrice()]);
  renderAll();
  setInterval(async () => { try { if (await tail()) renderAll(); else renderStatus(); } catch { /* next minute */ } }, 60_000);
  setInterval(async () => { if (await hlPrice()) renderFast(); }, 5_000);
}

$("viewLive").addEventListener("click", () => { st.view = "live"; $("viewLive").className = "on"; $("viewBoard").className = ""; renderFast(); });
$("viewBoard").addEventListener("click", () => { st.view = "board"; $("viewBoard").className = "on"; $("viewLive").className = ""; renderFast(); });
$("solBtn").addEventListener("click", solve);
$("recBtn").addEventListener("click", () => reconcile().catch((e) => { $("recOut").innerHTML = `<p class="neg">${esc(e.message)}</p>`; }));
$("didBtn").addEventListener("click", lookup);
$("didIn").addEventListener("keydown", (e) => { if (e.key === "Enter") lookup(); });

export { init, st, solve, reconcile, lookup, standings };
if (!globalThis.__NO_AUTO_INIT) init();
