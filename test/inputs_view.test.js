// Smoke test only -- inputs_view.js physically holds the inputs read/write
// functions since M2 (moved verbatim out of storage/d1.js); their behavior is
// covered by fundamentals_pointintime.test.js, price_bars_pointintime.test.js
// and the ingestion tests. This just proves the module exposes the full
// surface.

import test from "node:test";
import assert from "node:assert/strict";
import * as inputsView from "../src/storage/inputs_view.js";

test("inputs_view exposes the full inputs read/write surface", () => {
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
