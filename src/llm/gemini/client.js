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
  const note = (attempt) => {
    if (!trace) return;
    (trace.attempts ||= []).push(attempt);
  };

  let lastErr;
  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];

    for (let ki = 0; ki < config.geminiApiKeys.length; ki++) {
      const apiKey = config.geminiApiKeys[ki];
      const isLastCombination = mi === models.length - 1 && ki === config.geminiApiKeys.length - 1;

      const elapsedMs = Date.now() - cascadeStart;
      if (elapsedMs >= MAX_CASCADE_MS) {
        const budgetErr = new VendorError(
          "gemini",
          `Gemini cascade exceeded its ${MAX_CASCADE_MS}ms budget after ${elapsedMs}ms (stopped before model "${model}" key #${ki}); last error: ${lastErr?.message || "none"}`,
          { transient: true }
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
        continue;
      }

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
        if (!isRateLimited && !isOverloaded && !isNetworkTransient) throw err;

        if (isRateLimited) {
          const seconds = parseRetryDelaySeconds(err.message) ?? DEFAULT_COOLDOWN_SECONDS;
          await setCooldown(kv, model, ki, seconds);
        } else {
          await setCooldown(kv, model, ki, DEFAULT_COOLDOWN_SECONDS);
        }
        if (isLastCombination) throw err;
        // otherwise fall through to next key, or (via outer loop) next model
      }
    }
  }
  throw lastErr;
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
