// Values that more than one module has to agree on. Kept in one place because
// the last time two copies of a value existed (MAX_PORTFOLIO_RISK_PCT in both
// run_store.js and portfolio_manager.js) they had to be kept equal by hand.

// Portfolio-wide open-risk ceiling (fraction of the book). Still an untuned
// placeholder, but there is exactly one of it: portfolio_manager.js checks it
// in JS before a thesis is sent to commit, and RunStore#commitThesis re-checks
// it inside the atomic batch's SQL. If the two ever disagreed the SQL wins,
// so they must read the same number.
export const MAX_PORTFOLIO_RISK_PCT = 0.2;

// trade_decisions.status values. RunStore#commitThesis derives the first
// three in SQL; the pipeline writes 'rejected' and 'skipped_no_price_data'
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
});
