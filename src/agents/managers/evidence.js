// Evidence record for the debate verdict (fix #1: confidence has no usable relationship to outcome).
//
// WHY: the judge's confidence was an unconstrained number. Every analyst reads the SAME article and the SAME price
// snapshot, so "all analysts agree" is ONE piece of evidence repeated, yet it pushed confidence up (the >=0.85 bucket
// was the worst: 7 trades, 1 win, avg -3.0%). This module records, per decision, the features that are independent of
// that agreement, so confidence can be checked against realized outcomes (analysis/postmortem.js groups by them).
//
// NOT used to change confidence, size or entries: on the 51 distinct closed backtest trades the obvious candidate
// (price-impact relevance) pointed the wrong way (direct: 9/25 wins, avg -1.11%; indirect: 13/26, avg +0.07%), and
// 'with the trend' entries did no better than counter-trend ones. A weighting fitted on that would be a guess.
// The record exists so a fit can be made on real data after a few more runs.
//
// Pure: no DB, no LLM. Never throws on missing input -- an absent feature is null/"unknown", never a guess.

/**
 * 'with' | 'against' | 'mixed' | 'unknown': does the market, as the technical snapshot shows it at decision time,
 * lean the same way as `direction`? Price vs SMA and the recent price change must both be known; both agreeing is
 * 'with', both opposing is 'against', a split is 'mixed'. Uses the current price when the snapshot has one.
 */
export function technicalAlignment(snapshot, direction) {
  if (!snapshot?.hasData || (direction !== "long" && direction !== "short")) return "unknown";
  const price = snapshot.currentPrice ?? snapshot.latestClose;
  const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);
  if (!Number.isFinite(price) || !Number.isFinite(snapshot.sma) || !Number.isFinite(snapshot.priceChangePct)) return "unknown";
  const want = direction === "long" ? 1 : -1;
  const votes = [sign(price - snapshot.sma), sign(snapshot.priceChangePct)].map((s) => s * want);
  if (votes.every((v) => v > 0)) return "with";
  if (votes.every((v) => v < 0)) return "against";
  return "mixed";
}

/** Analysts that took a side, and how many of them lean the verdict's way. Diagnostic only: agreement is not evidence. */
function analystLean(opinions, direction) {
  const impact = (opinions ?? []).find((o) => o?.agent === "price_impact");
  const impactDir = { bullish: "long", bearish: "short", neutral: "flat" }[impact?.priceDirection ?? impact?.direction] ?? null;
  const sentiment = (opinions ?? []).find((o) => o?.agent === "sentiment")?.sentiment;
  const sentDir = typeof sentiment === "string" ? (/positive|bull/i.test(sentiment) ? "long" : /negative|bear/i.test(sentiment) ? "short" : "flat") : null;
  const sides = [impactDir, sentDir].filter((d) => d === "long" || d === "short");
  return { analystsWithSide: sides.length, analystsAgreeing: sides.filter((d) => d === direction).length };
}

/**
 * The record stored next to the verdict (decision.debate.evidence). `rawConfidence` is the judge's own number, kept
 * so a later calibration can be fitted against it even if confidence is ever changed downstream.
 */
export function collectEvidence({ verdict, opinions, snapshot }) {
  const impact = (opinions ?? []).find((o) => o?.agent === "price_impact");
  return {
    rawConfidence: verdict?.confidence ?? null,
    relevance: impact?.relevance ?? null,
    technicalAlignment: technicalAlignment(snapshot, verdict?.direction),
    currentPriceUsed: snapshot?.currentPrice != null,
    currentVsLatestClosePct: snapshot?.currentVsLatestClosePct ?? null,
    macroContext: Boolean(opinions?.some?.((o) => o?.agent === "macro")),
    ...analystLean(opinions, verdict?.direction),
  };
}

/** Shared by both judge prompts: agreement among the analysts is one source, not several. Empty when the guard is off. */
export const INDEPENDENCE_NOTE = `

EVIDENCE RULE for "confidence": the analysts all read the SAME article and the SAME price snapshot, so their \
agreement counts as ONE piece of evidence, not several. Do not raise confidence because the analysts agree, or \
because the bear case is weak or missing -- a missing counter-case is not support. Base confidence only on evidence \
that does not just repeat the article: the price context given at decision time (is the price already past the move?) \
and how directly the article bears on this asset's price. When the only support is the article itself, stay below 0.8.`;
