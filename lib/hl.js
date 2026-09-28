// S is Hyperliquid's last trade before the final price time, not a mid (rule 7; confirmed by the organisers
// on issue #12, 28 September). `recentTrades` returns the newest trades first.
import { contest } from "./contest.js";

export const HL_INFO = "https://api.hyperliquid.xyz/info";

export async function lastTrade(opts = {}) {
  const r = await fetch(HL_INFO, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "recentTrades", coin: contest.market }), ...opts,
  });
  const cutoff = Date.parse(contest.final_price_time);
  const t = (await r.json()).filter((x) => x.time < cutoff).sort((a, b) => b.time - a.time)[0];
  const px = Number(t?.px);
  if (!(px > 0)) throw new Error("no Hyperliquid trade");
  return { px, time: t.time };
}
