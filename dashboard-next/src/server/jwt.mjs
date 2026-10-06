// Minimal, zero-dependency HS256 JWT sign/verify on the platform Web Crypto
// API (globalThis.crypto.subtle): available natively in Workers and in
// modern Node, so nothing is added to package.json.
//
// Ported from src/auth/jwt.js, which the backend Worker (src/dashboard/
// routes.js) and its tests still use. test/dashboard_gateway_parity.test.js
// pins the two copies to the same token format, so a token signed by one
// verifies on the other.
//
// Deliberately NOT a general JWT library: HS256 only, one signing key (the
// JWT_SECRET secret), one use (the dashboard session cookie). `header.alg` is
// checked against the literal "HS256" before any signature work, so a forged
// "alg": "none" token fails closed.

function utf8ToBytes(str) {
  return new TextEncoder().encode(str);
}

function bytesToUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

/** Uint8Array -> base64url (no padding), JWT's own encoding. */
function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url -> Uint8Array. Throws on malformed input; callers treat that as "invalid token". */
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
 * expiresInSeconds). Callers never set exp themselves, so a session's lifetime
 * is always exactly the configured TTL.
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
 * Verifies an HS256 JWT's signature and expiry. Returns the decoded payload, or
 * `null` on ANY failure (malformed, wrong alg, bad signature, expired): every
 * caller's only decision is "authenticated or not". crypto.subtle.verify
 * compares the signature in constant time.
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
  if (!header || header.alg !== "HS256") return null;

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
  if (payload && typeof payload.exp === "number" && payload.exp < now) return null;

  return payload;
}
