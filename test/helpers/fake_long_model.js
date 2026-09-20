// A config.fakeModel that always votes a confident long thesis, so every news
// item runs the whole pipeline (risk/portfolio approve, a position opens) and a
// position close gets a reflection -- with zero real Gemini calls. Dispatches on
// schema identity (AnalystOpinion/DebateSide/DebateVerdict/TradeThesis), plus a
// prompt check for reflection.js's Reflection schema, which is never exported
// (its prompt text "A trade decision for ... has resolved" is unique enough).
// Same model test/backtest_on_signal_runner.test.js uses inline.
//
// `onCall(opts, prompt)` sees every call, so a test can assert on what a stage
// was actually shown (e.g. the technical analyst's snapshot).

import { AnalystOpinion, DebateSide, DebateVerdict, TradeThesis } from "../../src/schemas/index.js";

export function makeFakeLongModel({ onCall } = {}) {
  return async (prompt, opts) => {
    onCall?.(opts, prompt);
    if (prompt.startsWith("A trade decision for")) {
      return JSON.stringify({ reflection: "the long thesis played out as expected" });
    }
    if (opts.schema === AnalystOpinion) {
      if (opts.extraFields.agent === "news_event") return JSON.stringify({ eventType: "earnings_beat", entities: [], summary: "beat on EPS", justification: "guidance raised" });
      if (opts.extraFields.agent === "sentiment") return JSON.stringify({ sentiment: "positive", summary: "positive reaction", justification: "beat + raised guidance" });
      if (opts.extraFields.agent === "technical") return JSON.stringify({ summary: "flat", justification: "not enough bars for a real trend read" });
      throw new Error(`unexpected AnalystOpinion agent: ${opts.extraFields.agent}`);
    }
    if (opts.schema === DebateSide) {
      return opts.extraFields.stance === "bull"
        ? JSON.stringify({ argument: "earnings beat justifies a long position", justification: "fundamentals improved" })
        : JSON.stringify({ argument: "one beat doesn't confirm a trend", justification: "macro risk remains" });
    }
    if (opts.schema === DebateVerdict) return JSON.stringify({ direction: "long", confidence: 0.8, timeHorizon: "days", justification: "bull case outweighs bear case" });
    if (opts.schema === TradeThesis) return JSON.stringify({ instrument: "equity", rationale: "ride the post-earnings momentum" });
    throw new Error(`unexpected schema/prompt in test fake model: ${prompt.slice(0, 60)}`);
  };
}
