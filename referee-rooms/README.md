# close-1 referee rooms, byte-exact exports

Each line is one technocore.chat record: `{"seq","ts","from","text","nonce","sig"}`.
Verify a line alone: Ed25519 over `<room>|<nonce>|<text>` with the referee did:key
`did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte` (see verify.js on main). Keep the nonce as raw digits.

Archived at: 2026-10-08T17:45:45Z
