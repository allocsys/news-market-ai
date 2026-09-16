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
 */
export async function geminiGenerateContent(env, config, body, opts = {}) {
  if (!config.geminiApiKeys.length) {
    throw new VendorError("gemini", "No Gemini API key configured. Set GEMINI_API_KEYS.");
  }
  const kv = env.CACHE_KV;
  const primaryModel = opts.model || config.geminiQuickModel;
  const models = [primaryModel, ...config.geminiFallbackModels.filter((m) => m !== primaryModel)];

  let lastErr;
  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];

    for (let ki = 0; ki < config.geminiApiKeys.length; ki++) {
      const apiKey = config.geminiApiKeys[ki];
      const isLastCombination = mi === models.length - 1 && ki === config.geminiApiKeys.length - 1;

      if (await isCoolingDown(kv, model, ki)) {
        lastErr = new VendorError("gemini", `model "${model}" key #${ki} is in a recorded cooldown`, {
          status: 429,
          transient: true,
        });
        continue;
      }

      try {
        const data = await callOnce(config, model, apiKey, body, ki);
        if (mi > 0 || ki > 0) {
          data._fallbackModelUsed = model;
          data._fallbackKeyIndex = ki;
        }
        return data;
      } catch (err) {
        lastErr = err;
        const isBadKey = err.status === 401 || err.status === 403;
        const isRateLimited = err.status === 429;
        const isOverloaded = err.status === 503;
        const isNetworkTransient = err.transient === true && !err.status;

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
