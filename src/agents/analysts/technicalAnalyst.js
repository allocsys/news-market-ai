// Quick-think tier agent, parallel to newsEventAnalyst.js/sentimentAnalyst.js
// (see newsEventAnalyst.js's header for the shared Analyst Team reasoning).
// Unlike those two, this agent's input is not free text -- it's a grounded
// numeric snapshot from technicalIndicators.js#computeTechnicalSnapshot,
// computed off real storage/d1.js#getPriceBarsAsOf rows (plan.md Adopted
// Pattern #9: the model interprets real numbers, it never invents them).
//
// HONEST SCOPE: price_bars is only populated once yfinance ingestion is
// wired into graph/pipeline.js (a separate, already-documented plan.md
// gap) -- until then getPriceBarsAsOf returns no rows for most/all
// tickers, computeTechnicalSnapshot returns { hasData: false }, and this
// agent returns null without calling the LLM at all, rather than asking a
// model to analyze a blank slate. graph/pipeline.js must filter a null
// result out of its opinions array, same as any other optional analyst
// output.

import { callStructured } from "../utils/structured.js";
import { AnalystOpinion } from "../../schemas/index.js";
import { computeTechnicalSnapshot } from "./technicalIndicators.js";

/**
 * `bars` should come from storage/d1.js#getPriceBarsAsOf (most-recent-first
 * order) for this ticker/asOf -- passed in rather than fetched here so this
 * stays a plain function like the other analysts, with DB access kept in
 * graph/pipeline.js.
 */
export async function runTechnicalAnalyst(env, config, { ticker, newsItem, bars }) {
  const snapshot = computeTechnicalSnapshot(bars);
  if (!snapshot.hasData) {
    return null;
  }

  const prompt = `You are a technical analyst for ${ticker}. Using ONLY the computed price/volume \
snapshot below -- never invent a number not given here -- describe the price/volume context. \
You MUST include a one-sentence "justification" -- never omit it.

Respond as JSON only, matching exactly:
{ "summary": string, "justification": string }

Technical snapshot (a null field means not enough bars yet for that indicator -- say so rather than guessing):
${JSON.stringify(snapshot, null, 2)}`;

  return callStructured(env, config, AnalystOpinion, prompt, {
    model: config.geminiQuickModel,
    label: "analyst:technical",
    extraFields: { agent: "technical", newsItemId: newsItem.id, modelUsed: config.geminiQuickModel },
  });
}
