// A config.fakeModel that always votes a confident long thesis, so every news
// item runs the whole pipeline (risk/portfolio approve, a position opens) and a
// position close gets a reflection -- with zero real Gemini calls. Dispatches on
// schema identity (AnalystTeamOpinion/DebateSide/DebateVerdict/TradeThesis), plus
// a prompt check for reflection.js's Reflection schema, which is never exported
// (its prompt text "A trade decision for ... has resolved" is unique enough).
// Same model test/backtest_on_signal_runner.test.js uses inline.
//
// The 3 analysts (news_event/sentiment/technical) are now ONE batched call
// against AnalystTeamOpinion (see analystTeam.js) -- this returns all 3
// sections in a single response instead of dispatching per-agent. `technical`
// is included whenever bars produced a snapshot; analystTeam.js itself omits
// asking for it (and drops the key) when there's no bar data, so a fixed fake
// answer here is fine either way -- the caller only reads the keys it asked for.
//
// `onCall(opts, prompt)` sees every call, so a test can assert on what a stage
// was actually shown (e.g. the combined prompt's technical snapshot section).

import { AnalystTeamOpinion, DebateSide, DebateVerdict, TradeThesis } from "../../src/schemas/index.js";

export function makeFakeLongModel({ onCall } = {}) {
  return async (prompt, opts) => {
    onCall?.(opts, prompt);
    if (prompt.startsWith("A trade decision for")) {
      return JSON.stringify({ reflection: "the long thesis played out as expected" });
    }
    if (opts.schema === AnalystTeamOpinion) {
      return JSON.stringify({
        news_event: { eventType: "earnings_beat", entities: [], summary: "beat on EPS", justification: "guidance raised" },
        sentiment: { sentiment: "positive", summary: "positive reaction", justification: "beat + raised guidance" },
        technical: { summary: "flat", justification: "not enough bars for a real trend read" },
      });
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
