// price_resolution test (plan.md finding G step 4): graph/price_resolution.js's
// resolveCurrentPrice -- the shared intraday-first, daily-close-fallback
// current-price read used by both graph/pipeline.js's portfolio_checked
// stage and graph/exit_check.js. Unit-level only: this covers the resolver
// itself against real sqlite inputs DBs (test/helpers/engine_ctx.js).
// Higher-level integration coverage (same-day-replace-has-real-PnL,
// lookahead leak-check on the resolver's own callers) is plan.md finding G
// step 5's own scope, not duplicated here.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveCurrentPrice } from "../src/graph/price_resolution.js";
import { makeCtx, seedBar, seedIntradayBar } from "./helpers/engine_ctx.js";

test("resolveCurrentPrice prefers an intraday bar over the daily close when both are visible", async () => {
  const { inputs } = makeCtx();
  await seedBar(inputs, { ticker: "AAPL", date: "2026-01-14", close: 180 }); // previous day's close
  await seedIntradayBar(inputs, { ticker: "AAPL", ts: "2026-01-15T13:30:00Z", close: 182.5 });

  const result = await resolveCurrentPrice(inputs, { ticker: "AAPL", asOf: "2026-01-15T13:36:00Z" }); // bar closed at 13:35
  assert.equal(result.price, 182.5);
  assert.equal(result.source, "intraday");
  assert.equal(result.bar.ts, "2026-01-15T13:30:00Z");
});

test("resolveCurrentPrice falls back to the daily close, logged, when no intraday bar is visible at asOf", async () => {
  const { inputs } = makeCtx();
  await seedBar(inputs, { ticker: "AAPL", date: "2026-01-14", close: 180 });
  // No intraday bars seeded at all.

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  let result;
  try {
    result = await resolveCurrentPrice(inputs, { ticker: "AAPL", asOf: "2026-01-15T13:36:00Z" });
  } finally {
    console.error = originalError;
  }

  assert.equal(result.price, 180);
  assert.equal(result.source, "daily");
  assert.equal(result.bar.date, "2026-01-14");
  assert.equal(errors.length, 1, "the daily fallback must be logged (Adopted Pattern #11)");
  assert.match(errors[0][0], /falling back to daily close/);
  assert.equal(errors[0][1].ticker, "AAPL");
});

test("resolveCurrentPrice falls back to the daily close even when an intraday bar exists but has not closed yet at asOf", async () => {
  const { inputs } = makeCtx();
  await seedBar(inputs, { ticker: "AAPL", date: "2026-01-14", close: 180 });
  await seedIntradayBar(inputs, { ticker: "AAPL", ts: "2026-01-15T13:30:00Z", close: 182.5 });

  // asOf is inside the 13:30 bar's own window (13:30-13:34:59) -- not visible yet.
  const result = await resolveCurrentPrice(inputs, { ticker: "AAPL", asOf: "2026-01-15T13:32:00Z" });
  assert.equal(result.source, "daily");
  assert.equal(result.price, 180);
});

test("resolveCurrentPrice returns { price: null, source: null, bar: null } when neither read finds anything -- never fabricated (Pattern #9)", async () => {
  const { inputs } = makeCtx();

  const originalError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await resolveCurrentPrice(inputs, { ticker: "AAPL", asOf: "2026-01-15T13:36:00Z" });
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(result, { price: null, source: null, bar: null });
});

test("resolveCurrentPrice: two same-day calls for the same ticker at distinct intraday timestamps return DISTINCT prices (finding G's actual fix)", async () => {
  const { inputs } = makeCtx();
  await seedBar(inputs, { ticker: "AAPL", date: "2026-01-14", close: 180 }); // what BOTH calls would have returned pre-fix
  await seedIntradayBar(inputs, { ticker: "AAPL", ts: "2026-01-15T13:30:00Z", close: 181.2 });
  await seedIntradayBar(inputs, { ticker: "AAPL", ts: "2026-01-15T15:45:00Z", close: 179.4 });

  const morning = await resolveCurrentPrice(inputs, { ticker: "AAPL", asOf: "2026-01-15T13:36:00Z" });
  const afternoon = await resolveCurrentPrice(inputs, { ticker: "AAPL", asOf: "2026-01-15T15:51:00Z" });

  assert.equal(morning.price, 181.2);
  assert.equal(afternoon.price, 179.4);
  assert.notEqual(morning.price, afternoon.price);
});
