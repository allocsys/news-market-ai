// Routing logic for the pipeline graph -- currently just the one decision
// TradingAgents' conditional_logic.py also makes: should the Bull/Bear
// debate run another round, or is the verdict good enough to hand to the
// trader? Kept separate from graph/pipeline.js so the "when to stop
// debating" policy can change without touching the stage-wiring code.

// Separate from risk_mgmt/risk.js's MIN_CONFIDENCE_TO_ACT on purpose: that
// one gates whether to ACT on a verdict, this one gates whether the verdict
// is worth trusting enough to stop debating. They happen to be reasonable
// at the same value today but are conceptually different knobs and may
// diverge later.
const MIN_CONFIDENCE_TO_STOP_DEBATE = 0.6;

/**
 * @param verdict DebateVerdict from the current round (agents/managers/research_manager.js)
 * @param roundsSoFar how many bull/bear/judge rounds have already run (starts at 1 after the first)
 * @param config loadConfig(env) output, for maxDebateRounds
 * @returns true if another debate round should run, false to proceed to the trader
 */
export function shouldContinueDebate(verdict, roundsSoFar, config) {
  if (roundsSoFar >= config.maxDebateRounds) return false;
  return verdict.confidence < MIN_CONFIDENCE_TO_STOP_DEBATE;
}
