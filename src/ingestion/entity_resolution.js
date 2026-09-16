// Deterministic entity/ticker resolution (plan.md Adopted Pattern #10):
// resolve which ticker a news item is about via a lookup step BEFORE any
// agent sees the item -- never let an LLM infer the ticker, which is
// exactly the class of "analyzed the wrong company" bug this pattern exists
// to avoid.
//
// HONEST SCOPE, v1: ingestion currently queries GDELT per-ticker (see
// gdelt.js), so the searched-for ticker itself (`hintTicker`) is already a
// reliable, fully deterministic signal -- that's why it's always included
// with no lookup needed. COMPANY_DOMAIN_MAP below is a small, hand-
// maintained supplement for picking up a SECOND company mentioned in the
// same article (e.g. a supplier, an acquisition target). It is NOT a
// general entity-extraction system -- expand it as real false-negatives
// show up in practice; do not replace it with LLM inference, which would
// defeat the point of this pattern.
const COMPANY_DOMAIN_MAP = {
  "apple.com": "AAPL",
  "microsoft.com": "MSFT",
  "tesla.com": "TSLA",
};

/**
 * @param title article title -- currently unused by v1, kept in the
 *   signature so a future keyword-based match doesn't require call-site
 *   changes across ingestion adapters
 * @param domain the publishing domain GDELT reports for the article
 * @param hintTicker the ticker we already searched GDELT for, if any
 * @returns deterministic array of tickers, always including hintTicker
 */
export function resolveTickers({ title, domain, hintTicker } = {}) {
  const tickers = new Set();
  if (hintTicker) tickers.add(hintTicker);

  const mapped = COMPANY_DOMAIN_MAP[domain];
  if (mapped) tickers.add(mapped);

  return [...tickers];
}
