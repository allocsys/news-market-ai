// Covers src/backtest/simClock.js -- see that file's header for why
// assertNotFuture throws while clampEnd silently pulls back in, and why
// `now` is captured once at construction rather than re-read per call.

import test from "node:test";
import assert from "node:assert/strict";
import { SimClock, realSimClock } from "../src/backtest/simClock.js";

const NOW = "2026-06-15T12:00:00.000Z";

test("now() returns the fixed value passed at construction", () => {
  const clock = new SimClock(NOW);
  assert.equal(clock.now(), NOW);
});

test("now() defaults to the real current time when constructed with no argument", () => {
  const before = Date.now();
  const clock = new SimClock();
  const after = Date.now();
  const clockMs = Date.parse(clock.now());
  assert.ok(clockMs >= before && clockMs <= after, "default now should fall between two real Date.now() readings taken around construction");
});

test("constructing with an unparseable now string throws", () => {
  assert.throws(() => new SimClock("not-a-date"), /invalid now value/);
});

test("assertNotFuture passes through a time at or before now unchanged", () => {
  const clock = new SimClock(NOW);
  assert.equal(clock.assertNotFuture("2026-06-15T11:00:00.000Z"), "2026-06-15T11:00:00.000Z");
  assert.equal(clock.assertNotFuture(NOW), NOW, "exactly now is not 'in the future', so this must not throw");
});

test("assertNotFuture throws on a time strictly after now, naming the label", () => {
  const clock = new SimClock(NOW);
  assert.throws(() => clock.assertNotFuture("2026-06-16T00:00:00.000Z", "testEnd"), (err) => {
    assert.match(err.message, /testEnd/);
    assert.match(err.message, /future/);
    return true;
  });
});

test("assertNotFuture defaults its label to 'time' when none is given", () => {
  const clock = new SimClock(NOW);
  assert.throws(() => clock.assertNotFuture("2026-06-16T00:00:00.000Z"), /: time \(/, "message should start with the default label 'time'");
});

test("clampEnd leaves a time at or before now unchanged", () => {
  const clock = new SimClock(NOW);
  assert.equal(clock.clampEnd("2026-06-01T00:00:00.000Z"), "2026-06-01T00:00:00.000Z");
  assert.equal(clock.clampEnd(NOW), NOW);
});

test("clampEnd pulls a future time back to now instead of throwing", () => {
  const clock = new SimClock(NOW);
  assert.equal(clock.clampEnd("2026-07-01T00:00:00.000Z"), NOW);
});

test("two calls against the same instance agree, even across real elapsed time", async () => {
  const clock = new SimClock(NOW);
  const first = clock.clampEnd("2026-07-01T00:00:00.000Z");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = clock.clampEnd("2026-07-01T00:00:00.000Z");
  assert.equal(first, second, "now must not drift between calls on one instance");
});

test("realSimClock() builds a SimClock pinned to the real current moment", () => {
  const clock = realSimClock();
  assert.ok(clock instanceof SimClock);
  assert.ok(Math.abs(Date.parse(clock.now()) - Date.now()) < 1000);
});
