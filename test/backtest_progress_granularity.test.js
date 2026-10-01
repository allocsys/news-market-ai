// Backtest progress used to move only when a whole day (every ticker's news plus the
// day's exit check) finished. With dozens of news items per day and roughly one item per
// continuation part, a live run sat at "0/17" for 49 parts although it was working.
// Now a ticker-day counts as soon as ITS news is processed, and every finished news item
// writes a progress line. Real sqlite DBs, a fake model.

import test from "node:test";
import assert from "node:assert/strict";
import { runManualBacktest } from "../src/backtest/runBacktest.js";
import { SimClock } from "../src/backtest/simClock.js";
import { AnalystTeamOpinion, DebateSide, DebateVerdict, TradeThesis } from "../src/schemas/index.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { makeCtx, seedNews, seedBar, SIM_DIR } from "./helpers/engine_ctx.js";

const ID = "bt-progress";
const RUN = { id: ID, tickers: ["AAPL", "MSFT"], testStart: "2026-01-01T00:00:00.000Z", testEnd: "2026-01-04T00:00:00.000Z", graceDays: 2 };
const NOW = "2026-06-01T00:00:00.000Z";

function model() {
  return async (prompt, opts) => {
    if (prompt.startsWith("A trade decision for")) return JSON.stringify({ reflection: "played out" });
    if (opts.schema === AnalystTeamOpinion) {
      return JSON.stringify({
        news_event: { eventType: "earnings_beat", entities: [], summary: "beat", justification: "guidance" },
        sentiment: { sentiment: "positive", summary: "pos", justification: "beat" },
        technical: { summary: "flat", justification: "few bars" },
      });
    }
    if (opts.schema === DebateSide) return JSON.stringify({ argument: "a", justification: "j" });
    if (opts.schema === DebateVerdict) return JSON.stringify({ direction: "long", confidence: 0.8, timeHorizon: "days", justification: "j" });
    if (opts.schema === TradeThesis) return JSON.stringify({ instrument: "equity", rationale: "ride it" });
    throw new Error("unexpected schema");
  };
}

const config = () => ({ geminiQuickModel: "quick", geminiDeepModel: "deep", maxDebateRounds: 1, maxPositionHoldDays: 2, fakeModel: model() });

/** AAPL has two items on day 1, MSFT one. */
async function seeded() {
  const ctx = makeCtx({ runId: ID });
  const registryDb = createTestD1([SIM_DIR]);
  for (const ticker of RUN.tickers) {
    for (const date of ["2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]) await seedBar(ctx.inputs, { ticker, date, close: 100 });
  }
  await seedNews(ctx.inputs, { id: "n1", tickers: ["AAPL"], publishedAt: "2026-01-01T10:00:00.000Z", title: "AAPL first" });
  await seedNews(ctx.inputs, { id: "n2", tickers: ["AAPL"], publishedAt: "2026-01-01T11:00:00.000Z", title: "AAPL second" });
  await seedNews(ctx.inputs, { id: "n3", tickers: ["MSFT"], publishedAt: "2026-01-01T12:00:00.000Z", title: "MSFT first" });
  return { ...ctx, registryDb };
}

test("progress moves per news item and per ticker-day, never backwards, and ends on every ticker-day", async () => {
  const ctx = await seeded();
  const updates = [];
  const out = await runManualBacktest({}, config(), ctx, { ...RUN, clock: new SimClock(NOW), onProgress: async (u) => { updates.push(u); } });
  assert.equal(out.status, "complete", out.error);

  const sim = updates.filter((u) => u.phase === "simulating");
  const at = (detail) => sim.find((u) => u.detail === detail);

  // One line per finished news item, with its place in the day.
  assert.equal(at("AAPL 2026-01-01 (news 1/2)")?.done, 0);
  assert.equal(at("AAPL 2026-01-01 (news 2/2)")?.done, 0);
  // AAPL's ticker-day counts once its news is done: before MSFT's news and before the day's exit check.
  assert.equal(at("AAPL 2026-01-01")?.done, 1);
  assert.equal(at("MSFT 2026-01-01 (news 1/1)")?.done, 1);
  assert.equal(at("MSFT 2026-01-01")?.done, 2);

  for (let i = 1; i < sim.length; i++) {
    assert.ok(sim[i].done >= sim[i - 1].done, `done went backwards at update ${i}`);
    assert.ok(sim[i].percent >= sim[i - 1].percent, `percent went backwards at update ${i}`);
  }
  // 2 tickers x 6 days (Jan 1 .. Jan 6, grace included), each counted exactly once.
  assert.equal(sim.at(-1).total, 12);
  assert.equal(sim.at(-1).done, 12);
  const ticks = sim.filter((u) => /^(AAPL|MSFT) \d{4}-\d{2}-\d{2}$/.test(u.detail));
  assert.equal(ticks.length, 12);
});
