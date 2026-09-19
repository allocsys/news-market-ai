// Quick-think tier agent, parallel to newsEventAnalyst.js -- see that file's
// header for the shared reasoning. Uses the 5-band scale rather than a bare
// pos/neg/neutral, following the pattern from rkaravangelis/llm-news-
// sentiment-agent (see plan.md Prior Art).

import { callStructured } from "../utils/structured.js";
import { AnalystOpinion, SentimentBand } from "../../schemas/index.js";

export async function runSentimentAnalyst(env, config, newsItem) {
  const prompt = `You are a financial sentiment analyst. Score the sentiment of the article \
below on this 5-band scale: ${SentimentBand.options.join(", ")}. You MUST include a \
one-sentence "justification" -- never omit it.

Respond as JSON only, matching exactly:
{ "sentiment": string, "summary": string, "justification": string }

Title: ${newsItem.title}
Body: ${newsItem.body}`;

  return callStructured(env, config, AnalystOpinion, prompt, {
    model: config.geminiQuickModel,
    label: "analyst:sentiment",
    extraFields: { agent: "sentiment", newsItemId: newsItem.id, modelUsed: config.geminiQuickModel },
  });
}
