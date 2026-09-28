#!/usr/bin/env node
// Close Call MCP server: read-only tools for agents, over stdio, no dependencies (Node ≥ 20).
// Data comes from the published board (data/*.json, verified in the build) and, for offers, the trading
// room read directly. It never signs or posts anything.
//   claude mcp add close-call -- node /path/to/mcp/server.mjs
// Tools: board, standings_at_price, key, open_offers, price_to_pass, reconcile, contest
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contest, configure } from "../lib/contest.js";
import { lastTrade } from "../lib/hl.js";
import { fees, priceToPass, prizes, settleAt, estimatePositions } from "../lib/score.js";
import { expand, lastScored } from "../lib/season.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
try { configure(JSON.parse(await readFile(path.join(HERE, "..", "contest.json"), "utf8"))); } catch { /* defaults */ }
const PAGE = process.env.CLOSE_CALL_PAGE || contest.page;

async function getJson(url, opts) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttlMs) return c.v;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}
const board = () => cached("board", 60e3, () => getJson(`${PAGE}data/board.json`));
const season = () => cached("season", 300e3, () => getJson(`${PAGE}data/season.json`));
const ids = () => cached("ids", 300e3, () => getJson(`${PAGE}data/ids.json`));
async function livePrice() {
  return (await lastTrade({ signal: AbortSignal.timeout(15_000) })).px;
}

const TOOLS = [
  { name: "contest", description: "Contest configuration: rooms, referee key, lock time, mint, fee, prize pool.", inputSchema: { type: "object", properties: {} } },
  { name: "board", description: "Latest published board re-marked at the referee's Hyperliquid reference: standings, positions, prize line, ties, verification counts.", inputSchema: { type: "object", properties: {} } },
  { name: "standings_at_price", description: "Re-mark the published top list at a given final price S (default: last Hyperliquid trade) and return prize places.", inputSchema: { type: "object", properties: { S: { type: "number", description: "final price; omitted = live Hyperliquid mid" } } } },
  { name: "key", description: "History of one did:key in the published lists: scores, ranks, positions, best, last.", inputSchema: { type: "object", properties: { did: { type: "string" } }, required: ["did"] } },
  { name: "open_offers", description: "Offers in the trading room with taker 'any' that are still valid for the next sweep and inside its price limits.", inputSchema: { type: "object", properties: {} } },
  { name: "price_to_pass", description: "Final price at which a net position q with breakeven b passes the current leader and the prize line.", inputSchema: { type: "object", properties: { q: { type: "number", description: "net contracts, negative for short" }, b: { type: "number", description: "breakeven price" } }, required: ["q", "b"] } },
  { name: "reconcile", description: "Look up your trade ids in the referee's flow lists and compute position, fees (rule 12), breakeven and score at the live price.", inputSchema: { type: "object", properties: { trades: { type: "array", items: { type: "object", properties: { id: { type: "string" }, side: { type: "string", enum: ["buy", "sell"] }, qty: { type: "number" }, px: { type: "number" } }, required: ["id", "side", "qty", "px"] } } }, required: ["trades"] } },
];

async function call(name, a = {}) {
  switch (name) {
    case "contest": return contest;
    case "board": return board();
    case "standings_at_price": {
      const s = await season();
      const s0 = lastScored(s);
      const sweeps = s.sweeps.filter((x) => x.n <= s0.n).map((x) => expand(s, x));
      const last = sweeps.at(-1);
      const S = a.S ?? await livePrice();
      const rows = prizes(settleAt(last, estimatePositions(sweeps), S));
      return { sweep: last.n, S, global: last.global, rows };
    }
    case "key": {
      try { return await getJson(`${PAGE}data/key/${encodeURIComponent(a.did)}.json`); }
      catch { return { key: a.did, found: false, note: "never in a published top list; the referee publishes only the top ~25 scores and ~10 positions" }; }
    }
    case "open_offers": {
      const [b, r] = await Promise.all([board(), getJson(`${contest.chat}/r/${contest.rooms.trading}?format=json&limit=200`)]);
      const next = b.sweep + 1, [lo, hi] = b.limits;
      const taken = new Set(), offers = new Map();
      for (const m of r.messages || []) {
        let t; try { t = JSON.parse(m.text); } catch { continue; }
        if (t.t === "trade" && t.terms) taken.add(t.terms.id);
        if (t.t === "offer" && t.terms?.taker === "any" && +t.terms.until >= next && +t.terms.px >= lo && +t.terms.px <= hi) offers.set(t.terms.id, { ...t.terms, posted: m.ts });
      }
      return { next_sweep: next, limits: [lo, hi], offers: [...offers.values()].filter((o) => !taken.has(o.id)) };
    }
    case "price_to_pass": {
      const r = await call("standings_at_price", {});
      const paid = r.rows.filter((x) => x.prize > 0);
      const lead = r.rows[0], line = paid.at(-1);
      return { S_now: r.S, your_score_now: a.q * (r.S - a.b), pass_leader: priceToPass(a.q, a.b, lead, r.global), reach_prize_line: line ? priceToPass(a.q, a.b, line, r.global) : null, leader: lead, prize_line: line };
    }
    case "reconcile": {
      const [i, s] = await Promise.all([ids(), season()]);
      const refAt = new Map(s.sweeps.map((x) => [x.n, x.ref]));
      let S; try { S = await livePrice(); } catch { S = s.sweeps.at(-1)?.ref; }
      let q = 0, cost = 0, fee = 0;
      const out = a.trades.map((t) => {
        const n = i.settled[t.id], v = i.void[t.id];
        if (n != null) {
          const f = fees(t.qty, t.px, refAt.get(n) ?? t.px), mine = t.side === "buy" ? f.buyer : f.seller, d = t.side === "buy" ? 1 : -1;
          q += d * t.qty; cost += d * t.qty * t.px; fee += mine;
          return { ...t, outcome: "settled", sweep: n, close: refAt.get(n), fee: mine };
        }
        return v ? { ...t, outcome: "void", reasons: v } : { ...t, outcome: "not listed" };
      });
      return { S, trades: out, net_position: q, average_entry: q ? cost / q : null, fees: fee, breakeven: q ? (cost + (q > 0 ? fee : -fee)) / q : null, score_at_S: q * S - cost - fee };
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}

// Minimal JSON-RPC over stdio (newline-delimited), enough for the MCP handshake and tool calls.
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    try {
      if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "close-call-leaderboard", version: "1.0.0" } } });
      else if (method === "notifications/initialized" || method === "ping") { if (id != null) send({ jsonrpc: "2.0", id, result: {} }); }
      else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      else if (method === "tools/call") {
        const r = await call(params.name, params.arguments || {});
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r, null, 1) }] } });
      } else if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    } catch (e) {
      if (id != null) send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `error: ${e.message}` }], isError: true } });
    }
  }
});
