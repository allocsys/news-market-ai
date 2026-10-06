// Covers backend's GET /api/watchlist, the source of the ticker option lists
// used by dashboard-next's forms. (The server-rendered ticker pickers and the
// pages that embedded them were retired in favor of dashboard-next.)

import test from "node:test";
import assert from "node:assert/strict";
import backendWorker from "../src/index.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR } from "./helpers/engine_ctx.js";

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
