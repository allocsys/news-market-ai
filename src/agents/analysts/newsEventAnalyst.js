// Quick-think tier agent (plan.md Adopted Pattern #7) -- cheap/fast model,
// one call per article, high volume. Part of the parallel Analyst Team
// (plan.md Adopted Pattern #1): this agent only reports event type,
// entities, and a factual summary -- it does not judge sentiment or market
// direction, that's other analysts' and the Researcher Team's job.

import { callStructured } from "../utils/structured.js";
import { AnalystOpinion } from "../../schemas/index.js";

export async function runNewsEventAnalyst(env, config, newsItem) {
  const prompt = `You are a financial news/event analyst. Given the article below, identify \
the event type, entities/tickers involved, and a short factual summary. You MUST include \
a one-sentence "justification" explaining your reasoning -- never omit it.

Respond as JSON only, matching exactly:
{ "eventType": string, "entities": string[], "summary": string, "justification": string }

Title: ${newsItem.title}
Body: ${newsItem.body}`;

  return callStructured(env, config, AnalystOpinion, prompt, {
    model: config.geminiQuickModel,
    extraFields: { agent: "news_event", newsItemId: newsItem.id, modelUsed: config.geminiQuickModel },
  });
}
