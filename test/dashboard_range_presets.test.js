// Quick-range buttons (7d / 14d / 30d / 90d) on the backtest and backfill forms.
// Each button's onclick must be self-contained: it has to set both date inputs
// even when nothing else on the page ran. Also checks that every inline script
// the shell emits still parses (a single syntax error there silently kills every
// page-level helper, which is how a dead button looks from a phone).

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { rangePresetButtons, rangePresetOnclick, RANGE_PRESET_DAYS } from "../src/dashboard/helpers.js";
import { renderShell } from "../src/dashboard/shell.js";
import { backtestTriggerForm } from "../src/dashboard/views/backtest.js";
import { backfillTriggerForm, priceBackfillTriggerForm } from "../src/dashboard/views/backfill.js";

function decodeAttr(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function onclicks(html) {
  return [...html.matchAll(/<button type="button" class="pill" onclick="([^"]*)">(\d+)d<\/button>/g)].map((m) => ({ code: decodeAttr(m[1]), days: Number(m[2]) }));
}

function fakeInput() {
  return { value: "", events: [], dispatchEvent(e) { this.events.push(e.type); return true; } };
}

function runClick(code, ids) {
  const els = Object.fromEntries(ids.map((id) => [id, fakeInput()]));
  const document = { getElementById: (id) => els[id] ?? null };
  class Event { constructor(type) { this.type = type; } }
  vm.runInNewContext(code, { document, Date, Event });
  return els;
}

const isoDaysAgo = (days) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

test("rangePresetButtons renders one button per preset, none depending on a page-level function", () => {
  const found = onclicks(rangePresetButtons("fromX", "toX"));
  assert.deepEqual(found.map((f) => f.days), RANGE_PRESET_DAYS);
  for (const f of found) assert.doesNotMatch(f.code, /setDateRange/);
});

test("each quick-range onclick sets end = today, start = today - N days, and fires change on both inputs", () => {
  for (const { code, days } of onclicks(rangePresetButtons("fromX", "toX"))) {
    const els = runClick(code, ["fromX", "toX"]);
    assert.equal(els.toX.value, isoDaysAgo(0), `end for ${days}d`);
    assert.equal(els.fromX.value, isoDaysAgo(days), `start for ${days}d`);
    assert.deepEqual(els.fromX.events, ["change"]);
    assert.deepEqual(els.toX.events, ["change"]);
  }
});

test("a missing date input is a no-op, not a thrown error", () => {
  const { code } = onclicks(rangePresetButtons("fromX", "toX"))[0];
  assert.doesNotThrow(() => runClick(code, ["fromX"]));
  assert.doesNotThrow(() => runClick(code, []));
});

test("rangePresetOnclick rejects ids or day counts that could break out of the script", () => {
  assert.throws(() => rangePresetOnclick("a'b", "toX", 7));
  assert.throws(() => rangePresetOnclick("fromX", "t o", 7));
  assert.throws(() => rangePresetOnclick("fromX", "toX", "7;alert(1)"));
  assert.throws(() => rangePresetOnclick("fromX", "toX", -1));
});

test("the backtest and backfill forms wire their buttons to their own date input ids", () => {
  const backtest = onclicks(backtestTriggerForm([]));
  assert.equal(backtest.length, RANGE_PRESET_DAYS.length);
  const els = runClick(backtest[1].code, ["backtestStart", "backtestEnd"]);
  assert.equal(els.backtestStart.value, isoDaysAgo(backtest[1].days));
  assert.equal(els.backtestEnd.value, isoDaysAgo(0));
  const html = backtestTriggerForm([]);
  assert.match(html, /id="backtestStart"/);
  assert.match(html, /id="backtestEnd"/);

  const backfill = onclicks(backfillTriggerForm());
  assert.equal(backfill.length, RANGE_PRESET_DAYS.length);
  const els2 = runClick(backfill[0].code, ["backfillFrom", "backfillTo"]);
  assert.equal(els2.backfillFrom.value, isoDaysAgo(backfill[0].days));

  const prices = onclicks(priceBackfillTriggerForm([]));
  assert.equal(prices.length, RANGE_PRESET_DAYS.length);
  const els3 = runClick(prices[2].code, ["priceBackfillFrom", "priceBackfillTo"]);
  assert.equal(els3.priceBackfillFrom.value, isoDaysAgo(prices[2].days));
  assert.equal(els3.priceBackfillTo.value, isoDaysAgo(0));
});

test("every inline <script> the shell emits parses as JavaScript", () => {
  const html = renderShell({
    activeSection: "backtest",
    sessionUsername: "owner",
    bodyHtml: backtestTriggerForm(["AAPL", "MSFT"]),
    refreshHref: "/dashboard/backtest",
    env: "live",
    theme: "dark",
    exportData: { runs: [] },
  });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 2, "expected the head scripts");
  for (const src of scripts) assert.doesNotThrow(() => new vm.Script(src), "inline script must parse");
  assert.ok(scripts.some((s) => s.includes("function toggleTheme")), "the page-level helper script is present");
});
