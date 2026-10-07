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
export async function runAnalystTeam(env, config, { ticker, newsItem, bars, macroContext = null }) {
  const snapshot = computeTechnicalSnapshot(bars);
  const needsTechnical = snapshot.hasData;

  // Judges the effect on the PRICE of the ticker, which is not the same as the article's sentiment (a rate-hike
  // story can read positive as news and still be bearish for gold). 'none' ends the pipeline run early
  // (graph/pipeline.js), so the prompt makes the model answer 'none' only when confident.
  const priceImpactSection = `

3. PRICE IMPACT: judge whether this article could move the PRICE of ${ticker}. Judge the effect on
the price -- not the article's tone, and not whether ${ticker} is named in the text. Macro data
(inflation, jobs, central-bank policy), interest rates and yields, the dollar, oil and commodities,
and geopolitical shocks count when they plausibly move this asset. "relevance": "direct" = about
${ticker} or its immediate supply/demand; "indirect" = a macro or market driver that plausibly
moves it; "none" = no plausible effect on its price (personal-finance advice, unrelated companies
or sectors, generic investing commentary, promotional lists, portfolio or ETF ideas, dividend-stock
picks). When unsure use "indirect" -- answer "none" only when you are confident. "direction": the
likely effect on the PRICE of ${ticker}, not the article's mood ("bullish", "bearish" or
"neutral"; for example higher real yields are bearish for gold). "channel": the transmission
channel in a few words (for example "rates/yields", "dollar", "oil", "company earnings"), or
"none".`;

  const technicalSection = needsTechnical
    ? `

4. TECHNICAL: Using ONLY the computed price/volume snapshot below -- never invent a number not \
given here -- describe the price/volume context. A null field means not enough bars yet for that \
indicator -- say so rather than guessing.

Technical snapshot:
${JSON.stringify(snapshot, null, 2)}`
    : `

There is no price-bar data for ${ticker} yet, so do NOT include a "technical" key in your response \
at all -- omit it entirely rather than guessing or returning an empty object.`;

  // XAUUSD macro context (agents/analysts/macroContext.js#loadMacroContext): a non-empty string only when the feature is on for
  // this run and the ticker is covered. Otherwise the section is "" and the prompt is byte-for-byte what it was before.
  const macroSection = macroContext
    ? `

MACRO CONTEXT for ${ticker} (point-in-time facts known as of this article; every value carries its own observation date, and slower
series can be weeks old). Use ONLY the figures listed here when you reason about the PRICE IMPACT, and never invent a macro number
that is not listed. This is background, not a verdict: it does not replace the article, and a stale or flat reading is not a reason
by itself to call the article bullish or bearish.

${macroContext}`
    : "";

  const prompt = `You are the Analyst Team for a trading pipeline: several specialists reporting \
independently on the SAME article, in ONE response. Every one of the "summary"/"justification" \
fields below is mandatory -- never omit them.

1. NEWS/EVENT: identify the event type, entities/tickers involved, and a short factual summary.
2. SENTIMENT: score the sentiment on this 5-band scale: ${SentimentBand.options.join(", ")}. \
The "sentiment" field must be EXACTLY one of those five words and nothing else -- never a \
sentence or explanation. Put all reasoning in "justification" instead.${priceImpactSection}${technicalSection}${macroSection}

Respond as JSON only, matching exactly:
{
  "news_event": { "eventType": string, "entities": string[], "summary": string, "justification": string },
  "sentiment": { "sentiment": string, "summary": string, "justification": string },
  "price_impact": { "relevance": "none" | "indirect" | "direct", "direction": "bullish" | "bearish" | "neutral", "channel": string, "summary": string, "justification": string }${needsTechnical ? ',\n  "technical": { "summary": string, "justification": string }' : ""}
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
  if (result.price_impact) {
    const impact = result.price_impact;
    // One readable line for the dashboard and the debate prompts: relevance, price direction, channel, then the model's own summary.
    const headline = `${impact.relevance} price impact, ${impact.direction}${impact.channel ? ` via ${impact.channel}` : ""}`;
    opinions.push(
      AnalystOpinion.parse({
        agent: "price_impact",
        newsItemId: newsItem.id,
        modelUsed,
        relevance: impact.relevance,
        priceDirection: impact.direction,
        channel: impact.channel,
        summary: impact.summary ? `${headline}: ${impact.summary}` : headline,
        justification: impact.justification,
      })
    );
  }
  if (needsTechnical && result.technical) {
    opinions.push(AnalystOpinion.parse({ agent: "technical", newsItemId: newsItem.id, modelUsed, ...result.technical }));
  }
  return opinions;
}
