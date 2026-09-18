// Minimal, zero-dependency HS256 JWT sign/verify using the platform Web
// Crypto API (globalThis.crypto.subtle) -- available natively in the
// Workers runtime (no polyfill/package needed) and in modern Node (used by
// this repo's own `node --test` suite), so this needs nothing added to
// package.json. Deliberately NOT a general JWT library: only HS256, no
// "alg": "none"/asymmetric support, no JWK/kid handling -- this project
// has exactly one signing key (config.jwtSecret) and one use case (the
// dashboard's own session cookie, see ../auth/session.js), so anything
// beyond that would be unused surface area, not robustness.
//
// SECURITY NOTE: `header.alg` is checked against the literal string
// "HS256" before ever computing/verifying a signature -- this is what
// stops a classic JWT "alg confusion" attack (a forged token claiming
// "alg": "none" or an asymmetric alg the verifier wasn't expecting). This
// verifier only ever knows how to check HS256, so there is no confusion
// possible, but the explicit check still fails closed on anything else
// rather than silently falling through.

function utf8ToBytes(str) {
  return new TextEncoder().encode(str);
}

function bytesToUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

/** Uint8Array -> base64url (no padding) -- JWT's own encoding, not plain base64. */
function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url -> Uint8Array. Throws on malformed input -- callers treat that as "invalid token", not a crash. */
function base64UrlToBytes(str) {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secret, usage) {
  return crypto.subtle.importKey("raw", utf8ToBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/**
 * Signs `payload` as an HS256 JWT, adding `iat` (now) and `exp` (now +
 * expiresInSeconds) -- callers never set exp themselves, this is the one
 * place expiry is decided, so a session's lifetime is always exactly
 * config.sessionTtlSeconds (see auth/session.js), never accidentally
 * omitted or mismatched between issuance and verification.
 */
export async function signJwt(payload, secret, { expiresInSeconds }) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

  const encodedHeader = bytesToBase64Url(utf8ToBytes(JSON.stringify(header)));
  const encodedPayload = bytesToBase64Url(utf8ToBytes(JSON.stringify(fullPayload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importHmacKey(secret, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, utf8ToBytes(signingInput));
  const encodedSignature = bytesToBase64Url(new Uint8Array(signature));

  return `${signingInput}.${encodedSignature}`;
}

/**
 * Verifies an HS256 JWT's signature and expiry, returning the decoded
 * payload on success or `null` on ANY failure (malformed shape, wrong
 * alg, bad signature, expired) -- deliberately one failure value, not a
 * thrown error per case, since every caller's only real decision is
 * "authenticated or not" (see auth/session.js#getSessionUsername). The
 * signature check itself uses crypto.subtle.verify, which does a
 * constant-time comparison internally -- unlike this codebase's plain
 * `!==` secret comparisons elsewhere (BACKFILL_API_SECRET et al), this
 * one doesn't need a manual timing-safe compare, Web Crypto already does it.
 */
export async function verifyJwt(token, secret) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let header;
  try {
    header = JSON.parse(bytesToUtf8(base64UrlToBytes(encodedHeader)));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null; // fail closed on anything not explicitly supported -- see header note

  let signatureBytes;
  try {
    signatureBytes = base64UrlToBytes(encodedSignature);
  } catch {
    return null;
  }

  const key = await importHmacKey(secret, "verify");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const valid = await crypto.subtle.verify("HMAC", key, signatureBytes, utf8ToBytes(signingInput));
  if (!valid) return null;

  let payload;
  try {
    payload = JSON.parse(bytesToUtf8(base64UrlToBytes(encodedPayload)));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) return null;

  return payload;
}
