// GDELT DOC 2.0 API adapter -- STUB, not yet implemented.
//
// Why GDELT first (see plan.md): free, returns JSON natively, updates every
// 15 minutes, and archives back to 2015 with real timestamps -- currently
// our strongest free source for point-in-time backtesting.
//
// Next step: implement fetchLatest() against
// https://api.gdeltproject.org/api/v2/doc/doc, map each result through
// buildNormalizedItem() (../normalize.js), and resolve tickers via a
// deterministic entity-resolution step (plan.md Adopted Pattern #10) rather
// than trusting GDELT's own entity tagging blindly.

const GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc";

export async function fetchLatest(/* { query, maxRecords = 50 } = {} */) {
  throw new Error("gdelt.fetchLatest: not yet implemented -- see plan.md next steps");
}
