// A KV wrapper that stores EVERY Gemini cooldown in ONE KV key instead of one key
// per (model, key index).
//
// WHY (2026-10-03 backtest incident): the cascade (llm/gemini/client.js) checks
// `gemini:cooldown:<model>:<keyIndex>` with one kv.get() per model/key combination,
// ~9 models x 4 keys. While most combinations were cooling down, EVERY part (and every
// live LLM call) re-read all of them: ~29-38 KV reads per backtest part, which burned
// the whole 40-subrequest budget on reads alone (zero progress for ~4h) and 26k of the
// 50k daily KV reads in a day. With this wrapper a part (or live message) costs ONE
// read however many combinations the cascade walks, and cooldown WRITES stay one put
// per cooldown event, as before.
//
// HOW: shared/cooldown.js and the cascade are unchanged. This wrapper sits under them
// and intercepts only keys starting with `gemini:cooldown:`:
//   - get(): loads the map (ONE underlying kv.get of `gemini:cooldown-map`) the first
//     time, then answers every per-key get from memory. Entries carry their own expiry,
//     so a cached map never reports an expired cooldown, however old it is.
//   - put(): merges the entry into the map and writes the map back (ONE kv.put).
//   - everything else (other keys, typed gets, list) passes straight through.
// A non-daily ("1") entry is returned as `min:<expiry epoch ms>`, which getCooldown()
// understands, so the cascade learns the REAL remaining time of a per-minute cooldown
// (and its retry hint stops being the flat 60s default).
//
// MAP FORMAT: JSON {"<full per-key name>": [<value string>, <expiry epoch ms | null>]}.
// The map key's own TTL is the longest remaining entry (>= KV's 60s minimum), so an
// idle map expires by itself. Entries already expired are dropped on load and on write.
//
// CONCURRENCY: two modes.
//   - exclusiveWriter: true (backtest): the only writer of this KV namespace is this one
//     invocation (queue max_concurrency 1), so the map loaded once is authoritative for
//     the whole invocation and a put needs no fresh read.
//   - default (live llm Worker): other invocations write the same map concurrently, so
//     a put first RE-READS the map (read-modify-write, so it does not clobber a cooldown
//     another invocation just recorded), and the cached copy is dropped after
//     `refreshMs` so a cooldown recorded elsewhere is noticed. A lost update is
//     self-healing: the next call to that model/key just gets one more 429 and
//     records the cooldown again.
//
// Cooldown state was always best-effort and FAILS OPEN (shared/cooldown.js catches
// whatever this throws): a KV outage never blocks a real Gemini call.
//
// MIGRATION: per-key `gemini:cooldown:*` entries written before this shipped are not
// read any more; they expire within a day on their own. Worst case each of those
// model/key pairs costs one extra 429 before its cooldown is recorded in the map.

import { MINUTE_PREFIX } from "./cooldown.js";

export const COOLDOWN_MAP_KEY = "gemini:cooldown-map";
const COOLDOWN_KEY_PREFIX = "gemini:cooldown:";
const KV_MIN_TTL_SECONDS = 60;

/**
 * @param kv a KV namespace (usually already wrapped by countedKv in the backtest)
 * @param {object} [opts]
 * @param {() => number} [opts.now] clock (tests)
 * @param {number} [opts.refreshMs] max age of the cached map before it is re-read (default: never)
 * @param {boolean} [opts.exclusiveWriter] true when this invocation is the only writer of the namespace
 */
export function cooldownMapKv(kv, { now = () => Date.now(), refreshMs = Infinity, exclusiveWriter = false } = {}) {
  let entries = null; // Map<fullKey, { value: string, exp: number | null }>, null until the first load
  let loadedAt = 0;

  const isCooldownKey = (key) => typeof key === "string" && key.startsWith(COOLDOWN_KEY_PREFIX);
  const alive = (entry, t) => entry.exp === null || entry.exp > t;

  function parse(raw) {
    const out = new Map();
    if (raw == null) return out;
    let obj;
    try {
      obj = JSON.parse(String(raw));
    } catch {
      return out;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
    const t = now();
    for (const [key, entry] of Object.entries(obj)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      const exp = entry[1] === null ? null : Number(entry[1]);
      const parsed = { value: entry[0], exp };
      // A garbled expiry (NaN) fails alive() and is dropped, like an expired one.
      if (alive(parsed, t)) out.set(key, parsed);
    }
    return out;
  }

  /** Loads the map when none is cached, the cache is older than refreshMs, or `force`. A failing kv.get propagates (the caller fails open). */
  async function load(force = false) {
    if (!force && entries && now() - loadedAt < refreshMs) return;
    entries = parse(await kv.get(COOLDOWN_MAP_KEY));
    loadedAt = now();
  }

  async function persist() {
    const t = now();
    for (const [key, entry] of entries) if (!alive(entry, t)) entries.delete(key);
    const obj = {};
    let forever = false;
    let maxExp = 0;
    for (const [key, entry] of entries) {
      obj[key] = [entry.value, entry.exp];
      if (entry.exp === null) forever = true;
      else maxExp = Math.max(maxExp, entry.exp);
    }
    // Empty map: still write it ("{}", minimum TTL) rather than delete -- one put, nothing to clean up later.
    const ttl = forever ? null : Math.max(KV_MIN_TTL_SECONDS, Math.ceil((maxExp - t) / 1000));
    await kv.put(COOLDOWN_MAP_KEY, JSON.stringify(obj), ttl === null ? undefined : { expirationTtl: ttl });
  }

  return {
    async get(key, ...rest) {
      if (!isCooldownKey(key) || rest.length > 0) return kv.get(key, ...rest);
      await load();
      const entry = entries.get(key);
      if (!entry || !alive(entry, now())) return null;
      // A per-minute cooldown is stored as "1"; hand it back with its expiry so getCooldown can report the remaining time.
      return entry.value === "1" && entry.exp !== null ? `${MINUTE_PREFIX}${entry.exp}` : entry.value;
    },

    async put(key, value, options) {
      if (!isCooldownKey(key)) return kv.put(key, value, options);
      await load(!exclusiveWriter);
      const ttl = options?.expirationTtl;
      entries.set(key, { value: String(value), exp: Number.isFinite(ttl) ? now() + ttl * 1000 : null });
      await persist();
    },

    async delete(key) {
      if (!isCooldownKey(key)) return kv.delete(key);
      await load(!exclusiveWriter);
      entries.delete(key);
      await persist();
    },

    list: (...args) => kv.list(...args),
  };
}
