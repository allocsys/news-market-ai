// Merged verdict (backtest knob `mergedVerdict`): ONE model call that argues the bull and the bear case briefly and then
// judges them, in place of the three-call bull + bear + research-manager debate (agents/researchers/*, research_manager.js).
// Off by default; a backtest run turns it on so the two modes can be compared on the same ticker and window.
// The result is exactly a DebateVerdict (see MergedVerdict in schemas/index.js), so nothing downstream changes.

import { callStructured } from "../utils/structured.js";
import { MergedVerdict } from "../../schemas/index.js";
import { INDEPENDENCE_NOTE } from "./evidence.js";

export async function runMergedJudge(env, config, { ticker, asOf, opinions, priorLessons = "" }) {
  const prompt = `You are a research desk judge for ${ticker}. Using ONLY the analyst opinions below as evidence, \
first state the strongest bull case and the strongest bear case (each a short "argument" plus a one-sentence \
"justification"), then weigh them and produce a single verdict. You MUST include a top-level "justification" \
that explains which side was more convincing and why -- never omit it.

Respond as JSON only, matching exactly:
{ "bull": { "argument": string, "justification": string }, \
"bear": { "argument": string, "justification": string }, \
"direction": "long"|"short"|"flat", "confidence": number (0-1), \
"timeHorizon": "intraday"|"days"|"weeks"|"months", "justification": string }
${config.independenceNote === false ? "" : INDEPENDENCE_NOTE}

Analyst opinions:
${JSON.stringify(opinions, null, 2)}
${priorLessons ? `\n${priorLessons}\n\nWeigh these past outcomes, but do not let them override clear evidence in the current analyst opinions.` : ""}`;

  return callStructured(env, config, MergedVerdict, prompt, {
    model: config.geminiDeepModel,
    label: "debate:merged",
    extraFields: { ticker, asOf },
  });
}
