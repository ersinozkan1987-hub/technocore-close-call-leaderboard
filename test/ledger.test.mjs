// Ledger arithmetic against the rules' fold (close_call_fold.py Account.apply / value_at) on a hand-made case.
import assert from "node:assert/strict";
import { newLedger, applySweep, line, str } from "../build/ledger.mjs";

const A = "did:key:z6MkAAAA", B = "did:key:z6MkBBBB";
const L = newLedger();
const T = (id, maker, side, qty, px, ctr) => ({ id, maker, side, qty, px, taker: "any", until: 9, countersigner: ctr });
// A buys 10 @ 200 from B; close 200 → 1% fee each: 20
applySweep(L, 1, { input: { n: 1, trades: [T("t1", A, "buy", "10", "200.00", B)] },
  output: { sweep: 1, close: "200.00", trades: [{ id: "t1", outcome: "settled", maker_fee: "20", taker_fee: "20" }] } });
// A sells 4 @ 210 to B (closes 4 of A's long, closes 4 of B's short); close 210 → fee 8.4 each
applySweep(L, 2, { input: { n: 2, trades: [T("t2", A, "sell", "4", "210.00", B), { redacted: "private room" }] },
  output: { sweep: 2, close: "210.00", trades: [{ id: "t2", outcome: "settled", maker_fee: "8.4", taker_fee: "8.4" }, { redacted: "private room" }] } });
const [ka, ba] = line(L.accounts[A]), [kb, bb] = line(L.accounts[B]);
// A: cash 10000 − 2000 − 20 + 840 − 8.4 = 8811.6, 6 long @200 → score(S) = −1188.4 + 6S
assert.equal(str(L.accounts[A].c), "8811.6"); assert.equal(str(ka), "-1188.4"); assert.equal(str(ba), "6");
// B: short 10 @200 ties up 2000; buys back 4 @210 → +4·(400−210)=760; cash 10000−2000−20+760−8.4 = 8731.6
// open short 6 @200: score(S) = 8731.6 − 10000 + 6·(400 − S)... = −1268.4 + 2400 − 6S
assert.equal(str(kb), "1131.6"); assert.equal(str(bb), "-6");
// zero sum at any S: scores add to minus the fees
const S = 217n * 10n ** 8n;
assert.equal(str(ka + kb + (ba + bb) * S / 10n ** 8n), "-56.8");
assert.equal(L.hidden, 1); assert.equal(L.feeMismatch, 0);
console.log("ledger: fold arithmetic, zero sum and redaction ok");
