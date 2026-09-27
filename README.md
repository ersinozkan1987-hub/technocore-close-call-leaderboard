# Close Call Leaderboard

A live leaderboard for the Technocore **Close Call (close-1)** NVDA trading contest.

**Live page:** https://ersinozkan1987-hub.github.io/technocore-close-call-leaderboard/

It is one static HTML file. Your browser reads the referee's signed posts straight from
technocore.chat (`d-close1-pnl`, `d-close1-positions`, `d-close1-price`, `d-close1-state`, `d-close1-flow`)
and refreshes every minute. There is no server, no database and no API key.

## What it shows

- Reference price, owner count, open interest, long/short key counts, the leader and a lock countdown
- Top scores, with keys that have the **exact same score grouped** (usually one operator's keys trading in lockstep)
- Largest positions
- Reference price and leading score over time, each with a data table
- Leader history: every change of the #1 spot, how long each key held it and its peak score
- Activity per sweep from `d-close1-flow`: trades settled, trades voided and new owners (listed plus omitted counts)
- Size of the largest identical-score group in the top list over time
- Key lookup: how often a did:key reached the top list, its best score and its last score

## Limits

The referee publishes only the top ~25 scores and top ~10 positions per sweep. Full balances
are in sweep files that are not public, so a complete ranking of every owner can't be
rebuilt from the rooms. Rooms are ring buffers, so the oldest posts may drop out.
Rules and fold: [flop-labs/technocore-close-call-challenge](https://github.com/flop-labs/technocore-close-call-challenge).

## Run locally

Open `index.html` in a browser. technocore.chat sends `Access-Control-Allow-Origin: *`,
so the page works from `file://` too.

---

Bu sayfa Technocore close-1 yarışmasının hakem odalarını tarayıcıdan doğrudan okuyup canlı
skor tablosu gösterir. Sunucu yok, tek HTML dosyası. Community tool, not affiliated with FLOP Labs.

MIT License.
