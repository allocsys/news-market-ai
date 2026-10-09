// Values that more than one module has to agree on. Kept in one place because
// the last time two copies of a value existed (MAX_PORTFOLIO_RISK_PCT in both
// run_store.js and portfolio_manager.js) they had to be kept equal by hand.

// Portfolio-wide open-risk ceiling (fraction of the book). Still an untuned
// placeholder, but there is exactly one of it: portfolio_manager.js checks it
// in JS before a thesis is sent to commit, and RunStore#commitThesis re-checks
// it inside the atomic batch's SQL. If the two ever disagreed the SQL wins,
// so they must read the same number.
export const MAX_PORTFOLIO_RISK_PCT = 0.5;

// Loss-at-stop ceiling (fraction of the book): the sum over open positions of
// position_size_pct * stop_loss_pct, i.e. what the book loses if every open
// position hits its stop. MAX_PORTFOLIO_RISK_PCT above only caps gross
// EXPOSURE (sizes summed), which treats a 5% position with a 1% stop and one
// with an 8% stop as equally risky. Both ceilings apply; this one is checked
// in portfolio_manager.js and, with the same number, in RunStore#commitThesis's
// SQL. A position with no stored stop is charged FALLBACK_STOP_LOSS_PCT.
// Untuned placeholder: 2% of the book (raised from 0.75% in #246 together with
// MAX_PORTFOLIO_RISK_PCT 0.5 and the XAUUSD 30% caps). 50% exposure at the 3%
// fallback stop implies ~1.5%, so with typical stops the exposure cap still
// binds first and this one only bites on wide-stop (volatile) books.
export const MAX_PORTFOLIO_STOP_RISK_PCT = 0.02;

// Stop-risk SCALING (portfolio_manager.js): when a thesis at its full size would breach the loss-at-stop ceiling above,
// the portfolio manager shrinks it to the size that fits the remaining budget instead of rejecting it (a wide ATR stop,
// e.g. BTCUSD at 30% size past ~6.7%, used to be rejected outright). STOP_RISK_SCALE_MARGIN is subtracted from the
// remaining budget before dividing by the stop, so the scaled size * stop stays strictly under the ceiling even after
// float rounding: RunStore#commitThesis re-checks `sum + size * stop <= MAX_PORTFOLIO_STOP_RISK_PCT` in SQL with no
// tolerance, and 0.2 * 0.1 is 0.020000000000000004 in JS. MIN_SCALED_POSITION_PCT is the smallest scaled size worth
// opening (1% of the book); below it the thesis is still rejected, so a nearly-full stop budget cannot produce dust
// positions. Untuned placeholders. Scaled sizes are rounded DOWN to 4 decimals (0.01% of the book).
export const STOP_RISK_SCALE_MARGIN = 1e-9;
export const MIN_SCALED_POSITION_PCT = 0.01;

// Stop distance used when a position has no stop_loss_pct, or risk.js has too
// few bars for an ATR (it is risk.js's flat fallback, and its take-profit
// fallback is twice this). One copy so risk.js, the portfolio manager and the
// SQL loss-at-stop sum agree.
export const FALLBACK_STOP_LOSS_PCT = 0.03;

// Concentration cap (portfolio_manager.js): tickers that move together are one
// bet, so the sum of open SAME-DIRECTION position sizes inside one group, plus
// the new thesis, may not exceed MAX_GROUP_EXPOSURE_PCT of the book. The two
// ceilings above only look at the whole book, so three correlated longs (AAPL,
// MSFT, TSLA) looked like three independent bets. A static map, not a computed
// correlation matrix: no extra price reads per decision (the backtest
// subrequest budget is tight), reproducible, and a 20-day correlation over five
// tickers is mostly noise. Known gap: it cannot see macro co-movement across
// groups (USO/XAUUSD in a risk-off move); the loss-at-stop ceiling bounds that.
// A ticker missing from the map is its own group, so it is never capped against
// other tickers. Both numbers are untuned placeholders: 10% allows two full 5%
// positions in one group, not a third.
export const TICKER_GROUPS = { AAPL: "equity", MSFT: "equity", TSLA: "equity", USO: "energy", XAUUSD: "gold", BTCUSD: "crypto" };
export const MAX_GROUP_EXPOSURE_PCT = 0.1;
// Float slack so a sum that is exactly the cap on paper (0.05 + 0.05) is never rejected by rounding. Used by
// portfolio_manager.js and by RunStore#commitThesis's SQL, so both sides apply the identical tolerance.
export const GROUP_CAP_EPSILON = 1e-9;

export function groupOfTicker(ticker) {
  return TICKER_GROUPS[ticker] ?? ticker;
}

// Per-group override of MAX_GROUP_EXPOSURE_PCT. XAUUSD is alone in "gold" and its book is one position at a time
// (hold/flip), so the 10% default acted as a hard per-position cap that kept it at ~3-4% of the book. Untuned
// placeholder, raised together with MAX_POSITION_PCT_BY_TICKER below: the group cap REJECTS (it does not clamp),
// so a size above it would never trade. A group not listed uses MAX_GROUP_EXPOSURE_PCT.
// BTCUSD is alone in "crypto" and gets the same 30% as gold (BTC-only experiment, same reasoning: one position at a time).
export const GROUP_EXPOSURE_CAP_BY_GROUP = { gold: 0.3, crypto: 0.3 };

export function groupCapOf(groupId) {
  return GROUP_EXPOSURE_CAP_BY_GROUP[groupId] ?? MAX_GROUP_EXPOSURE_PCT;
}

// Per-ticker override of the position-size multiplier in risk_mgmt/risk.js (size = confidence * cap, capped at
// cap). A ticker not listed uses risk.js's default (5%). Untuned placeholder: XAU moves slowly, sits in one
// position at a time, and its stop is ~2.5-3.5%, so a full stop-out at 30% is ~1% of the book, inside
// MAX_PORTFOLIO_STOP_RISK_PCT (2%).
// BTCUSD 0.30 matches XAUUSD (experiment). BTC is far more volatile than gold, so its ATR stop is wider: a full
// stop-out at 30% is above 1% of the book and approaches MAX_PORTFOLIO_STOP_RISK_PCT (2%) once the stop passes ~6.7%.
export const MAX_POSITION_PCT_BY_TICKER = { XAUUSD: 0.3, BTCUSD: 0.3 };

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

// Stock-split guard (shared/split_guard.js): stored bars are RAW/unadjusted, so
// a split shows up as a price step that looks like a crash (or, for a reverse
// split, a surge). A position whose current/entry price ratio lands within this
// RELATIVE tolerance of a common split ratio (1/2, 1/3, ... or 2, 3, ...) is
// treated as split-suspected. Untuned placeholder: wide enough to absorb a
// few percent of market move on top of the split, narrow enough that a real
// large move rarely matches. config.splitGuardTolerance (SPLIT_GUARD_TOLERANCE)
// overrides it; 0 disables the guard.
export const DEFAULT_SPLIT_GUARD_TOLERANCE = 0.05;

// Drawdown circuit breaker (agents/managers/portfolio_manager.js): when the
// book's REALIZED P&L over the trailing window is at or below minus this
// fraction of the book, new entries are rejected until the window rolls past
// the losses or wins pull it back above the line. P&L = sum of
// position_size_pct * net realized return over positions closed in the window
// (storage/run_store.js#getRealizedPnlPctAsOf). Untuned placeholders: 2% of the
// book over 14 calendar days, i.e. roughly a dozen full stop-outs at 3%
// sizing. config.drawdownBreakerPct (DRAWDOWN_BREAKER_PCT) and
// config.drawdownBreakerWindowDays (DRAWDOWN_BREAKER_WINDOW_DAYS) override
// them; a pct of 0 disables the breaker.
export const DEFAULT_DRAWDOWN_BREAKER_PCT = 0.02;
export const DEFAULT_DRAWDOWN_BREAKER_WINDOW_DAYS = 14;

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
  /** Approved, but the entry price was stale (off-hours/holiday): waiting to fill at the next session bar's open. No position yet. */
  PENDING_ENTRY: "pending_entry",
  /** A pending_entry that no bar filled before its fill_expires_at, so nothing was executed. */
  SKIPPED_NO_FILL: "skipped_no_fill",
  /** The analyst call judged the article has no plausible effect on this ticker's price, so the run ended before the debate (no debate, trader or position). */
  SKIPPED_IRRELEVANT: "skipped_irrelevant",
});
