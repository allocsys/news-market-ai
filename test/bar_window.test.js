// Bar-window helpers (shared/bar_window.js): where a position's next window of
// bars starts, and how intraday + daily rows merge into one chronological
// sequence. Pure functions, so no DB.

import test from "node:test";
import assert from "node:assert/strict";
import {
  exitWindowStart,
  buildBarSequence,
  EXIT_WINDOW_INTRADAY_ROW_CAP,
  EXIT_WINDOW_DAILY_ROW_CAP,
  INTRADAY_BAR_MS,
} from "../src/shared/bar_window.js";

// ---------------------------------------------------------------------------
// exitWindowStart
// ---------------------------------------------------------------------------

test("exitWindowStart: no cursor -> the window starts at opened_at; daily bars start the NEXT UTC date", () => {
  const w = exitWindowStart({ openedAt: "2026-01-05T14:32:10Z", lastCheckedAt: null });
  assert.equal(w.anchorIso, "2026-01-05T14:32:10.000Z");
  assert.equal(w.intradayFromTs, "2026-01-05T14:32:10Z"); // canonical stored form, no fraction
  assert.equal(w.dailyFromDate, "2026-01-06"); // the entry day's daily bar holds pre-entry prices
});

test("exitWindowStart: the cursor (last_checked_at) wins over opened_at", () => {
  const w = exitWindowStart({ openedAt: "2026-01-05T14:32:10Z", lastCheckedAt: "2026-01-07T10:00:00.000Z" });
  assert.equal(w.anchorIso, "2026-01-07T10:00:00.000Z");
  assert.equal(w.intradayFromTs, "2026-01-07T10:00:00Z");
  assert.equal(w.dailyFromDate, "2026-01-08");
});

test("exitWindowStart: a fractional anchor rounds the intraday lower bound UP to the next whole second", () => {
  // Stored ts values are whole seconds; a bar stamped 14:32:10 opened BEFORE a 14:32:10.400 anchor.
  const w = exitWindowStart({ openedAt: "2026-01-05T14:32:10.400Z", lastCheckedAt: null });
  assert.equal(w.anchorIso, "2026-01-05T14:32:10.400Z");
  assert.equal(w.intradayFromTs, "2026-01-05T14:32:11Z");
});

test("exitWindowStart: an anchor exactly at 00:00:00Z lets that whole day's daily bar in", () => {
  const w = exitWindowStart({ openedAt: "2026-01-05T00:00:00.000Z", lastCheckedAt: null });
  assert.equal(w.intradayFromTs, "2026-01-05T00:00:00Z");
  assert.equal(w.dailyFromDate, "2026-01-05");
  // One second later is no longer a day boundary.
  assert.equal(exitWindowStart({ openedAt: "2026-01-05T00:00:01Z", lastCheckedAt: null }).dailyFromDate, "2026-01-06");
});

test("exitWindowStart: offsets are normalised to UTC", () => {
  const w = exitWindowStart({ openedAt: "2026-01-05T23:30:00-05:00", lastCheckedAt: null }); // 04:30Z on the 6th
  assert.equal(w.anchorIso, "2026-01-06T04:30:00.000Z");
  assert.equal(w.dailyFromDate, "2026-01-07");
});

test("exitWindowStart: an unparseable or missing anchor returns null (never 'the beginning of time')", () => {
  assert.equal(exitWindowStart({ openedAt: "garbage", lastCheckedAt: null }), null);
  assert.equal(exitWindowStart({ openedAt: null, lastCheckedAt: null }), null);
  assert.equal(exitWindowStart({}), null);
  assert.equal(exitWindowStart({ openedAt: 12345, lastCheckedAt: undefined }), null); // non-string
});

// ---------------------------------------------------------------------------
// buildBarSequence
// ---------------------------------------------------------------------------

const irow = (ts, o = 100, h = 101, l = 99, c = 100) => ({ ts, open: o, high: h, low: l, close: c });
const drow = (date, o = 100, h = 105, l = 95, c = 100) => ({ date, open: o, high: h, low: l, close: c });

test("buildBarSequence: defaults to an empty sequence", () => {
  assert.deepEqual(buildBarSequence(), []);
  assert.deepEqual(buildBarSequence({}), []);
  assert.deepEqual(buildBarSequence({ intraday: [], daily: [] }), []);
});

test("buildBarSequence: an intraday row becomes a bar available 5 minutes after its ts (canonical form, OHLC carried over)", () => {
  const [b] = buildBarSequence({ intraday: [irow("2026-01-05T14:30:00Z", 100, 103, 98, 101)] });
  assert.equal(b.kind, "intraday");
  assert.equal(b.openMs, Date.parse("2026-01-05T14:30:00Z"));
  assert.equal(b.availableAt, "2026-01-05T14:35:00Z");
  assert.deepEqual([b.open, b.high, b.low, b.close], [100, 103, 98, 101]);
});

test("buildBarSequence: a daily row becomes a bar available at the NEXT 00:00:00Z", () => {
  const [b] = buildBarSequence({ daily: [drow("2026-01-06", 100, 105, 95, 102)] });
  assert.equal(b.kind, "daily");
  assert.equal(b.openMs, Date.parse("2026-01-06T00:00:00Z"));
  assert.equal(b.availableAt, "2026-01-07T00:00:00Z");
  assert.deepEqual([b.open, b.high, b.low, b.close], [100, 105, 95, 102]);
  // Month/year rollover.
  assert.equal(buildBarSequence({ daily: [drow("2025-12-31")] })[0].availableAt, "2026-01-01T00:00:00Z");
});

test("buildBarSequence: a day WITH intraday rows ignores that day's daily bar; a day without keeps it", () => {
  const seq = buildBarSequence({
    intraday: [irow("2026-01-06T14:30:00Z"), irow("2026-01-06T14:35:00Z")],
    daily: [drow("2026-01-05"), drow("2026-01-06"), drow("2026-01-07")],
  });
  assert.deepEqual(
    seq.map((b) => `${b.kind}:${new Date(b.openMs).toISOString().slice(0, 16)}`),
    ["daily:2026-01-05T00:00", "intraday:2026-01-06T14:30", "intraday:2026-01-06T14:35", "daily:2026-01-07T00:00"],
  );
});

test("buildBarSequence: the result is sorted oldest first regardless of input order", () => {
  const seq = buildBarSequence({
    intraday: [irow("2026-01-06T15:00:00Z"), irow("2026-01-06T14:30:00Z")],
    daily: [drow("2026-01-08"), drow("2026-01-05")],
  });
  const opens = seq.map((b) => b.openMs);
  assert.deepEqual(opens, [...opens].sort((a, b) => a - b));
  assert.equal(seq.length, 4);
  assert.equal(seq[0].kind, "daily");
  assert.equal(seq[3].kind, "daily");
});

test("buildBarSequence: a truncated intraday read drops daily rows dated AFTER the last intraday day, keeps earlier ones", () => {
  const args = {
    intraday: [irow("2026-01-06T14:30:00Z"), irow("2026-01-06T14:35:00Z")],
    daily: [drow("2026-01-05"), drow("2026-01-06"), drow("2026-01-07"), drow("2026-01-08")],
  };
  const truncated = buildBarSequence({ ...args, intradayTruncated: true });
  assert.deepEqual(
    truncated.map((b) => b.kind),
    ["daily", "intraday", "intraday"], // 01-05 kept, 01-06 replaced by intraday, 01-07/01-08 dropped
  );
  // Not truncated: the later days are legitimate no-intraday days.
  const full = buildBarSequence(args);
  assert.deepEqual(
    full.map((b) => b.kind),
    ["daily", "intraday", "intraday", "daily", "daily"],
  );
});

test("buildBarSequence: truncated flag with no intraday rows changes nothing", () => {
  const seq = buildBarSequence({ daily: [drow("2026-01-05"), drow("2026-01-06")], intradayTruncated: true });
  assert.equal(seq.length, 2);
});

test("buildBarSequence: a daily row with an unparseable date is skipped", () => {
  const seq = buildBarSequence({ daily: [drow("not-a-date"), drow("2026-01-06")] });
  assert.equal(seq.length, 1);
  assert.equal(seq[0].openMs, Date.parse("2026-01-06T00:00:00Z"));
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

test("bar_window exports the bar length and row caps the reads rely on", () => {
  assert.equal(INTRADAY_BAR_MS, 5 * 60 * 1000);
  assert.ok(EXIT_WINDOW_INTRADAY_ROW_CAP > 4000, "must fit ~14 days of 24h/5min bars");
  assert.ok(EXIT_WINDOW_DAILY_ROW_CAP >= 30);
});
