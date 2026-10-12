// Post-mortem: WHERE did each position's outcome come from? Pure, read-only analysis over data the run already stored
// (positions + the trade_decisions row that opened them). Nothing is written and nothing is migrated: tags are computed on
// read, so the rules can change later without a backfill and every old run can be analysed.
//
// Units: maePct / mfePct / stopLossPct are FRACTIONS (-0.05 = -5%), realizedReturn is a fraction NET of the run's cost
// (dashboard/data.js#getBacktestRunDetailData). Small samples: a run has tens of trades, so shares are hints, not proof.

export const TAGS = Object.freeze({
  WIN: "win",
  LOSS_STOP_PRE_EMPTED: "loss_stop_pre_empted", // the stop level was breached BEFORE a flip/replace closed it, which then filled worse
  LOSS_FLIP: "loss_flip", // closed by an opposite thesis at a loss
  LOSS_WRONG_FROM_START: "loss_wrong_from_start", // stopped out and never in meaningful profit
  LOSS_REVERSED: "loss_reversed", // was in profit (mfe >= MFE_PROFIT_FRACTION), then stopped out
  LOSS_TIME_EXIT: "loss_time_exit",
  LOSS_OTHER: "loss_other",
  OPEN: "open",
  NO_RETURN: "no_return", // closed but no computable return (no exit price)
});

/** An excursion of at least 0.5% in our favour counts as "was in profit". */
export const MFE_PROFIT_FRACTION = 0.005;

const PRICE_DIRECTION = { bullish: "long", bearish: "short" };

/** The analyst team's price-impact view of a stored opinions array: `{ direction: long|short|flat, relevance, channel }`. */
export function analystView(opinions) {
  const o = Array.isArray(opinions) ? opinions.find((x) => x?.agent === "price_impact") : null;
  if (!o) return { direction: "flat", relevance: null, channel: null };
  return { direction: PRICE_DIRECTION[o.priceDirection ?? o.direction] ?? "flat", relevance: o.relevance ?? null, channel: o.channel ?? null };
}

export function confidenceBucket(c) {
  if (!Number.isFinite(c)) return "unknown";
  if (c >= 0.8) return "0.8+";
  if (c >= 0.7) return "0.7-0.8";
  return "<0.7";
}

/** Which stage first "called" the direction that lost: the analyst, else the debate, else the trader. */
function blameStage(analyst, debateDir, thesisDir) {
  if (!thesisDir || thesisDir === "flat") return "unknown";
  if (analyst === thesisDir) return "analyst"; // the analyst already pointed that way; the rest followed
  if (debateDir === thesisDir) return "debate"; // the debate overrode a neutral/opposite analyst
  return "trader"; // debate and analyst did not point that way
}

/**
 * Tags ONE position (shape of RunStore#listPositionsWithDecisions + `realizedReturn`).
 * Returns `{ tag, stage, analystDirection, debateDirection, thesisDirection, relevance, confidence, confidenceBucket, ret, closeReason, note }`.
 * `stage` is only set for losses (who to blame); wins carry null.
 */
export function classifyPosition(p) {
  const d = p.decision ?? {};
  const view = analystView(d.opinions);
  const debateDir = d.debate?.direction ?? null;
  const thesisDir = d.thesis?.direction ?? p.direction ?? null;
  const confidence = d.debate?.confidence ?? null;
  const base = {
    id: p.id,
    ticker: p.ticker,
    direction: p.direction,
    openedAt: p.openedAt,
    closedAt: p.closedAt ?? null,
    closeReason: p.closeReason ?? null,
    ret: p.realizedReturn ?? null,
    analystDirection: view.direction,
    debateDirection: debateDir,
    thesisDirection: thesisDir,
    relevance: view.relevance,
    confidence,
    confidenceBucket: confidenceBucket(confidence),
    stage: null,
    note: "",
  };

  if (p.closedAt == null) return { ...base, tag: TAGS.OPEN, note: "still open" };
  if (p.realizedReturn == null) return { ...base, tag: TAGS.NO_RETURN, note: "no exit price, so no return" };
  if (p.realizedReturn > 0) return { ...base, tag: TAGS.WIN, note: `closed by ${p.closeReason ?? "?"}` };

  const stage = blameStage(view.direction, debateDir, thesisDir);
  const flipLike = p.closeReason === "flipped" || p.closeReason === "replaced";
  const stopBreached = Number.isFinite(p.stopLossPct) && p.stopLossPct > 0 && Number.isFinite(p.maePct) && p.maePct <= -p.stopLossPct;

  if (flipLike && stopBreached) {
    return { ...base, tag: TAGS.LOSS_STOP_PRE_EMPTED, stage, note: `stop (${pct(p.stopLossPct)}) was breached (worst ${pct(p.maePct)}) before the ${p.closeReason} closed it at ${pct(p.realizedReturn)}` };
  }
  if (flipLike) return { ...base, tag: TAGS.LOSS_FLIP, stage, note: `${p.closeReason} by an opposite thesis at ${pct(p.realizedReturn)}` };
  if (p.closeReason === "stop_loss") {
    return (p.mfePct ?? 0) >= MFE_PROFIT_FRACTION
      ? { ...base, tag: TAGS.LOSS_REVERSED, stage, note: `was +${pct(p.mfePct)} in profit, then stopped out` }
      : { ...base, tag: TAGS.LOSS_WRONG_FROM_START, stage, note: "stopped out, never meaningfully in profit" };
  }
  if (p.closeReason === "time_based") return { ...base, tag: TAGS.LOSS_TIME_EXIT, stage, note: "hold limit reached at a loss" };
  return { ...base, tag: TAGS.LOSS_OTHER, stage, note: `closed by ${p.closeReason ?? "?"} at ${pct(p.realizedReturn)}` };
}

function pct(x) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : "?";
}

/** `[{ key, n, wins, winRate, avgReturn, sumReturn }]`, worst total return first. Only rows with a return count. */
export function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.ret)) continue;
    const key = keyFn(r) ?? "unknown";
    const g = groups.get(key) ?? { key, n: 0, wins: 0, sumReturn: 0 };
    g.n += 1;
    g.wins += r.ret > 0 ? 1 : 0;
    g.sumReturn += r.ret;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, winRate: g.n ? g.wins / g.n : 0, avgReturn: g.n ? g.sumReturn / g.n : 0 }))
    .sort((a, b) => a.sumReturn - b.sumReturn);
}

/** Run-level post-mortem over `positions` (listPositionsWithDecisions output + realizedReturn). */
export function summarizePositions(positions) {
  const tagged = positions.map(classifyPosition);
  const scored = tagged.filter((t) => Number.isFinite(t.ret));
  const losses = scored.filter((t) => t.ret <= 0);
  return {
    positions: tagged,
    n: tagged.length,
    open: tagged.filter((t) => t.tag === TAGS.OPEN).length,
    scored: scored.length,
    winRate: scored.length ? scored.filter((t) => t.ret > 0).length / scored.length : null,
    sumReturn: scored.reduce((s, t) => s + t.ret, 0),
    byTag: groupBy(scored, (t) => t.tag),
    byLossStage: groupBy(losses, (t) => t.stage),
    byCloseReason: groupBy(scored, (t) => t.closeReason),
    byRelevance: groupBy(scored, (t) => t.relevance),
    byConfidence: groupBy(scored, (t) => t.confidenceBucket),
    // Every stage pointed the same way on every scored trade -> the debate added no independent signal on the trades that opened.
    stagesAlwaysAgreed: scored.length > 0 && scored.every((t) => t.analystDirection === t.debateDirection && t.debateDirection === t.thesisDirection),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Phase 2: missed opportunities. For a decision that did NOT open a position (held / rejected) but carried a long/short
// thesis: what would the price have done next? Looks AHEAD of the decision on purpose -- this is a post-hoc audit, never an
// input to a run. Conservative: a bar touching both the stop and the target counts as stop-first.
// ---------------------------------------------------------------------------------------------------------------------

export const MISSED_DEFAULTS = Object.freeze({ horizonMs: 72 * 3600 * 1000, stopPct: 0.04, takeProfitMultiple: 2 });

/**
 * @param decision `{ asOf, thesis:{direction}, riskDecision?:{stopLossPct,takeProfitPct} }`
 * @param bars ascending `[{ tsMs, open, high, low }]` for the decision's ticker
 * @returns `{ outcome: missed_winner|good_skip|inconclusive|no_data, entry, forwardMovePct, hoursToHit }`
 */
export function classifyMissed(decision, bars, opts = {}) {
  const { horizonMs, stopPct: defStop, takeProfitMultiple } = { ...MISSED_DEFAULTS, ...opts };
  const dir = decision.thesis?.direction;
  const asOfMs = Date.parse(decision.asOf);
  if ((dir !== "long" && dir !== "short") || !Number.isFinite(asOfMs)) return { outcome: "no_data" };
  let i = lowerBound(bars, asOfMs);
  if (i >= bars.length) return { outcome: "no_data" };
  const entry = bars[i].open;
  if (!Number.isFinite(entry) || entry <= 0) return { outcome: "no_data" };
  const stopPct = decision.riskDecision?.stopLossPct > 0 ? decision.riskDecision.stopLossPct : defStop;
  const tpPct = decision.riskDecision?.takeProfitPct > 0 ? decision.riskDecision.takeProfitPct : stopPct * takeProfitMultiple;
  const stopPx = dir === "long" ? entry * (1 - stopPct) : entry * (1 + stopPct);
  const tpPx = dir === "long" ? entry * (1 + tpPct) : entry * (1 - tpPct);
  let best = 0;
  for (; i < bars.length && bars[i].tsMs <= asOfMs + horizonMs; i++) {
    const b = bars[i];
    const stopHit = dir === "long" ? b.low <= stopPx : b.high >= stopPx;
    const tpHit = dir === "long" ? b.high >= tpPx : b.low <= tpPx;
    const hours = (b.tsMs - asOfMs) / 3600000;
    if (stopHit) return { outcome: "good_skip", entry, forwardMovePct: best, hoursToHit: hours };
    if (tpHit) return { outcome: "missed_winner", entry, forwardMovePct: tpPct, hoursToHit: hours };
    const fav = dir === "long" ? b.high / entry - 1 : 1 - b.low / entry;
    if (fav > best) best = fav;
  }
  return { outcome: "inconclusive", entry, forwardMovePct: best };
}

function lowerBound(bars, tsMs) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].tsMs < tsMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Tallies classifyMissed outcomes per decision status (held / rejected) and overall. */
export function summarizeMissed(items) {
  const out = { total: items.length, byStatus: {}, byOutcome: {} };
  for (const it of items) {
    out.byOutcome[it.outcome] = (out.byOutcome[it.outcome] ?? 0) + 1;
    const s = (out.byStatus[it.status] ??= {});
    s[it.outcome] = (s[it.outcome] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Two runs on the same window (e.g. merged verdict vs the normal debate): did they decide the same thing?
// ---------------------------------------------------------------------------------------------------------------------

/** `decisions`: `[{ id, status, direction, confidence }]` per run. Matches on the decision id (`ticker|asOf`). */
export function compareDecisions(a, b) {
  const byId = new Map(b.map((d) => [d.id, d]));
  let both = 0;
  let sameDirection = 0;
  let sameStatus = 0;
  let confDiffSum = 0;
  let confN = 0;
  for (const d of a) {
    const o = byId.get(d.id);
    if (!o) continue;
    both += 1;
    if (d.direction != null && d.direction === o.direction) sameDirection += 1;
    if (d.status === o.status) sameStatus += 1;
    if (Number.isFinite(d.confidence) && Number.isFinite(o.confidence)) {
      confDiffSum += o.confidence - d.confidence;
      confN += 1;
    }
  }
  return {
    aDecisions: a.length,
    bDecisions: b.length,
    matched: both,
    sameDirection,
    sameStatus,
    directionAgreement: both ? sameDirection / both : null,
    statusAgreement: both ? sameStatus / both : null,
    avgConfidenceDeltaBMinusA: confN ? confDiffSum / confN : null,
  };
}
