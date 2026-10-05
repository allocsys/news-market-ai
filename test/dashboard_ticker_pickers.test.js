// Covers dashboard/ticker_picker.js and the four forms that use it (backtest
// trigger, news-replay trigger, price backfill, LLM-calls filter): tap-to-choose
// from the watchlist instead of typing a symbol. The option list comes from
// backend's GET /api/watchlist, fetched best-effort by dashboard-worker.js, and
// every form falls back to its old text field when that list is empty.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/dashboard-worker.js";
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
// GET /api/watchlist and the dashboard pages that use it
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

function dashEnv(backend = backendFor()) {
  return { BACKEND: backend, DASHBOARD_USERNAME: "admin", DASHBOARD_PASSWORD: "correct-horse-battery-staple", JWT_SECRET: "test-jwt-signing-key" };
}

async function cookieFor(env) {
  const response = await worker.fetch(
    new Request("https://dashboard.example/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "correct-horse-battery-staple" }).toString(),
    }),
    env,
  );
  return response.headers.get("Set-Cookie").split(";")[0];
}

async function page(path, env = dashEnv()) {
  const cookie = await cookieFor(env);
  const response = await worker.fetch(new Request(`https://dashboard.example${path}`, { headers: { Cookie: cookie } }), env);
  assert.equal(response.status, 200, `${path} should render`);
  return response.text();
}

/** A backend whose /api/watchlist fails, everything else real -- the pickers must degrade to text fields, not take the page down. */
function backendWithoutWatchlist() {
  const real = backendFor();
  return {
    fetch: (input, init) =>
      String(input).includes("/api/watchlist")
        ? Promise.resolve(new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } }))
        : real.fetch(input, init),
  };
}

test("GET /api/watchlist returns the configured watchlist in order", async () => {
  const response = await backendFor().fetch("https://backend/api/watchlist");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { tickers: ["AAPL", "MSFT", "XAUUSD"] });
});

test("/dashboard/backtest offers the watchlist as checkboxes and the replay form as a dropdown", async () => {
  const html = await page("/dashboard/backtest");
  assert.match(html, /<input type="checkbox" id="backtestTicker-XAUUSD" name="tickers" value="XAUUSD">/);
  assert.match(html, /<select name="ticker" id="replayTicker" required>/);
  assert.doesNotMatch(html, /id="backtestTickers"/);
});

test("/dashboard/backfill offers the watchlist as checkboxes for the price backfill", async () => {
  const html = await page("/dashboard/backfill");
  assert.match(html, /<input type="checkbox" id="priceBackfillTicker-XAUUSD" name="tickers" value="XAUUSD">/);
});

test("/dashboard/llm filters by ticker with a dropdown; the current and deep-linked tickers stay selected", async () => {
  const plain = await page("/dashboard/llm");
  assert.match(plain, /<select name="llmTicker" id="llmTicker"><option value="" selected>All tickers<\/option>/);

  const msft = await page("/dashboard/llm?llmTicker=MSFT");
  assert.match(msft, /<option value="MSFT" selected>MSFT<\/option>/);

  const linked = await page("/dashboard/llm?llmTicker=NVDA");
  assert.match(linked, /<option value="NVDA" selected>NVDA<\/option>/);
});

test("when the watchlist lookup fails every page still renders, with the old text fields", async () => {
  const env = dashEnv(backendWithoutWatchlist());
  const backtest = await page("/dashboard/backtest", env);
  assert.match(backtest, /<input class="filter-form" id="backtestTickers" type="text" name="tickers"/);
  assert.match(backtest, /<input class="filter-form" type="text" name="ticker" placeholder="AAPL" required>/);

  const backfill = await page("/dashboard/backfill", env);
  assert.match(backfill, /<input class="filter-form" type="text" name="tickers" placeholder="blank = watchlist/);

  const llm = await page("/dashboard/llm", env);
  assert.match(llm, /<input class="filter-form" type="text" name="llmTicker"/);
});

test("the backtest confirm page joins repeated tickers params into one comma list for the run form", async () => {
  const html = await page("/dashboard/backtest/confirm?testStart=2026-09-01&testEnd=2026-09-10&tickers=AAPL&tickers=MSFT");
  assert.match(html, /<span class="ticker">AAPL,MSFT<\/span>/);
  assert.match(html, /<input type="hidden" name="tickers" value="AAPL,MSFT">/);
});

test("the backtest confirm page still reads a comma list, and says 'Watchlist' when no ticker was ticked", async () => {
  const listed = await page("/dashboard/backtest/confirm?testStart=2026-09-01&testEnd=2026-09-10&tickers=aapl,msft");
  assert.match(listed, /<input type="hidden" name="tickers" value="AAPL,MSFT">/);

  const none = await page("/dashboard/backtest/confirm?testStart=2026-09-01&testEnd=2026-09-10");
  assert.match(none, /<span class="ticker">Watchlist<\/span>/);
  assert.doesNotMatch(none, /name="tickers"/);
});

test("the price backfill confirm page joins repeated tickers params into one comma list", async () => {
  const html = await page("/dashboard/backfill-prices/confirm?from=2026-01-01&to=2026-09-01&tickers=AAPL&tickers=XAUUSD");
  assert.match(html, /<input type="hidden" name="tickers" value="AAPL,XAUUSD">/);
});
