// Values that more than one module has to agree on. Kept in one place because
// the last time two copies of a value existed (MAX_PORTFOLIO_RISK_PCT in both
// run_store.js and portfolio_manager.js) they had to be kept equal by hand.

// Portfolio-wide open-risk ceiling (fraction of the book). Still an untuned
// placeholder, but there is exactly one of it: portfolio_manager.js checks it
// in JS before a thesis is sent to commit, and RunStore#commitThesis re-checks
// it inside the atomic batch's SQL. If the two ever disagreed the SQL wins,
// so they must read the same number.
export const MAX_PORTFOLIO_RISK_PCT = 0.2;

// Hold/flip rule (RunStore#commitThesis, P3): a new thesis for a ticker that
// already has an open position only REPLACES it if it points the OTHER way
// with at least this confidence. Same direction never replaces (the open
// position is held, so its hold clock and stops are not reset), and a weaker
// opposite thesis is ignored too. Untuned placeholder, deliberately above
// risk.js's MIN_CONFIDENCE_TO_ACT (0.6): reversing costs two trades, so it
// should need more conviction than opening. config.flipMinConfidence
// (FLIP_MIN_CONFIDENCE) overrides it.
export const DEFAULT_FLIP_MIN_CONFIDENCE = 0.75;

// Transaction cost per SIDE (one entry or one exit), in basis points of the
// traded notional: commission + half spread + impact folded into one number.
// A round trip costs twice this, and a flip is two trades (the close and the
// new open). Untuned placeholder for liquid large caps / gold; before this
// every reported return was gross and replacement churn looked free.
// config.tradeCostBps (TRADE_COST_BPS) overrides it; 0 turns costs off.
// Consumers that are handed a config with no tradeCostBps (unit tests) charge
// nothing, so only config.js#loadConfig applies this default.
export const DEFAULT_TRADE_COST_BPS = 5;

// trade_decisions.status values. RunStore#commitThesis derives the first
// four in SQL; the pipeline writes 'rejected' and 'skipped_no_price_data'
// itself when no commit happens. The dashboard (M4) should import this rather
// than re-typing the strings. (The old pipeline wrote 'approved' where this
// writes 'opened'; the state tables started empty, so there are no legacy
// rows to reconcile. migrations/state/0001_init.sql's column comment still
// lists the old names -- it is an applied migration, so it is not edited.)
export const TRADE_DECISION_STATUS = Object.freeze({
  /** A position was opened for this thesis. */
  OPENED: "opened",
  /** Approved upstream but it would breach the portfolio ceiling, or risk/portfolio management said no. */
  REJECTED: "rejected",
  /** A newer position for the same ticker already existed, so this (older) thesis was not applied. */
  SUPERSEDED: "superseded",
  /** Approved, but there was no price bar to open/replace at, so nothing was executed. */
  SKIPPED_NO_PRICE_DATA: "skipped_no_price_data",
  /** Approved, but the ticker already has an open position that the hold/flip rule keeps (same direction, or a too-weak opposite thesis). */
  HELD: "held",
});
