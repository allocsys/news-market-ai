// Mirror of bull.js -- see that file's header for the shared reasoning.

import { geminiGenerateText, stripJsonFence } from "../../llm/gemini/client.js";
import { DebateSide } from "../../schemas/index.js";

export async function runBearResearcher(env, config, { ticker, opinions }) {
  const prompt = `You are a bearish equity researcher for ${ticker}. Using ONLY the analyst \
opinions below as evidence, argue the strongest bear case you can. You MUST include a \
one-sentence "justification".

Respond as JSON only, matching exactly:
{ "argument": string, "justification": string }

Analyst opinions:
${JSON.stringify(opinions, null, 2)}`;

  const text = await geminiGenerateText(env, config, prompt, { model: config.geminiDeepModel });
  const parsed = JSON.parse(stripJsonFence(text));

  return DebateSide.parse({ stance: "bear", ...parsed });
}
