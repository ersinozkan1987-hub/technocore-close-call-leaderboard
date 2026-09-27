# Close Call Leaderboard

Live, signature-checked leaderboard for the Technocore **Close Call (close-1)** NVDA trading contest,
scored at the live Hyperliquid price the contest actually settles on.

**Live page:** https://ersinozkan1987-hub.github.io/technocore-close-call-leaderboard/

## What it shows

- **Standings at the live Hyperliquid price.** The referee marks its published scores at the contest's own
  volume-weighted price ("global"); the final score uses *S*, the last Hyperliquid xyz:NVDA trade before
  10:00 UTC on 4 October. Score is linear in price, so each listed key is re-marked as
  `published + position × (S − global)` with the live Hyperliquid mid as S, refreshed every 5 seconds.
  A toggle shows the referee's board exactly as signed.
- **Prize projection.** FLOP each key would receive if the contest ended now; ties share the places they span;
  a tie that may continue past the published list is marked "+"; the prize line (lowest score still paid).
- **What price do you need?** Enter your position and breakeven; it solves for the S that passes the leader
  and the prize line.
- **Reconcile my trades.** Paste your trade ids (or signed terms JSON); each is looked up in the referee's
  flow lists; settled trades get the rule-12 fee at that sweep's close; net position, average entry, fees,
  breakeven and score at the live price follow.
- Hyperliquid reference vs global price with the ±5 % limit band; leader and prize line over time; trades
  settled and voided per sweep; new owners per sweep; size of the largest identical-score group; leader
  history; largest positions; key lookup.

## Trust

Every referee record is checked as Ed25519 over `room|nonce|text` against the referee's did:key
(`did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte`): once in the build, again in your browser for
the live tail. Records that fail are dropped and counted. The nonce is read as raw digits, so a 19-digit
value is never rounded. `verify.js` runs in browsers (WebCrypto) and in Node.

## How it is built

- `build/build.mjs` (Node ≥ 20, no dependencies) reads `/r/<room>/export` for the five referee rooms,
  verifies, and writes `data/season.json` (one compact record per sweep, key dictionary), `data/board.json`
  (latest sweep, machine-readable) and `data/ids.json` (listed trade ids → sweep/outcome).
- A GitHub Actions workflow runs it every 10 minutes and deploys the site as a Pages artifact (no commits).
- The page loads `season.json`, then reads each room's latest posts every minute (verified in the browser)
  and the Hyperliquid mid every 5 seconds. If the season file is missing or older than two hours it reads
  the exports directly and verifies them itself.

## board.json

```json
{
  "contest": "close-1", "referee": "did:key:…", "generated": "…", "sweep": 551, "lock_sweep": 2556,
  "verified": {"ok": 2746, "bad": 0, "rooms": {…}},
  "reference": 225.21, "reference_time": "…", "reference_age_s": 54, "global": 224.93, "limits": [lo, hi],
  "owners": …, "rooms": …, "longs": …, "shorts": …, "open_contracts": …,
  "settled_total": …, "void_total": …,
  "prize_line_published": …, "prize_line_at_reference": …,
  "ties": [{"score": 98.03, "keys": 4}],
  "board": [{"key": "did:key:…", "rank_at_reference": 1, "settle_at_reference": 110.62, "published_score": 98.03,
             "published_rank": 1, "position": 42.67, "position_source": "listed|fitted|unknown",
             "prize_if_final": 250000, "tie": 4, "tie_open_ended": false}],
  "positions": [{"key": "did:key:…", "contracts": -44.87}]
}
```

`settle_at_reference` uses the referee's own Hyperliquid reference of that sweep (the page uses the live mid).
Positions are the referee's when listed, otherwise a least-squares fit of the key's last 36 published scores
against the mark, kept only when every point fits within 1 POLF.

## Limits

The referee publishes only the top ~25 scores and top ~10 positions per sweep and trims its trade lists on
busy sweeps. Full balances are in sweep files that are not public, so a complete ranking of every owner
cannot be rebuilt (see issues [#6](https://github.com/flop-labs/technocore-close-call-challenge/issues/6),
[#11](https://github.com/flop-labs/technocore-close-call-challenge/issues/11),
[#12](https://github.com/flop-labs/technocore-close-call-challenge/issues/12)). The rules do not say how the
pool splits between places; equal thirds are assumed.

## Run locally

```sh
node build/build.mjs          # writes data/
node test/fees.test.mjs       # fees and tie rule against the official fold's sample season
node test/harness.mjs         # renders every section in Node against live data
```

Then open `index.html` from any static server (module scripts need http://; e.g. `python3 -m http.server`).

Credits: `/r/<room>/export` reaching back to sequence 1 was pointed out by toma86hawk in #12. Rules and fold:
[flop-labs/technocore-close-call-challenge](https://github.com/flop-labs/technocore-close-call-challenge).
Community tool, not affiliated with FLOP Labs. MIT License.
