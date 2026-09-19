// fundamentals_pointintime test (plan.md Backtesting Integrity point 3:
// point-in-time fundamentals). Three layers, same convention as
// price_bars_pointintime.test.js: validateFundamentalFact (pure function),
// storage/inputs_view.js#insertFundamentalFact/getFundamentalFactsAsOf against a
// minimal in-memory fake of the `fundamental_facts` table, and
// edgar_fundamentals.js#fetchFacts's response-parsing against a mocked
// fetch. The storage-layer tests are the ones that actually prove point-in-
// time correctness: a restated fact filed later must not be visible to a
// simulated `asOf` before it was filed, and once it IS visible it must
// replace (not sit alongside) the original for that fiscal period.

import test from "node:test";
import assert from "node:assert/strict";
import { validateFundamentalFact } from "../src/ingestion/market_data_validator.js";
import { insertFundamentalFact, getFundamentalFactsAsOf } from "../src/storage/inputs_view.js";
import { VendorError, LookaheadViolationError } from "../src/shared/errors.js";
import { fetchFacts } from "../src/ingestion/sources/edgar_fundamentals.js";

const VALID_FACT = {
  ticker: "AAPL", cik: "0000320193", tag: "Revenues", val: 1000000, unit: "USD",
  fiscalYear: 2026, fiscalPeriod: "Q2", form: "10-Q", filedAt: "2026-07-25T00:00:00Z", source: "edgar",
};

// ---------------------------------------------------------------------------
// validateFundamentalFact
// ---------------------------------------------------------------------------

test("validateFundamentalFact accepts a well-formed fact", () => {
  assert.doesNotThrow(() => validateFundamentalFact(VALID_FACT));
});

test("validateFundamentalFact rejects filedAt in the future", () => {
  assert.throws(() => validateFundamentalFact({ ...VALID_FACT, filedAt: "2099-01-01T00:00:00Z" }), VendorError);
});

test("validateFundamentalFact rejects an unparseable filedAt", () => {
  assert.throws(() => validateFundamentalFact({ ...VALID_FACT, filedAt: "not-a-date" }), VendorError);
});

test("validateFundamentalFact rejects a non-numeric val", () => {
  assert.throws(() => validateFundamentalFact({ ...VALID_FACT, val: "a lot" }), VendorError);
});

test("validateFundamentalFact rejects a missing ticker or tag", () => {
  assert.throws(() => validateFundamentalFact({ ...VALID_FACT, ticker: "" }), VendorError);
  assert.throws(() => validateFundamentalFact({ ...VALID_FACT, tag: "" }), VendorError);
});

// ---------------------------------------------------------------------------
// storage/inputs_view.js against a fake `fundamental_facts` table
// ---------------------------------------------------------------------------

class FakeFundamentalsDb {
  constructor() {
    this.rows = new Map(); // `${ticker}|${tag}|${fy}|${fp}|${form}` -> row
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO fundamental_facts/.test(sql)) {
              const [ticker, cik, tag, val, unit, fiscalYear, fiscalPeriod, form, filedAt, source] = args;
              const key = `${ticker}|${tag}|${fiscalYear}|${fiscalPeriod}|${form}`;
              db.rows.set(key, { ticker, cik, tag, val, unit, fiscal_year: fiscalYear, fiscal_period: fiscalPeriod, form, filed_at: filedAt, source });
              return;
            }
            throw new Error(`FakeFundamentalsDb: unsupported run() query: ${sql}`);
          },
          async all() {
            if (!/FROM fundamental_facts/.test(sql)) {
              throw new Error(`FakeFundamentalsDb: unsupported all() query: ${sql}`);
            }
            const [ticker, tag, asOf, limit] = args;
            // Mirrors the real query's window-function semantics in JS:
            // filter to ticker/tag/filed_at<=asOf, then keep only the
            // latest-filed row per (fiscal_year, fiscal_period).
            const candidates = [...db.rows.values()].filter((r) => r.ticker === ticker && r.tag === tag && r.filed_at <= asOf);
            const latestPerPeriod = new Map(); // `${fy}|${fp}` -> row
            for (const row of candidates) {
              const periodKey = `${row.fiscal_year}|${row.fiscal_period}`;
              const existing = latestPerPeriod.get(periodKey);
              if (!existing || row.filed_at > existing.filed_at) latestPerPeriod.set(periodKey, row);
            }
            const results = [...latestPerPeriod.values()]
              .sort((a, b) => (b.fiscal_year - a.fiscal_year) || (b.fiscal_period > a.fiscal_period ? 1 : -1))
              .slice(0, limit);
            return { results };
          },
        };
      },
    };
  }
}

test("getFundamentalFactsAsOf throws LookaheadViolationError when asOf is omitted", async () => {
  const db = new FakeFundamentalsDb();
  await assert.rejects(() => getFundamentalFactsAsOf(db, { ticker: "AAPL", tag: "Revenues" }), LookaheadViolationError);
});

test("getFundamentalFactsAsOf returns nothing when no facts have been filed yet as of asOf", async () => {
  const db = new FakeFundamentalsDb();
  await insertFundamentalFact(db, VALID_FACT); // filed 2026-07-25
  const results = await getFundamentalFactsAsOf(db, { ticker: "AAPL", tag: "Revenues", asOf: "2026-06-01T00:00:00Z" });
  assert.equal(results.length, 0);
});

test("getFundamentalFactsAsOf returns the original figure once filed, before any restatement", async () => {
  const db = new FakeFundamentalsDb();
  await insertFundamentalFact(db, VALID_FACT); // 1,000,000 filed 2026-07-25 via 10-Q
  const results = await getFundamentalFactsAsOf(db, { ticker: "AAPL", tag: "Revenues", asOf: "2026-08-01T00:00:00Z" });
  assert.equal(results.length, 1);
  assert.equal(results[0].val, 1000000);
});

test("getFundamentalFactsAsOf serves the RESTATED value once its later filing date has passed, and the ORIGINAL value before it -- the core point-in-time guarantee", async () => {
  const db = new FakeFundamentalsDb();
  await insertFundamentalFact(db, VALID_FACT); // original: 1,000,000 filed 2026-07-25 via 10-Q
  await insertFundamentalFact(db, { ...VALID_FACT, val: 950000, form: "10-Q/A", filedAt: "2026-09-10T00:00:00Z" }); // restated down

  const beforeRestatement = await getFundamentalFactsAsOf(db, { ticker: "AAPL", tag: "Revenues", asOf: "2026-08-15T00:00:00Z" });
  assert.equal(beforeRestatement.length, 1);
  assert.equal(beforeRestatement[0].val, 1000000); // restatement not yet public -- must NOT leak into the past

  const afterRestatement = await getFundamentalFactsAsOf(db, { ticker: "AAPL", tag: "Revenues", asOf: "2026-09-15T00:00:00Z" });
  assert.equal(afterRestatement.length, 1); // still one row per period, the newer one wins
  assert.equal(afterRestatement[0].val, 950000);
});

test("getFundamentalFactsAsOf keeps separate fiscal periods separate", async () => {
  const db = new FakeFundamentalsDb();
  await insertFundamentalFact(db, { ...VALID_FACT, fiscalPeriod: "Q1", val: 900000, form: "10-Q", filedAt: "2026-04-25T00:00:00Z" });
  await insertFundamentalFact(db, VALID_FACT); // Q2, 1,000,000, filed 2026-07-25

  const results = await getFundamentalFactsAsOf(db, { ticker: "AAPL", tag: "Revenues", asOf: "2026-08-01T00:00:00Z" });
  assert.equal(results.length, 2);
});

// ---------------------------------------------------------------------------
// edgar_fundamentals.js#fetchFacts (mocked fetch)
// ---------------------------------------------------------------------------

function mockCompanyFactsResponse() {
  return {
    facts: {
      "us-gaap": {
        Revenues: {
          units: {
            USD: [
              { fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-07-25", val: 1000000, end: "2026-06-30" },
              { fy: 2026, fp: "Q2", form: "10-Q/A", filed: "2026-09-10", val: 950000, end: "2026-06-30" },
              { fy: 2026, fp: "Q1", form: "10-Q", filed: null, val: 800000, end: "2026-03-31" }, // no filed date -- should be skipped
            ],
          },
        },
      },
    },
  };
}

test("fetchFacts throws a non-transient VendorError when edgarUserAgent is not configured", async () => {
  const config = { edgarUserAgent: "", edgarApiBase: "https://fake.test/companyfacts", edgarCikMap: { AAPL: "320193" } };
  await assert.rejects(() => fetchFacts(config, { ticker: "AAPL", tag: "Revenues" }), (err) => {
    assert.ok(err instanceof VendorError);
    assert.equal(err.transient, false);
    return true;
  });
});

test("fetchFacts throws a non-transient VendorError when the ticker has no CIK configured", async () => {
  const config = { edgarUserAgent: "test-suite contact@example.com", edgarApiBase: "https://fake.test/companyfacts", edgarCikMap: {} };
  await assert.rejects(() => fetchFacts(config, { ticker: "AAPL", tag: "Revenues" }), (err) => {
    assert.ok(err instanceof VendorError);
    assert.equal(err.transient, false);
    return true;
  });
});

test("fetchFacts parses facts, normalizes the CIK, sends the required User-Agent header, and skips entries with no filed date", async (t) => {
  const config = { edgarUserAgent: "test-suite contact@example.com", edgarApiBase: "https://fake.test/companyfacts", edgarCikMap: { AAPL: "320193" } };
  let capturedHeaders;
  let capturedUrl;
  t.mock.method(global, "fetch", async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => mockCompanyFactsResponse() };
  });

  const facts = await fetchFacts(config, { ticker: "AAPL", tag: "Revenues" });
  assert.equal(capturedUrl, "https://fake.test/companyfacts/CIK0000320193.json");
  assert.equal(capturedHeaders["User-Agent"], "test-suite contact@example.com");
  assert.equal(facts.length, 2); // the null-filed Q1 entry is skipped
  assert.ok(facts.every((f) => f.cik === "0000320193"));

  const q2Facts = facts.filter((f) => f.fiscalPeriod === "Q2");
  assert.equal(q2Facts.length, 2); // original + restatement, both kept as distinct rows
  assert.ok(q2Facts.some((f) => f.val === 1000000 && f.form === "10-Q"));
  assert.ok(q2Facts.some((f) => f.val === 950000 && f.form === "10-Q/A"));
});

test("fetchFacts returns an empty array when the filer doesn't report the requested tag", async (t) => {
  const config = { edgarUserAgent: "test-suite contact@example.com", edgarApiBase: "https://fake.test/companyfacts", edgarCikMap: { AAPL: "320193" } };
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => ({ facts: { "us-gaap": {} } }) }));

  const facts = await fetchFacts(config, { ticker: "AAPL", tag: "SomeUnreportedTag" });
  assert.deepEqual(facts, []);
});

test("fetchFacts throws a transient VendorError on HTTP 429", async (t) => {
  const config = { edgarUserAgent: "test-suite contact@example.com", edgarApiBase: "https://fake.test/companyfacts", edgarCikMap: { AAPL: "320193" } };
  t.mock.method(global, "fetch", async () => ({ ok: false, status: 429 }));

  await assert.rejects(() => fetchFacts(config, { ticker: "AAPL", tag: "Revenues" }), (err) => {
    assert.ok(err instanceof VendorError);
    assert.equal(err.transient, true);
    return true;
  });
});
