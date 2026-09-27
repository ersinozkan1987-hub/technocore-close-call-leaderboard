// Referee signature check. Runs in the browser (WebCrypto Ed25519) and in Node (node:crypto).
// A technocore.chat record is signed over `<room>|<nonce>|<text>` (UTF-8), signature base64url,
// key = the did:key's Ed25519 public key (multicodec 0xed 0x01 + 32 bytes, base58btc, "z" prefix).
// The nonce may be up to 19 digits, so it is taken as raw digits from the record line, never as a JS number.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s) {
  const bytes = [0];
  for (const ch of s) {
    let carry = ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error("base58: bad character");
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch !== "1") break; bytes.push(0); }
  return Uint8Array.from(bytes.reverse());
}

export function didToRawKey(did) {
  if (!did.startsWith("did:key:z")) throw new Error("not a did:key");
  const raw = base58Decode(did.slice(9));
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) throw new Error("not an ed25519 did:key");
  return raw.slice(2);
}

export function base64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4);
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

// The nonce as the digits written in the JSON line, so a 19-digit value is not rounded.
export function nonceDigits(line) {
  const m = /"nonce"\s*:\s*"?(\d+)"?/.exec(line);
  return m ? m[1] : null;
}

export function canonical(room, nonce, text) {
  return `${room}|${nonce}|${text}`;
}

const enc = new TextEncoder();

// Returns a verifier: async (room, nonce, text, sigB64url) => boolean, or null if no Ed25519 is available.
export async function makeVerifier(did) {
  const raw = didToRawKey(did);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const key = await subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
      return async (room, nonce, text, sig) => {
        try { return await subtle.verify({ name: "Ed25519" }, key, base64urlDecode(sig), enc.encode(canonical(room, nonce, text))); }
        catch { return false; }
      };
    } catch { /* WebCrypto without Ed25519 (older Safari): fall through */ }
  }
  if (typeof process !== "undefined" && process.versions?.node) {
    const { createPublicKey, verify } = await import("node:crypto");
    // SPKI prefix for an Ed25519 public key.
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(raw)]);
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    return async (room, nonce, text, sig) => {
      try { return verify(null, Buffer.from(canonical(room, nonce, text), "utf8"), key, Buffer.from(base64urlDecode(sig))); }
      catch { return false; }
    };
  }
  if (globalThis.nacl?.sign?.detached?.verify) {
    return async (room, nonce, text, sig) => {
      try { return globalThis.nacl.sign.detached.verify(enc.encode(canonical(room, nonce, text)), base64urlDecode(sig), raw); }
      catch { return false; }
    };
  }
  return null;
}

// Parses one export/JSON-view record of `room`, keeping only records from `did` that verify.
// `verifier` null = accept records from `did` unverified (caller reports "signature check unavailable").
export async function checkRecord(verifier, did, room, line, obj) {
  if (!obj || obj.from !== did) return { ok: false, why: "not referee" };
  if (!verifier) return { ok: true, verified: false };
  const nonce = nonceDigits(line) ?? String(obj.nonce);
  const ok = await verifier(room, nonce, obj.text, obj.sig || "");
  return ok ? { ok: true, verified: true } : { ok: false, why: "bad signature" };
}
