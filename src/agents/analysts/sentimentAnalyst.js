// Quick-think tier agent, parallel to newsEventAnalyst.js -- see that file's
// header for the shared reasoning. Uses the 5-band scale rather than a bare
// pos/neg/neutral, following the pattern from rkaravangelis/llm-news-
// sentiment-agent (see plan.md Prior Art).

import { geminiGenerateText, stripJsonFence } from "../../llm/gemini/client.js";
import { AnalystOpinion, SentimentBand } from "../../schemas/index.js";

export async function runSentimentAnalyst(env, config, newsItem) {
  const prompt = `You are a financial sentiment analyst. Score the sentiment of the article \
below on this 5-band scale: ${SentimentBand.options.join(", ")}. You MUST include a \
one-sentence "justification" -- never omit it.

Respond as JSON only, matching exactly:
{ "sentiment": string, "summary": string, "justification": string }

Title: ${newsItem.title}
Body: ${newsItem.body}`;

  const text = await geminiGenerateText(env, config, prompt, { model: config.geminiQuickModel });
  const parsed = JSON.parse(stripJsonFence(text));

  return AnalystOpinion.parse({
    agent: "sentiment",
    newsItemId: newsItem.id,
    ...parsed,
    modelUsed: config.geminiQuickModel,
  });
}
