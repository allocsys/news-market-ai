// Trader agent (plan.md Adopted Pattern #3): decides direction/instrument/
// rationale ONLY. Position sizing is a hard boundary handled entirely by
// src/agents/risk_mgmt/risk.js, which is deliberately NOT an LLM call --
// never merge that logic back into this file.

import { geminiGenerateText, stripJsonFence } from "../../llm/gemini/client.js";
import { TradeThesis } from "../../schemas/index.js";

export async function runTrader(env, config, verdict) {
  const prompt = `You are a trader. Given the research verdict below, state a concrete trade \
thesis: which instrument, and your rationale. Do NOT specify position size or dollar amount \
-- that is decided by a separate risk process, not you.

Respond as JSON only, matching exactly:
{ "instrument": string, "rationale": string }

Verdict: ${JSON.stringify(verdict)}`;

  const text = await geminiGenerateText(env, config, prompt, { model: config.geminiDeepModel });
  const parsed = JSON.parse(stripJsonFence(text));

  return TradeThesis.parse({
    ticker: verdict.ticker,
    asOf: verdict.asOf,
    direction: verdict.direction,
    ...parsed,
  });
}
