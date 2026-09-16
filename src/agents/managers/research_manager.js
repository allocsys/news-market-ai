// Research manager (plan.md Adopted Pattern #2, restructured under
// agents/managers/ after comparing against TradingAgents' actual repo layout
// -- this is the debate-arbitration step, not another researcher, so it
// lives with portfolio_manager.js rather than under researchers/ alongside
// bull.js/bear.js). Reconciles the bull and bear arguments into one verdict.
// Runs on the deep model, same tier as bull/bear -- this is the step where
// debate quality actually pays off.

import { callStructured } from "../utils/structured.js";
import { DebateVerdict } from "../../schemas/index.js";

export async function runResearchManager(env, config, { ticker, asOf, bull, bear }) {
  const prompt = `You are the research desk judge for ${ticker}. Weigh the bull and bear cases \
below and produce a single synthesized verdict. You MUST include a "justification" that \
explains which side was more convincing and why -- never omit it.

Respond as JSON only, matching exactly:
{ "direction": "long"|"short"|"flat", "confidence": number (0-1), \
"timeHorizon": "intraday"|"days"|"weeks"|"months", "justification": string }

Bull case: ${JSON.stringify(bull)}
Bear case: ${JSON.stringify(bear)}`;

  return callStructured(env, config, DebateVerdict, prompt, {
    model: config.geminiDeepModel,
    extraFields: { ticker, asOf, bull, bear },
  });
}
