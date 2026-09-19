// SimClock -- plan.md's "Engine ports" section: "Backtest: SimClock (end
// clamped to real now, throws on a future time)". A backtest walks
// day-by-day through a REQUESTED window (testStart..testEnd+graceDays), but
// that window is caller-supplied (POST /backtest/run's query params) and
// nothing before this stopped a caller from asking for a window that runs
// past the actual present moment -- there is no future news/price data to
// read, so a backtest Worker that just walked ahead anyway would either
// silently produce a window of empty (no-signal) days, or -- worse --
// contend with data that arrives *while* the backtest is running and
// wrongly treat it as pre-existing "historical" input.
//
// TWO DIFFERENT FAILURE MODES ON PURPOSE, matching plan.md's phrasing:
//   - an EXPLICIT request for a future time is a caller mistake and should
//     fail loudly (assertNotFuture throws) -- silently reinterpreting it
//     would hide a real bug in whatever queued the backtest.
//   - a COMPUTED end (e.g. testEnd + graceDays rolling past "now" because
//     the grace period's own arithmetic, not the caller, pushed it there)
//     is clamped instead (clampEnd) -- the caller asked for something
//     reasonable and the grace period is what overshot, not the request.
//
// `now` is captured ONCE per SimClock instance (real Date.now() at
// construction, or an injected ISO string for tests/replay), not re-read on
// every call -- so a single backtest run's clamp/assert decisions all agree
// with each other even if the run itself takes real wall-clock time to
// finish, and a test can hand this a fixed `now` without needing fake
// timers or mocking the global Date.
//
// NOT YET WIRED IN: this module is self-contained and unused by the runner
// as of this commit (see plan.md M3 -- the runner rewrite is a separate,
// later piece). It exists standalone here so it can be reviewed and tested
// on its own before onSignalRunner.js/runBacktest.js are changed to
// construct one per run and pass it through.
export class SimClock {
  constructor(nowIso = new Date().toISOString()) {
    if (Number.isNaN(Date.parse(nowIso))) {
      throw new Error(`SimClock: invalid now value ${JSON.stringify(nowIso)}`);
    }
    this.nowIso = nowIso;
  }

  /** The clock's fixed "now", as an ISO string -- same value for the life of this instance. */
  now() {
    return this.nowIso;
  }

  /**
   * Throws if `iso` is strictly after this clock's now. For values the
   * CALLER explicitly asked for (a request's testStart/testEnd), where
   * silently reinterpreting a future date would hide a caller mistake.
   * `label` names the field in the thrown message, so a route handler can
   * turn this straight into a useful 400.
   */
  assertNotFuture(iso, label = "time") {
    if (Date.parse(iso) > Date.parse(this.nowIso)) {
      throw new Error(`${label} (${iso}) is in the future relative to this clock's now (${this.nowIso})`);
    }
    return iso;
  }

  /**
   * Returns the earlier of `iso` and this clock's now. For values the
   * ENGINE computed itself (e.g. testEnd + graceDays), where overshooting
   * "now" is an expected, harmless consequence of the arithmetic, not a
   * caller mistake -- so it's silently pulled back in instead of thrown.
   */
  clampEnd(iso) {
    return Date.parse(iso) > Date.parse(this.nowIso) ? this.nowIso : iso;
  }
}

/** Convenience: a SimClock pinned to the real current moment (production use). */
export function realSimClock() {
  return new SimClock();
}
