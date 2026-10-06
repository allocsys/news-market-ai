// Covers dashboard/ticker_picker.js and the four forms that use it (backtest
// trigger, news-replay trigger, price backfill, LLM-calls filter): tap-to-choose
// from the watchlist instead of typing a symbol, with each form falling back to
// its old text field when the option list is empty. Plus backend's GET
// /api/watchlist, the option list's source. (The pages that embedded these
// forms were served by the old dashboard Worker, retired for dashboard-next.)

import test from "node:test";
import assert from "node:assert/strict";
import backendWorker from "../src/index.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR } from "./helpers/engine_ctx.js";
import { parseTickerList, tickersFromParams, tickerChecklist, tickerSelect } from "../src/dashboard/ticker_picker.js";
import { backtestTriggerForm } from "../src/dashboard/views/backtest.js";
import { replayTriggerForm } from "../src/dashboard/views/replay.js";
import { priceBackfillTriggerForm } from "../src/dashboard/views/backfill.js";

// --------------------------------------------------------------------
// ticker_picker.js
// --------------------------------------------------------------------

test("parseTickerList merges repeated values and comma lists, upper-cases, dedupes and drops blanks", () => {
  assert.deepEqual(parseTickerList(["aapl, msft", "MSFT", "", " xauusd "]), ["AAPL", "MSFT", "XAUUSD"]);
  assert.deepEqual(parseTickerList(undefined), []);
});

test("tickersFromParams reads repeated and comma-separated params, null when nothing is given", () => {
  assert.equal(tickersFromParams(new URLSearchParams("tickers=AAPL&tickers=MSFT")), "AAPL,MSFT");
  assert.equal(tickersFromParams(new URLSearchParams("tickers=aapl,msft")), "AAPL,MSFT");
  assert.equal(tickersFromParams(new URLSearchParams("tickers=")), null);
  assert.equal(tickersFromParams(new URLSearchParams("")), null);
});

test("tickerChecklist renders one checkbox per option: shared name, unique ids, chosen ones checked, values escaped", () => {
  const html = tickerChecklist({ name: "tickers", idPrefix: "t", options: ["AAPL", "MSFT"], selected: ["MSFT"] });
  assert.match(html, /<input type="checkbox" id="t-AAPL" name="tickers" value="AAPL">/);
  assert.match(html, /<input type="checkbox" id="t-MSFT" name="tickers" value="MSFT" checked>/);
  const hostile = tickerChecklist({ name: "tickers", idPrefix: "t", options: ['<x">'] });
  assert.doesNotMatch(hostile, /<x">/);
});

test("tickerSelect: optional 'all' first, current value selected, an unknown deep-linked value is kept", () => {
  const html = tickerSelect({ name: "llmTicker", id: "x", options: ["AAPL", "MSFT"], selected: "msft", allLabel: "All tickers" });
  assert.match(html, /<select name="llmTicker" id="x"><option value="">All tickers<\/option>/);
  assert.match(html, /<option value="MSFT" selected>MSFT<\/option>/);

  const linked = tickerSelect({ name: "llmTicker", options: ["AAPL"], selected: "NVDA", allLabel: "All tickers" });
  assert.match(linked, /<option value="NVDA" selected>NVDA<\/option>/);
  assert.doesNotMatch(linked, /<option value="" selected>/);

  const none = tickerSelect({ name: "llmTicker", options: ["AAPL"], allLabel: "All tickers" });
  assert.match(none, /<option value="" selected>All tickers<\/option>/);
});

test("tickerSelect without allLabel has no empty option, and passes required through", () => {
  const html = tickerSelect({ name: "ticker", id: "replayTicker", options: ["AAPL", "MSFT"], required: true });
  assert.match(html, /<select name="ticker" id="replayTicker" required><option value="AAPL">AAPL<\/option>/);
});

// --------------------------------------------------------------------
// Forms: picker with a watchlist, text field without
// --------------------------------------------------------------------

test("trigger forms fall back to the text field when there is no watchlist to pick from", () => {
  assert.match(backtestTriggerForm(), /<input class="filter-form" id="backtestTickers" type="text" name="tickers"/);
  assert.match(backtestTriggerForm([]), /type="text" name="tickers"/);
  assert.match(replayTriggerForm(), /<input class="filter-form" id="replayTicker" type="text" name="ticker"/);
  assert.match(priceBackfillTriggerForm(), /<input class="filter-form" id="priceBackfillTickers" type="text" name="tickers"/);
});

test("trigger forms use pickers instead of text fields when given the watchlist", () => {
  const options = ["AAPL", "XAUUSD"];
  assert.doesNotMatch(backtestTriggerForm(options), /type="text" name="tickers"/);
  assert.match(backtestTriggerForm(options), /id="backtestTicker-XAUUSD"/);
  assert.doesNotMatch(priceBackfillTriggerForm(options), /type="text" name="tickers"/);
  assert.match(priceBackfillTriggerForm(options), /id="priceBackfillTicker-AAPL"/);
  assert.doesNotMatch(replayTriggerForm(options), /type="text" name="ticker"/);
  assert.match(replayTriggerForm(options), /<select name="ticker" id="replayTicker" required>/);
});

// --------------------------------------------------------------------
// GET /api/watchlist
// --------------------------------------------------------------------

function backendFor(extra = {}) {
  const backendEnv = {
    LIVE_DB: createTestD1([STATE_DIR]),
    INPUTS_DB: createTestD1([INPUTS_DIR]),
    SIM_DB: createTestD1([STATE_DIR, SIM_DIR]),
    WATCHLIST_TICKERS: "AAPL,MSFT,XAUUSD",
    ...extra,
  };
  return { fetch: (input, init) => backendWorker.fetch(new Request(input, init), backendEnv, { waitUntil() {} }) };
}

test("GET /api/watchlist returns the configured watchlist in order", async () => {
  const response = await backendFor().fetch("https://backend/api/watchlist");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { tickers: ["AAPL", "MSFT", "XAUUSD"] });
});
