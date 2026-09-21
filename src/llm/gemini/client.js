// Gemini API client with a two-axis cascade: model-first, key-rotation as
// the inner loop. Ported from allocsys/madmcp's connectors/gemini/client.js
// -- see that file for the original, more heavily-annotated version and
// prior-art reasoning. This is a trimmed port adapted to Cloudflare Workers
// (KV-backed cooldown instead of Redis; env/config passed explicitly instead
// of module-level imports, since Workers have no persistent process env).
//
// Cascade shape: for a requested `model`, try every key in
// config.geminiApiKeys before ever stepping down to a configured fallback
// model. A 429/503 is usually a per-model, per-key quota signal, so this
// maximizes use of the requested (better) model before downgrading.

import { isCoolingDown, setCooldown, parseRetryDelaySeconds } from "../../shared/cooldown.js";
import { VendorError } from "../../shared/errors.js";

const DEFAULT_COOLDOWN_SECONDS = 60;
// Overall wall-clock budget for the whole model/key cascade, independent of
// the per-call geminiRequestTimeoutMs. Added after a live incident where a
// scheduled run walked 2 models x N keys x 30s timeouts with zero logging,
// compounding to ~177s of total silence before Cloudflare's platform killed
// the invocation outright (outcome "exceededCpu", but really a duration
// ceiling -- each 30s wait was pure fetch/AbortController I/O, not CPU).
// This caps the cascade well under that ceiling and always throws a clear,
// logged error instead of letting the platform's kill be the first sign of
// trouble.
const MAX_CASCADE_MS = 90000;

/** One-line digest of a cascade's attempts, e.g. "m-a#0 error 429; m-b#0 skipped; m-c#0 error 503". */
function summarizeAttempts(attempts) {
  return attempts.map((a) => `${a.model}#${a.keyIndex} ${a.outcome}${a.status ? ` ${a.status}` : ""}`).join("; ");
}

/**
 * How long until some model/key is worth trying again: the shortest cooldown
 * this cascade recorded (a skipped combination counts as the default, its
 * true remaining time being unknown). Never below the default, because
 * Cloudflare KV cannot hold a cooldown shorter than 60s (shared/cooldown.js).
 */
function retryAfterFor(cooldownSeconds) {
  return cooldownSeconds.length ? Math.max(DEFAULT_COOLDOWN_SECONDS, Math.min(...cooldownSeconds)) : DEFAULT_COOLDOWN_SECONDS;
}

/**
 * What a cascade throws when it ends with nothing usable. It used to rethrow
 * `lastErr`, which is whatever the loop touched LAST -- often a synthetic
 * "model X is in a recorded cooldown" from a skipped combination, hiding the
 * timeouts / 503s / 429s that actually put everything in cooldown (a live
 * backtest died blaming gemini-2.5-flash's cooldown while the real causes were
 * five other models). This one names EVERY attempt and the last real error.
 * status/transient are inherited from the error it stands in for, so callers
 * that branch on them ("is this worth a pause?") behave as before; a transient
 * one also carries `retryAfterSeconds`.
 */
function cascadeExhaustedError({ realErr, lastErr, attempts, elapsedMs, cooldownSeconds }) {
  const cause = realErr ?? lastErr;
  const transient = cause?.transient === true;
  const tail = realErr ? `; last error: ${realErr.message}` : "; every model/key was in a recorded cooldown";
  return new VendorError("gemini", `Gemini cascade exhausted after ${elapsedMs}ms with no usable model [${summarizeAttempts(attempts)}]${tail}`, {
    status: cause?.status,
    transient,
    ...(transient ? { retryAfterSeconds: retryAfterFor(cooldownSeconds) } : {}),
  });
}

async function callOnce(config, model, apiKey, body, keyIndex) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.geminiRequestTimeoutMs);

  let res;
  try {
    res = await fetch(`${config.geminiApiBase}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = err.name === "AbortError";
    throw new VendorError(
      "gemini",
      isAbort
        ? `Gemini request timed out after ${config.geminiRequestTimeoutMs}ms (model: ${model}, key #${keyIndex})`
        : `Gemini network error (model: ${model}, key #${keyIndex}): ${err.message}`,
      { transient: true }
    );
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const message = (data && (data.error?.message || JSON.stringify(data))) || res.statusText;
    throw new VendorError("gemini", `Gemini API error (${res.status}, model: ${model}, key #${keyIndex}): ${message}`, {
      status: res.status,
      transient: res.status === 429 || res.status === 503,
    });
  }
  return data;
}

/**
 * Low-level cascade. `opts.model` becomes the PRIMARY model tried (honored
 * exactly -- if the caller asked for the deep model, we don't silently
 * upgrade or downgrade it), with config.geminiFallbackModels tried after it
 * only if every key on the primary model is exhausted.
 *
 * `opts.trace`, if given, is filled in as the cascade runs (by reference, so
 * it is populated even when this throws): `attempts` -- every model/key tried
 * in order, incl. cooldown skips -- plus `modelUsed`/`keyIndex` on success.
 * It exists for the LLM call log (storage/llm_calls.js); nothing here reads it.
 */
export async function geminiGenerateContent(env, config, body, opts = {}) {
  if (!config.geminiApiKeys.length) {
    throw new VendorError("gemini", "No Gemini API key configured. Set GEMINI_API_KEYS.");
  }
  const kv = env.CACHE_KV;
  const primaryModel = opts.model || config.geminiQuickModel;
  const models = [primaryModel, ...config.geminiFallbackModels.filter((m) => m !== primaryModel)];
  const cascadeStart = Date.now();
  const trace = opts.trace;
  // Kept locally as well as on opts.trace: the exhaustion errors below quote it,
  // and a caller that passed no trace still deserves a diagnosable message.
  const attempts = [];
  const cooldownSeconds = [];
  const note = (attempt) => {
    attempts.push(attempt);
    if (!trace) return;
    (trace.attempts ||= []).push(attempt);
  };

  let lastErr; // whatever the loop touched last -- may be a synthetic cooldown skip
  let realErr; // the last error a real call produced (never a skip)
  const cascadeExhausted = () => cascadeExhaustedError({ realErr, lastErr, attempts, elapsedMs: Date.now() - cascadeStart, cooldownSeconds });
  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];

    for (let ki = 0; ki < config.geminiApiKeys.length; ki++) {
      const apiKey = config.geminiApiKeys[ki];
      const isLastCombination = mi === models.length - 1 && ki === config.geminiApiKeys.length - 1;

      const elapsedMs = Date.now() - cascadeStart;
      if (elapsedMs >= MAX_CASCADE_MS) {
        const budgetErr = new VendorError(
          "gemini",
          `Gemini cascade exceeded its ${MAX_CASCADE_MS}ms budget after ${elapsedMs}ms (stopped before model "${model}" key #${ki}) [${summarizeAttempts(attempts)}]; last error: ${(realErr ?? lastErr)?.message || "none"}`,
          { transient: true, retryAfterSeconds: retryAfterFor(cooldownSeconds) }
        );
        console.log(`[gemini] cascade budget exceeded: ${budgetErr.message}`);
        note({ model, keyIndex: ki, outcome: "budget_exceeded", detail: budgetErr.message });
        throw budgetErr;
      }

      if (await isCoolingDown(kv, model, ki)) {
        console.log(`[gemini] model "${model}" key #${ki} skipped (cooldown active), elapsed=${elapsedMs}ms`);
        lastErr = new VendorError("gemini", `model "${model}" key #${ki} is in a recorded cooldown`, {
          status: 429,
          transient: true,
        });
        note({ model, keyIndex: ki, outcome: "skipped", detail: "cooldown active" });
        cooldownSeconds.push(DEFAULT_COOLDOWN_SECONDS);
        continue;
      }

      // Backtest only (backtest/subrequestBudget.js): the fetch below is one
      // subrequest. Charged OUTSIDE the try so an exhausted budget propagates
      // as a pause signal instead of being treated as a vendor failure (which
      // would burn a cooldown write and fall through to the next model).
      config.subrequestBudget?.chargeExternal();

      try {
        const data = await callOnce(config, model, apiKey, body, ki);
        note({ model, keyIndex: ki, outcome: "ok" });
        if (trace) {
          trace.modelUsed = model;
          trace.keyIndex = ki;
        }
        if (mi > 0 || ki > 0) {
          data._fallbackModelUsed = model;
          data._fallbackKeyIndex = ki;
          console.log(`[gemini] succeeded on fallback model "${model}" key #${ki} after ${elapsedMs}ms`);
        }
        return data;
      } catch (err) {
        lastErr = err;
        realErr = err;
        note({ model, keyIndex: ki, outcome: "error", status: err.status ?? null, detail: err.message });
        const isBadKey = err.status === 401 || err.status === 403;
        const isRateLimited = err.status === 429;
        const isOverloaded = err.status === 503;
        const isNetworkTransient = err.transient === true && !err.status;

        console.log(
          `[gemini] attempt failed: model="${model}" key=#${ki} status=${err.status || "n/a"} transient=${!!err.transient} elapsed=${Date.now() - cascadeStart}ms message=${err.message}`
        );

        // Bad/revoked key: skip to the next key on this SAME model. Must not
        // `break`, or we'd abandon the remaining keys entirely.
        if (isBadKey) continue;
        // 404: the model was retired / is unavailable to this project (Google:
        // "no longer available to new users"). Every key fails identically, so
        // skip this model's remaining keys and try the NEXT model instead of
        // killing the whole run. Nothing left to try -> surface it.
        if (err.status === 404) {
          if (mi === models.length - 1) throw err;
          break;
        }
        if (!isRateLimited && !isOverloaded && !isNetworkTransient) throw err;

        const seconds = isRateLimited ? parseRetryDelaySeconds(err.message) ?? DEFAULT_COOLDOWN_SECONDS : DEFAULT_COOLDOWN_SECONDS;
        cooldownSeconds.push(seconds);
        await setCooldown(kv, model, ki, seconds);
        if (isLastCombination) throw cascadeExhausted();
        // otherwise fall through to next key, or (via outer loop) next model
      }
    }
  }
  throw cascadeExhausted();
}

/** Single-turn text generation from a plain prompt string. */
export async function geminiGenerateText(env, config, prompt, opts = {}) {
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
  if (opts.maxOutputTokens) body.generationConfig = { maxOutputTokens: opts.maxOutputTokens };

  const data = await geminiGenerateContent(env, config, body, opts);
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const outputText = parts.map((p) => p.text || "").join("");

  if (!outputText) {
    throw new VendorError("gemini", `Gemini returned no text output (finishReason: ${candidate?.finishReason || "unknown"})`);
  }
  return outputText;
}

/** Strips a ```json ... ``` fence if the model wrapped its JSON output in one. */
export function stripJsonFence(text) {
  return text.trim().replace(/^```json\n?/, "").replace(/```$/, "").trim();
}
