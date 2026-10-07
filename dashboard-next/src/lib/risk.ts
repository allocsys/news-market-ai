// Portfolio risk ceilings as the pipeline enforces them. The backend sends these
// with /api/overview, /api/snapshot and /api/positions (src/dashboard/data.js
// getRiskLimits, read from shared/constants.js), so the dashboard never keeps
// its own copy. All values are FRACTIONS of the book (0.2 = 20%), like fmtPct expects.
//
// NOTE: `totalExposurePct` in those responses is in PERCENT units (12.3 = 12.3%),
// so divide by 100 before comparing it with these or passing it to fmtPct.

export interface RiskLimits {
  maxPortfolioRiskPct: number;
  maxPortfolioStopRiskPct: number;
  /** Default same-direction cap per group. */
  maxGroupExposurePct: number;
  /** Per-group overrides (group -> cap); a group not listed uses maxGroupExposurePct. */
  groupCaps: Record<string, number>;
  /** ticker -> group; a ticker not listed is its own group. */
  tickerGroups: Record<string, string>;
  fallbackStopLossPct: number;
}

// Only used when the backend is older than this dashboard and sends no riskLimits
// (Worker and backend deploy separately). Mirrors the shared/constants.js defaults;
// it has no per-group overrides, so group caps can be understated until the backend catches up.
const FALLBACK_RISK_LIMITS: RiskLimits = {
  maxPortfolioRiskPct: 0.2,
  maxPortfolioStopRiskPct: 0.0075,
  maxGroupExposurePct: 0.1,
  groupCaps: {},
  tickerGroups: {},
  fallbackStopLossPct: 0.03,
};

export function resolveRiskLimits(limits: RiskLimits | null | undefined): RiskLimits {
  return limits ?? FALLBACK_RISK_LIMITS;
}

/** Exposure from the API (percent units) as a fraction of the book. */
export function exposureFraction(totalExposurePct: number | null | undefined): number {
  return (totalExposurePct ?? 0) / 100;
}

/** Same-direction cap that applies to a ticker (its group's override, else the default). */
export function groupCapOf(limits: RiskLimits, ticker: string): number {
  const group = limits.tickerGroups[ticker] ?? ticker;
  return limits.groupCaps[group] ?? limits.maxGroupExposurePct;
}

/** Short "gold 15%, energy 8%" text for groups whose cap differs from the default, or null. */
export function describeGroupCapOverrides(limits: RiskLimits): string | null {
  const parts = Object.entries(limits.groupCaps)
    .filter(([, cap]) => cap !== limits.maxGroupExposurePct)
    .map(([group, cap]) => `${group} ${Math.round(cap * 1000) / 10}%`);
  return parts.length ? parts.join(", ") : null;
}
