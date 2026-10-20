/**
 * Cryptographically random base64url string (no padding) — for
 * server-generated secrets (per-call HMAC secrets, redeem passwords).
 * Uses the WebCrypto RNG; never Math.random (predictable).
 */
export function randomBase64Url(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
