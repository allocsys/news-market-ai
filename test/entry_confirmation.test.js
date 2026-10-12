// shared/entry_confirmation.js: the pure entry-confirmation rule (decision switch entryConfirmation, default OFF).

import test from "node:test";
import assert from "node:assert/strict";
import {
  entryConfirmationParams,
  entryConfirmationExpiryMs,
  pendingConfirmationRecord,
  confirmationSpecOf,
  findConfirmationBar,
} from "../src/shared/entry_confirmation.js";
import { DEFAULT_ENTRY_CONFIRM_MOVE_PCT, DEFAULT_ENTRY_CONFIRM_HOURS } from "../src/shared/constants.js";

const bar = (openIso, close, { minutes = 5, kind = "intraday" } = {}) => {
  const openMs = Date.parse(openIso);
  return { openMs, availableAt: new Date(openMs + minutes * 60000).toISOString(), close, kind };
};

const spec = { from: "2026-01-15T13:36:00Z", direction: "long", refPrice: 100, movePct: 0.01, expiresAt: "2026-01-15T19:36:00Z" };

test("entryConfirmationParams: defaults, valid overrides kept, invalid ones fall back", () => {
  assert.deepEqual(entryConfirmationParams({}), { movePct: DEFAULT_ENTRY_CONFIRM_MOVE_PCT, hours: DEFAULT_ENTRY_CONFIRM_HOURS });
  assert.deepEqual(entryConfirmationParams({ entryConfirmMovePct: 0.01, entryConfirmHours: 12 }), { movePct: 0.01, hours: 12 });
  for (const bad of [{ entryConfirmMovePct: 0 }, { entryConfirmMovePct: 0.5 }, { entryConfirmHours: 0 }, { entryConfirmHours: 100 }, { entryConfirmHours: Number.NaN }]) {
    assert.deepEqual(entryConfirmationParams(bad), { movePct: DEFAULT_ENTRY_CONFIRM_MOVE_PCT, hours: DEFAULT_ENTRY_CONFIRM_HOURS }, JSON.stringify(bad));
  }
});

test("entryConfirmationExpiryMs and pendingConfirmationRecord", () => {
  assert.equal(entryConfirmationExpiryMs(6), 6 * 60 * 60 * 1000);
  assert.deepEqual(pendingConfirmationRecord({ refPrice: 180, movePct: 0.005, hours: 6 }), { status: "pending", refPrice: 180, movePct: 0.005, hours: 6 });
});

test("confirmationSpecOf: found by its numbers, whatever the outcome status (a crash after the outcome write must re-run the same fill)", () => {
  const pending = (entryConfirmation) => ({ debate: { evidence: { entryConfirmation } } });
  assert.equal(confirmationSpecOf(null), null);
  assert.equal(confirmationSpecOf({}), null);
  assert.equal(confirmationSpecOf({ debate: { evidence: {} } }), null, "a plain stale-price pending entry has no spec");
  assert.equal(confirmationSpecOf(pending({ status: "pending", refPrice: 0, movePct: 0.01 })), null);
  assert.equal(confirmationSpecOf(pending({ status: "pending", refPrice: 100, movePct: 0 })), null);
  assert.equal(confirmationSpecOf(pending({ status: "pending", refPrice: "100", movePct: 0.01 })), null);
  assert.equal(confirmationSpecOf(pending("pending")), null);
  for (const status of ["pending", "confirmed", "expired"]) {
    const got = confirmationSpecOf(pending({ status, refPrice: 100, movePct: 0.01, hours: 6 }));
    assert.equal(got?.refPrice, 100, status);
    assert.equal(got?.movePct, 0.01, status);
  }
});

test("findConfirmationBar: the first bar whose CLOSE moved enough in the trade direction (long)", () => {
  const sequence = [
    bar("2026-01-15T13:40:00Z", 100.5), // +0.5%: not enough
    bar("2026-01-15T13:45:00Z", 101.2), // +1.2%: confirms
    bar("2026-01-15T13:50:00Z", 103), // later: not used
  ];
  const got = findConfirmationBar(sequence, spec);
  assert.equal(got.closedAt, "2026-01-15T13:50:00.000Z", "confirmation instant = the confirming bar's close");
  assert.equal(got.close, 101.2);
  assert.equal(got.kind, "intraday");
  assert.ok(Math.abs(got.movePct - 0.012) < 1e-9);
});

test("findConfirmationBar: a short is confirmed by a drop", () => {
  const sequence = [bar("2026-01-15T13:40:00Z", 100.9), bar("2026-01-15T13:45:00Z", 98.9)];
  const got = findConfirmationBar(sequence, { ...spec, direction: "short" });
  assert.equal(got.closedAt, "2026-01-15T13:50:00.000Z");
  assert.ok(Math.abs(got.movePct - 0.011) < 1e-9);
  // The same bars never confirm a long that needed a rise of 1%: 98.9 and 100.9 -> only +0.9%.
  assert.equal(findConfirmationBar(sequence, spec), null);
});

test("findConfirmationBar: a move against the trade, or too small, never confirms", () => {
  assert.equal(findConfirmationBar([bar("2026-01-15T13:40:00Z", 95), bar("2026-01-15T13:45:00Z", 90)], spec), null);
  assert.equal(findConfirmationBar([bar("2026-01-15T13:40:00Z", 100.99)], spec), null);
  assert.equal(findConfirmationBar([], spec), null);
  assert.equal(findConfirmationBar(undefined, spec), null);
});

test("findConfirmationBar: bars that opened before the decision are never used (the decision did not exist yet)", () => {
  const sequence = [bar("2026-01-15T13:30:00Z", 110), bar("2026-01-15T13:35:00Z", 110)];
  assert.equal(findConfirmationBar(sequence, spec), null);
  // A bar opening exactly at `from` is the first usable one.
  assert.ok(findConfirmationBar([bar("2026-01-15T13:36:00Z", 110)], spec));
});

test("findConfirmationBar: a bar that closes at or after the deadline is too late", () => {
  assert.ok(findConfirmationBar([bar("2026-01-15T19:30:00Z", 105)], spec), "closes 19:35, before the 19:36 deadline");
  assert.equal(findConfirmationBar([bar("2026-01-15T19:31:00Z", 105)], spec), null, "closes exactly at the deadline");
  assert.equal(findConfirmationBar([bar("2026-01-15T19:40:00Z", 105)], spec), null);
});

test("findConfirmationBar: bars with no usable close are skipped; bad inputs return null", () => {
  const sequence = [bar("2026-01-15T13:40:00Z", null), bar("2026-01-15T13:45:00Z", Number.NaN), bar("2026-01-15T13:50:00Z", 102)];
  assert.equal(findConfirmationBar(sequence, spec).close, 102);
  const good = [bar("2026-01-15T13:40:00Z", 105)];
  assert.equal(findConfirmationBar(good, { ...spec, refPrice: 0 }), null);
  assert.equal(findConfirmationBar(good, { ...spec, movePct: 0 }), null);
  assert.equal(findConfirmationBar(good, { ...spec, direction: "flat" }), null);
  assert.equal(findConfirmationBar(good, { ...spec, from: "garbage" }), null);
  assert.equal(findConfirmationBar(good, { ...spec, expiresAt: "garbage" }), null);
});
