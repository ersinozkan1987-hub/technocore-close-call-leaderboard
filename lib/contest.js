// The contest configuration. Defaults mirror contest.json (close-1); `configure()` overrides them at runtime
// (build reads contest.json from disk, the page fetches it), so a new season is a JSON change, not a code change.
export const contest = {
  id: "close-1",
  title: "Close Call",
  referee: "did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte",
  chat: "https://technocore.chat",
  rooms: { trading: "close1", price: "d-close1-price", flow: "d-close1-flow", positions: "d-close1-positions", pnl: "d-close1-pnl", state: "d-close1-state", board: "close1-board" },
  market: "xyz:NVDA",
  hyperliquid_dex: "xyz",
  opening: "2026-09-25T12:00:00Z",
  lock: "2026-10-04T09:00:00Z",
  final_price_time: "2026-10-04T10:00:00Z",
  lock_sweep: 2556,
  sweep_seconds: 300,
  mint: 10000,
  fee_rate: 0.01,
  limit_window: 0.05,
  prize_pool: 1000000,
  prize_places: 3,
  prize_unit: "FLOP",
  page: "https://ersinozkan1987-hub.github.io/technocore-close-call-leaderboard/",
  rules: "https://github.com/flop-labs/technocore-close-call-challenge",
};

export function configure(obj) {
  if (!obj || typeof obj !== "object") return contest;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "rooms" && v && typeof v === "object") Object.assign(contest.rooms, v);
    else if (v !== undefined) contest[k] = v;
  }
  return contest;
}

// The five referee rooms in the order the build reads them, and each room's role.
export const refereeRooms = () => ["price", "flow", "positions", "pnl", "state"].map((r) => contest.rooms[r]);
export const roleOf = (room) => Object.entries(contest.rooms).find(([, v]) => v === room)?.[0] ?? null;
export const lockMs = () => Date.parse(contest.lock);
export const finalMs = () => Date.parse(contest.final_price_time);
