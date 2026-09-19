// CI checks plan.md's "Backtest / Live Isolation" design calls for ("CI fails
// if wrangler.backtest.toml binds the `live` DB"; "CI fails if the `live` and
// `sim` schemas differ"). They live in the ordinary test suite because
// .github/workflows/deploy.yml's `test` job already runs `npm test` on every PR
// and push and gates migrate/deploy on it -- a separate job would add nothing.
//
// The binding check is an ALLOWLIST, not a denylist: the backtest Worker may
// bind exactly SIM_DB, INPUTS_DB and its own CACHE_KV, consume exactly the
// BACKTEST queue, and nothing else. A denylist ("not LIVE_DB") would pass a
// new binding to some future live resource; an allowlist makes any addition a
// conscious edit of this file. Each check function is also run against
// synthetic BAD configs, so a check that silently stopped detecting anything
// fails here instead of passing forever.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWranglerToml } from "./helpers/wrangler_toml.js";
import { createTestD1 } from "./helpers/sqlite_d1.js";
import { STATE_DIR, INPUTS_DIR, SIM_DIR } from "./helpers/engine_ctx.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => parseWranglerToml(readFileSync(path.join(ROOT, f), "utf8"));
const WRANGLER_FILES = ["wrangler.toml", "wrangler.dashboard.toml", "wrangler.ingest.toml", "wrangler.llm.toml", "wrangler.backtest.toml", "wrangler.sim-migrate.toml"];

const byBinding = (cfg, key) => Object.fromEntries((cfg.arrays[key] ?? []).map((b) => [b.binding, b]));

/** The backend config is the single source of truth for which database/namespace each binding name means. */
function referenceIds() {
  const backend = read("wrangler.toml");
  const d1 = byBinding(backend, "d1_databases");
  return {
    live: d1.LIVE_DB.database_id,
    sim: d1.SIM_DB.database_id,
    inputs: d1.INPUTS_DB.database_id,
    legacy: d1.DB.database_id,
  };
}

/** Everything wrong with a backtest Worker config; [] means it is isolated from live. */
export function findBacktestConfigViolations(cfg, ids, { otherKvIds = [] } = {}) {
  const problems = [];
  const d1 = cfg.arrays.d1_databases ?? [];
  const allowedD1 = { SIM_DB: ids.sim, INPUTS_DB: ids.inputs };
  for (const b of d1) {
    if (!(b.binding in allowedD1)) problems.push(`unexpected D1 binding ${b.binding} (allowed: ${Object.keys(allowedD1).join(", ")})`);
    else if (b.database_id !== allowedD1[b.binding]) problems.push(`${b.binding} points at database_id ${b.database_id}, expected ${allowedD1[b.binding]}`);
    if (b.database_id === ids.live) problems.push(`binding ${b.binding} is the live database`);
    if (b.database_id === ids.legacy || b.database_id === "REPLACE_WITH_D1_DATABASE_ID") problems.push(`binding ${b.binding} is the legacy pre-split database`);
  }
  for (const name of Object.keys(allowedD1)) {
    if (!d1.some((b) => b.binding === name)) problems.push(`missing required D1 binding ${name}`);
  }

  const kv = cfg.arrays.kv_namespaces ?? [];
  if (kv.length !== 1 || kv[0].binding !== "CACHE_KV") problems.push(`kv_namespaces must be exactly one CACHE_KV, got ${JSON.stringify(kv.map((k) => k.binding))}`);
  for (const k of kv) {
    if (String(k.id).startsWith("REPLACE_WITH")) problems.push(`KV ${k.binding} id is a placeholder -- ensure-kv-namespace would resolve it to live's namespace`);
    if (otherKvIds.includes(k.id)) problems.push(`KV ${k.binding} shares its id with another Worker's namespace (live cooldown state would be shared)`);
  }

  if ((cfg.arrays["queues.producers"] ?? []).length) problems.push("backtest must not produce to any queue (it cannot trigger live work)");
  const consumers = cfg.arrays["queues.consumers"] ?? [];
  if (consumers.length !== 1 || consumers[0].queue !== "news-market-ai-backtest") problems.push(`must consume exactly news-market-ai-backtest, got ${JSON.stringify(consumers.map((c) => c.queue))}`);

  for (const key of ["services", "durable_objects.bindings", "r2_buckets", "hyperdrive", "vectorize", "ai", "analytics_engine_datasets"]) {
    if ((cfg.arrays[key] ?? []).length || cfg.tables[key]) problems.push(`unexpected ${key} binding -- not in the backtest allowlist`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The TOML reader itself
// ---------------------------------------------------------------------------

test("wrangler_toml parser: headers, arrays of tables, comments, quoting", () => {
  const cfg = parseWranglerToml(`
name = "w" # trailing comment
[[d1_databases]]
binding = "A"   # not "B"
database_id = "x#y"
[[d1_databases]]
binding = "B"
[observability.logs]
enabled = true
crons = ["*/15 * * * *"]
`);
  assert.equal(cfg.top.name, "w");
  assert.deepEqual(cfg.arrays.d1_databases.map((b) => b.binding), ["A", "B"]);
  assert.equal(cfg.arrays.d1_databases[0].database_id, "x#y", "a # inside quotes is not a comment");
  assert.equal(cfg.tables["observability.logs"].enabled, true);
  assert.deepEqual(cfg.tables["observability.logs"].crons, ["*/15 * * * *"]);
});

test("every wrangler config in the repo parses into the shape the checks expect (no silently unread bindings)", () => {
  for (const f of WRANGLER_FILES) {
    const cfg = read(f);
    for (const b of [...(cfg.arrays.d1_databases ?? []), ...(cfg.arrays.kv_namespaces ?? [])]) {
      assert.equal(typeof b.binding, "string", `${f}: a binding entry has no readable string binding name`);
    }
    for (const key of Object.keys(cfg.arrays)) {
      assert.match(key, /^(d1_databases|kv_namespaces|queues\.producers|queues\.consumers|services|durable_objects\.bindings|migrations|routes|r2_buckets|triggers)$/, `${f}: unrecognized [[${key}]] -- extend the parser test/checks deliberately`);
    }
  }
});

// ---------------------------------------------------------------------------
// wrangler.backtest.toml: no live binding
// ---------------------------------------------------------------------------

test("wrangler.backtest.toml binds only SIM_DB, INPUTS_DB and its own KV, and consumes only BACKTEST -- no live DB, no live KV, no producers", () => {
  const ids = referenceIds();
  const otherKvIds = WRANGLER_FILES.filter((f) => f !== "wrangler.backtest.toml").flatMap((f) => (read(f).arrays.kv_namespaces ?? []).map((k) => k.id));
  assert.deepEqual(findBacktestConfigViolations(read("wrangler.backtest.toml"), ids, { otherKvIds }), []);
});

test("the binding check actually detects violations (it isn't vacuously passing)", () => {
  const ids = referenceIds();
  const good = readFileSync(path.join(ROOT, "wrangler.backtest.toml"), "utf8");
  const bad = (extra) => findBacktestConfigViolations(parseWranglerToml(good + "\n" + extra), ids, { otherKvIds: [] });

  assert.ok(bad(`[[d1_databases]]\nbinding = "LIVE_DB"\ndatabase_id = "${ids.live}"`).some((p) => /live database/.test(p)));
  assert.ok(bad(`[[d1_databases]]\nbinding = "X"\ndatabase_id = "${ids.live}"`).some((p) => /unexpected D1 binding X/.test(p)), "a live DB under any binding name is caught");
  assert.ok(bad(`[[d1_databases]]\nbinding = "DB"\ndatabase_id = "${ids.legacy}"`).some((p) => /legacy/.test(p)));
  assert.ok(bad(`[[queues.producers]]\nqueue = "news-market-ai-analyze"\nbinding = "ANALYZE"`).some((p) => /must not produce/.test(p)));
  assert.ok(bad(`[[queues.consumers]]\nqueue = "news-market-ai-analyze"`).some((p) => /consume exactly/.test(p)));
  assert.ok(bad(`[[services]]\nbinding = "BACKEND"\nservice = "news-market-ai"`).some((p) => /services/.test(p)));
  assert.ok(bad(`[[kv_namespaces]]\nbinding = "LIVE_KV"\nid = "abc"`).some((p) => /exactly one CACHE_KV/.test(p)));
  // Sharing live's KV namespace id:
  const kvId = read("wrangler.backtest.toml").arrays.kv_namespaces[0].id;
  assert.ok(findBacktestConfigViolations(read("wrangler.backtest.toml"), ids, { otherKvIds: [kvId] }).some((p) => /shares its id/.test(p)));
  // SIM_DB re-pointed at live:
  const rePointed = good.replace(ids.sim, ids.live);
  assert.ok(findBacktestConfigViolations(parseWranglerToml(rePointed), ids).some((p) => /live database/.test(p)));
});

// ---------------------------------------------------------------------------
// live / sim schema equality
// ---------------------------------------------------------------------------

test("backend applies the SAME migrations dir (migrations/state) to LIVE_DB and SIM_DB -- the mechanism that keeps their schemas equal in production", () => {
  const d1 = byBinding(read("wrangler.toml"), "d1_databases");
  assert.equal(d1.LIVE_DB.migrations_dir, "migrations/state");
  assert.equal(d1.SIM_DB.migrations_dir, "migrations/state");
  assert.equal(d1.INPUTS_DB.migrations_dir, "migrations/inputs");
  // ...and SIM_DB's second pass adds only migrations/sim.
  assert.equal(byBinding(read("wrangler.sim-migrate.toml"), "d1_databases").SIM_DB.migrations_dir, "migrations/sim");
});

async function schemaOf(db) {
  const { results } = await db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY type, name").all();
  return results;
}

test("live and sim schemas are identical, except sim also has the backtest_runs registry (and its index) -- nothing else", async () => {
  const live = await schemaOf(createTestD1([STATE_DIR]));
  const sim = await schemaOf(createTestD1([STATE_DIR, SIM_DIR]));

  const registry = sim.filter((r) => r.tbl_name === "backtest_runs");
  assert.deepEqual(registry.map((r) => `${r.type}:${r.name}`).sort(), ["index:idx_backtest_runs_started_at", "table:backtest_runs"]);
  const simMinusRegistry = sim.filter((r) => r.tbl_name !== "backtest_runs");
  assert.deepEqual(simMinusRegistry, live, "every state table/index is defined identically on live and sim");
  assert.ok(live.length > 0 && live.some((r) => r.name === "positions"), "sanity: the schema was actually read");
  assert.ok(!live.some((r) => r.tbl_name === "backtest_runs"), "the registry must NOT exist on live");
});

test("the schema-equality check detects drift (a state table altered on sim only)", async () => {
  const live = await schemaOf(createTestD1([STATE_DIR]));
  const simDb = createTestD1([STATE_DIR, SIM_DIR]);
  await simDb.prepare("ALTER TABLE positions ADD COLUMN sim_only_drift TEXT").run();
  const sim = (await schemaOf(simDb)).filter((r) => r.tbl_name !== "backtest_runs");
  assert.notDeepEqual(sim, live);
});

test("inputs schema is disjoint from the state schema (no table defined in both)", async () => {
  const names = async (dirs) => new Set((await schemaOf(createTestD1(dirs))).filter((r) => r.type === "table").map((r) => r.name));
  const inputs = await names([INPUTS_DIR]);
  const state = await names([STATE_DIR]);
  assert.deepEqual([...inputs].filter((n) => state.has(n)), []);
});
