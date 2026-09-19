// Deep-think tier (plan.md Adopted Pattern #7) -- reasoning quality matters
// here, unlike the per-article analyst passes. Part of the Bull/Bear debate
// (plan.md Adopted Pattern #2): argues the strongest case FOR the position,
// using the Analyst Team's structured opinions as its only evidence.

import { callStructured } from "../utils/structured.js";
import { DebateSide } from "../../schemas/index.js";

export async function runBullResearcher(env, config, { ticker, opinions }) {
  const prompt = `You are a bullish equity researcher for ${ticker}. Using ONLY the analyst \
opinions below as evidence, argue the strongest bull case you can. You MUST include a \
one-sentence "justification".

Respond as JSON only, matching exactly:
{ "argument": string, "justification": string }

Analyst opinions:
${JSON.stringify(opinions, null, 2)}`;

  return callStructured(env, config, DebateSide, prompt, {
    model: config.geminiDeepModel,
    label: "debate:bull",
    extraFields: { stance: "bull" },
  });
}
