// Per-(model, key) rate-limit cooldown tracking, backed by Cloudflare KV.
//
// Ported from allocsys/madmcp's connectors/shared/cooldown.js, which backs
// this with Upstash Redis (their infra is Vercel-based). KV is the more
// natural fit here: same "expires itself" TTL semantics, no external
// dependency, and the write pattern (only on a rate-limit event, never per
// request) sits comfortably inside KV's 1K writes/day free-tier cap.
//
// FAILS OPEN BY DESIGN: if `kv` is undefined/unreachable, every check
// reports "not cooling down" and every write silently no-ops. A KV outage
// must never be the reason a real Gemini call fails -- it only means
// cross-call memory is temporarily unavailable, same as before this existed.
//
// NOTE: Cloudflare KV enforces a 60-second minimum on `expirationTtl` --
// setCooldown() floors to that even if a parsed retry-delay is shorter.

const DEFAULT_COOLDOWN_SECONDS = 60;
const KV_MIN_TTL_SECONDS = 60;

function cooldownKey(model, keyIndex) {
  return `gemini:cooldown:${model}:${keyIndex}`;
}

export async function isCoolingDown(kv, model, keyIndex) {
  if (!kv) return false;
  try {
    const value = await kv.get(cooldownKey(model, keyIndex));
    return value != null;
  } catch {
    return false;
  }
}

export async function setCooldown(kv, model, keyIndex, seconds) {
  if (!kv) return;
  const ttl = Math.max(KV_MIN_TTL_SECONDS, Math.floor(seconds ?? DEFAULT_COOLDOWN_SECONDS));
  try {
    await kv.put(cooldownKey(model, keyIndex), "1", { expirationTtl: ttl });
  } catch {
    // best-effort only -- see file header
  }
}

// Extracts a retry delay in whole seconds from a Gemini 429 error message,
// e.g. "...Please retry in 52.395004654s." Returns null if not found, so the
// caller falls back to DEFAULT_COOLDOWN_SECONDS.
export function parseRetryDelaySeconds(message) {
  const match = /retry in ([\d.]+)\s*s/i.exec(message || "");
  return match ? Math.ceil(parseFloat(match[1])) : null;
}
