// Batched replacement for the Analyst Team's three separate Gemini calls
// (newsEventAnalyst.js, sentimentAnalyst.js, technicalAnalyst.js). Those
// three agents ran via Promise.all in graph/pipeline.js with no
// cross-dependency (unlike the bull/bear/judge/trader chain, which has real
// sequential dependencies and is NOT batched here) -- so one combined prompt
// asking for all three opinions at once cuts 3 Gemini calls down to 1 for
// every news item x ticker pipeline run.
//
// The three original agent files are left in place (still covered by their
// own unit tests for the no-bars-data/schema-shape pieces) but are no longer
// called from graph/pipeline.js's happy path -- this file is what pipeline.js
// calls instead.

import { callStructured } from "../utils/structured.js";
import { AnalystTeamOpinion, AnalystOpinion, SentimentBand } from "../../schemas/index.js";
import { computeTechnicalSnapshot } from "./technicalIndicators.js";

/**
 * `bars` should come from storage/inputs_view.js#getPriceBarsAsOf
 * (most-recent-first order) for this ticker/asOf, same contract
 * technicalAnalyst.js had -- passed in rather than fetched here.
 *
 * Returns the same shape graph/pipeline.js already expects from the old
 * three-call Promise.all: an array of AnalystOpinion objects with technical
 * omitted (not null) when there's no price-bar data yet, i.e. this function
 * does its own `.filter(Boolean)`-equivalent internally so the caller doesn't
 * need to.
 */
export async function runAnalystTeam(env, config, { ticker, newsItem, bars }) {
  const snapshot = computeTechnicalSnapshot(bars);
  const needsTechnical = snapshot.hasData;

  const technicalSection = needsTechnical
    ? `

3. TECHNICAL: Using ONLY the computed price/volume snapshot below -- never invent a number not \
given here -- describe the price/volume context. A null field means not enough bars yet for that \
indicator -- say so rather than guessing.

Technical snapshot:
${JSON.stringify(snapshot, null, 2)}`
    : `

There is no price-bar data for ${ticker} yet, so do NOT include a "technical" key in your response \
at all -- omit it entirely rather than guessing or returning an empty object.`;

  const prompt = `You are the Analyst Team for a trading pipeline: three specialists reporting \
independently on the SAME article, in ONE response. Every one of the "summary"/"justification" \
fields below is mandatory -- never omit them.

1. NEWS/EVENT: identify the event type, entities/tickers involved, and a short factual summary.
2. SENTIMENT: score the sentiment on this 5-band scale: ${SentimentBand.options.join(", ")}.${technicalSection}

Respond as JSON only, matching exactly:
{
  "news_event": { "eventType": string, "entities": string[], "summary": string, "justification": string },
  "sentiment": { "sentiment": string, "summary": string, "justification": string }${needsTechnical ? ',\n  "technical": { "summary": string, "justification": string }' : ""}
}

Title: ${newsItem.title}
Body: ${newsItem.body}`;

  const result = await callStructured(env, config, AnalystTeamOpinion, prompt, {
    model: config.geminiQuickModel,
    label: "analyst:team",
  });

  const modelUsed = config.geminiQuickModel;
  const opinions = [
    AnalystOpinion.parse({ agent: "news_event", newsItemId: newsItem.id, modelUsed, ...result.news_event }),
    AnalystOpinion.parse({ agent: "sentiment", newsItemId: newsItem.id, modelUsed, ...result.sentiment }),
  ];
  if (needsTechnical && result.technical) {
    opinions.push(AnalystOpinion.parse({ agent: "technical", newsItemId: newsItem.id, modelUsed, ...result.technical }));
  }
  return opinions;
}
