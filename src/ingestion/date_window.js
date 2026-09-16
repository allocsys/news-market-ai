// Point-in-time cutoff helpers, for use on the INGESTION side (e.g. an
// adapter deciding how far back to backfill, or filtering a vendor response
// to a window before writing it). Deliberately NOT a reimplementation --
// backtest/pointInTime.js already has assertNoLookahead() and
// walkForwardWindows(), and having two copies of "what counts as before a
// cutoff" is exactly the kind of drift plan.md's Backtesting Integrity
// section warns about. This file just re-exports them under the name an
// ingestion-side caller would look for, so both sides of the codebase read
// the same logic.
//
// If ingestion ever needs a helper backtest doesn't (e.g. "round asOf down
// to the nearest vendor poll interval"), add it here as a genuinely new
// function -- don't duplicate assertNoLookahead/walkForwardWindows.

export { assertNoLookahead, walkForwardWindows } from "../backtest/pointInTime.js";
