// Shared fixture for every test that drives the engine (runPipelineForTicker,
// checkOpenPositionExits, the backtest runners) after the M2 port. Builds the
// same `{inputs, store}` context production builds, but over REAL sqlite-
// backed D1s (test/helpers/sqlite_d1.js) that have actually run the
// migrations/inputs and migrations/state SQL -- so a test proves the engine
// against the real schema and the real WHERE-predicates, not a hand-rolled
// regex fake that can drift from them.
//
// `inputs` is the RAW inputs db here (tests seed it); pass `readOnly(inputs)`
// yourself if a test wants to prove the engine never writes it. The engine
// only ever reads through inputs_view functions, so raw is fine by default.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestD1 } from "./sqlite_d1.js";
import { RunStore } from "../../src/storage/run_store.js";
import { insertNewsItem, insertPriceBar } from "../../src/storage/inputs_view.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = path.join(__dirname, "..", "..", "migrations", "state");
export const INPUTS_DIR = path.join(__dirname, "..", "..", "migrations", "inputs");
export const SIM_DIR = path.join(__dirname, "..", "..", "migrations", "sim");

/** Fresh in-memory inputs + state DBs and a RunStore over the state one. */
export function makeCtx({ runId = "live" } = {}) {
  const inputsDb = createTestD1([INPUTS_DIR]);
  const stateDb = createTestD1([STATE_DIR]);
  const store = new RunStore(stateDb, runId);
  return { inputs: inputsDb, store, inputsDb, stateDb };
}

/** Seeds one news item (+ its ticker rows) into the inputs DB. */
export async function seedNews(inputs, { id, tickers, publishedAt, title = "headline", body = "body", source = "test" }) {
  await insertNewsItem(inputs, {
    id, source, url: `https://example.test/${id}`, publishedAt, ingestedAt: publishedAt, title, body, raw: null, tickers,
  });
}

/** Seeds one flat price bar (open=high=low=close) into the inputs DB. */
export async function seedBar(inputs, { ticker, date, close, volume = 0 }) {
  await insertPriceBar(inputs, { ticker, date, open: close, high: close, low: close, close, volume, source: "test" });
}

/** All rows of a table in the state DB, for assertions. */
export async function stateRows(stateDb, table, orderBy = "rowid") {
  const { results } = await stateDb.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
  return results;
}
