# Pre-live rollout

Stages, in order: **backtest -> paper -> micro-size live**.

All numeric thresholds below are PROPOSED starting values. They are not tuned. The owner confirms or edits them in this PR. Once a stage starts, its criteria are frozen (see "Rules").

## Rules

1. Failure criteria for a stage are written down BEFORE the stage starts. Changing them mid-stage restarts the stage.
2. A stage is judged only on metrics listed here. No new metric may be used to rescue a failing stage.
3. Advancing requires the owner's explicit approval, recorded in the PR or the log.
4. Any abort drops back exactly one stage and restarts that stage's sample/duration clock.
5. Tuning the knobs (see "Tuning") happens in backtest only, never mid paper or live.

## Metrics

| Metric | Source | Notes |
|---|---|---|
| Net return after costs | closed positions | after `TRADE_COST_BPS` (5 bps/side) |
| Max drawdown | equity curve | compared with the breaker level |
| Drawdown-breaker trips | breaker events | `DRAWDOWN_BREAKER_PCT` 0.02 over `WINDOW_DAYS` 14 |
| MAE / MFE distribution | `positions.mae_pct`, `positions.mfe_pct` | how far trades go against / for us before exit |
| Split-guard hits | split guard events | `SPLIT_GUARD_TOLERANCE` 0.05 |
| Win rate, avg hold (trading days) | closed positions | context only, not a gate |

## Pass test for net return

"Net return > 0" below means the LOWER BOUND is above zero: mean net return per trade minus 1.645 x standard error (one-sided 95%, PROPOSED) is > 0. A positive average alone does not pass. This ties the pass rule to the sample size, so a lucky small sample cannot advance a stage.

For reference, the live DB opened 57 positions in its first ~8 days (Sep 19-26, peak ~16/day), so the sample sizes below are reachable in weeks, not years.

## Stage 1: Backtest

Purpose: pick knob values and confirm the strategy has positive net expectancy.

- Sample: at least 500 closed trades AND at least 3 months of data covering different market conditions (PROPOSED).
- Pass to paper when ALL hold:
  - net return after costs > 0 (lower bound, see above) over the full window;
  - net return > 0 in each half of the window (no single-period dependence);
  - max drawdown < 2x the breaker level;
  - breaker trips <= 2 over the window;
  - median MFE > median |MAE| (winners run further than losers hurt);
  - split-guard hits are explained (each hit is a real split or a data error that was fixed).
- Fail: any criterion above missed. Stay in backtest; change the strategy or knobs and rerun. Do not advance on a "close enough".

## Stage 2: Paper (what runs today)

Purpose: confirm live data, timing and execution logic behave as in backtest.

- Minimum: at least 200 closed trades AND at least 4 weeks (PROPOSED).
- Advance to micro-live when ALL hold:
  - net return after costs > 0 (lower bound, see above);
  - realised results are not worse than the backtest by more than a set margin: net return per trade at least 50% of the backtest figure (PROPOSED);
  - breaker trips <= 1;
  - no unexplained split-guard hit and no open bug in the exit or settle path;
  - MAE distribution is no worse than backtest at the 90th percentile.
- Abort (back to backtest) if ANY hold:
  - max drawdown hits 2x the breaker level;
  - breaker trips >= 3;
  - net return after costs < 0 after the minimum sample;
  - a data or accounting bug means paper P&L cannot be trusted (restart the clock after the fix).

## Stage 3: Micro-size live

Purpose: confirm real fills and real costs, with capital at risk small enough to lose.

- Size: a fixed small amount chosen by the owner (a number is set before this stage starts; not in this doc).
- Minimum: at least 100 closed trades AND at least 4 weeks (PROPOSED).
- Hard stop: cumulative loss reaches the owner's pre-set loss limit, or the drawdown breaker trips twice in a window. Trading stops and the stage drops back to paper.
- Pass (eligible for scaling, a separate decision) when ALL hold:
  - net return after costs > 0 (lower bound, see above), using ACTUAL costs;
  - actual cost per side is within 2x `TRADE_COST_BPS`; if it is not, re-run the backtest with the real cost before anything else;
  - no manual intervention was needed on any position;
  - metrics match paper within the margin used above.
- Scaling up is out of scope here and needs its own criteria written first.

## Tuning

Done in backtest, before Stage 1 is judged, on knobs currently untuned:

1. `FLIP_MIN_CONFIDENCE`
2. `DRAWDOWN_BREAKER_PCT` and `WINDOW_DAYS`
3. `SPLIT_GUARD_TOLERANCE`
4. `TRADE_COST_BPS`

Guard against overfitting: choose values on the first half of the data, confirm on the second half, and prefer values in a flat region of the results over the single best point. Record the final values and the runs that justified them.

## Code gate

Not built. Stage advancement is a manual, owner-approved decision. If wanted later, a gate could refuse to start live-size runs unless a stage-approval flag is set in config.

## Open decisions for the owner

- Confirm or change every PROPOSED number above.
- Micro-live size and hard-stop loss limit (must be set before Stage 3).
- Whether a code gate is wanted.
