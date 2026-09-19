// Smoke test only -- inputs_view.js re-exports storage/d1.js's existing
// (unchanged-schema) input readers/writers verbatim; their own behavior is
// already covered by the pre-existing d1.js-facing tests
// (fundamentals_pointintime.test.js, price_bars_pointintime.test.js, etc).
// This just proves the new import path actually exposes them.

import test from "node:test";
import assert from "node:assert/strict";
import * as inputsView from "../src/storage/inputs_view.js";

test("inputs_view re-exports the full inputs read/write surface", () => {
  for (const fn of [
    "insertNewsItem",
    "getNewsAsOf",
    "getNewsItemsInRange",
    "insertPriceBar",
    "getPriceBarsAsOf",
    "insertFundamentalFact",
    "insertFundamentalFacts",
    "getFundamentalFactsAsOf",
  ]) {
    assert.equal(typeof inputsView[fn], "function", `expected inputs_view.${fn} to be a function`);
  }
});
