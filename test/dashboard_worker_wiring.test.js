// Wiring checks for the single-Worker dashboard: the Next.js app
// (dashboard-next/) is the Worker `news-market-ai-dashboard`, it reaches the
// private backend over a BACKEND service binding, and CI deploys it from
// deploy-dashboard-next.yml only. The old gateway Worker (src/dashboard-worker.js
// + wrangler.dashboard.toml + deploy.yml's deploy-dashboard job) must stay gone:
// a leftover deploy job would push the retired gateway over the live app on the
// next push to main.
//
// Like the other deploy-wiring tests in ci_env_isolation.test.js, these read the
// workflow files as TEXT (no YAML dependency): structural checks that the wiring
// is present and ordered, not proof that GitHub Actions accepts it.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWranglerToml } from "./helpers/wrangler_toml.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(ROOT, f), "utf8");
/** wrangler.jsonc with its full-line // comments stripped (the file has no trailing comments). */
const readJsonc = (f) => JSON.parse(read(f).replace(/^\s*\/\/.*$/gm, ""));

const DEPLOY_YML = read(".github/workflows/deploy.yml");
const DASHBOARD_YML = read(".github/workflows/deploy-dashboard-next.yml");
const PATH_FILTERS = read(".github/path-filters.yml");
const PACKAGE_JSON = JSON.parse(read("package.json"));

test("the dashboard is one Worker, news-market-ai-dashboard, bound only to the backend over BACKEND", () => {
  const cfg = readJsonc("dashboard-next/wrangler.jsonc");
  assert.equal(cfg.name, "news-market-ai-dashboard", "the name keeps the public workers.dev URL and the stored login secrets");
  const backendName = parseWranglerToml(read("wrangler.toml")).top.name;
  assert.equal(backendName, "news-market-ai");
  assert.deepEqual(cfg.services, [{ binding: "BACKEND", service: backendName }], "exactly one service binding: BACKEND -> the backend Worker (no DASHBOARD binding, nothing else)");
  for (const key of ["d1_databases", "kv_namespaces", "queues", "r2_buckets", "durable_objects", "vars"]) {
    assert.equal(cfg[key], undefined, `wrangler.jsonc must not bind or define ${key}: the app reaches all data through backend, and secrets never live in the file`);
  }
});

test("the old gateway Worker is gone: no entry point, no wrangler config, no npm scripts", () => {
  assert.ok(!existsSync(path.join(ROOT, "src/dashboard-worker.js")), "src/dashboard-worker.js is retired");
  assert.ok(!existsSync(path.join(ROOT, "wrangler.dashboard.toml")), "wrangler.dashboard.toml is retired");
  assert.equal(PACKAGE_JSON.scripts["deploy:dashboard"], undefined);
  assert.equal(PACKAGE_JSON.scripts["dev:dashboard"], undefined);
  for (const f of readdirSync(path.join(ROOT, ".github/workflows"))) {
    assert.ok(!read(`.github/workflows/${f}`).includes("wrangler.dashboard.toml"), `${f} still points at wrangler.dashboard.toml`);
  }
});

test("deploy.yml no longer deploys a dashboard Worker (that job would deploy the retired gateway over the app)", () => {
  assert.ok(!/\n  deploy-dashboard:\n/.test(DEPLOY_YML), "deploy.yml still has a deploy-dashboard job");
  assert.ok(!DEPLOY_YML.includes("deploy:dashboard"));
  assert.ok(!DEPLOY_YML.includes("f_dashboard"), "the dashboard paths-filter step is gone");
  assert.ok(!DEPLOY_YML.includes("[dashboard]="), "the dashboard baseline entry is gone");
  assert.ok(!/\n      dashboard: /.test(DEPLOY_YML), "the `dashboard` changes output is gone");
  assert.ok(!/^dashboard:/m.test(PATH_FILTERS), "path-filters.yml has no dashboard filter");
});

test("deploy-dashboard-next.yml deploys on push to main, gated on the gateway tests, and sets the login secrets AFTER the deploy", () => {
  assert.match(DASHBOARD_YML, /on:\n  push:\n    branches: \[main\]/, "deploys on push to main");
  assert.match(DASHBOARD_YML, /deploy:\n    needs: test\n/, "the deploy job waits for the test job");
  assert.ok(DASHBOARD_YML.includes("test/dashboard_gateway.test.js") && DASHBOARD_YML.includes("test/dashboard_worker_wiring.test.js"), "the test job runs the gateway tests");

  const deployStep = DASHBOARD_YML.indexOf("run: npm run deploy\n");
  assert.ok(deployStep > 0, "runs npm run deploy (opennextjs-cloudflare build && deploy)");
  assert.equal(PACKAGE_JSON.scripts.deploy, "wrangler deploy", "sanity: the root `deploy` is the backend's -- the dashboard one is dashboard-next's own");
  assert.equal(JSON.parse(read("dashboard-next/package.json")).scripts.deploy, "opennextjs-cloudflare build && opennextjs-cloudflare deploy");

  for (const name of ["DASHBOARD_USERNAME", "DASHBOARD_PASSWORD", "JWT_SECRET", "SESSION_TTL_SECONDS"]) {
    const put = DASHBOARD_YML.indexOf(`npx wrangler secret put ${name} --config wrangler.jsonc`);
    assert.ok(put > deployStep, `${name} is set after the deploy, from the app's own wrangler.jsonc`);
    assert.ok(DASHBOARD_YML.includes(`${name}: \${{ secrets.${name} }}`), `${name} comes from the repo secret of the same name`);
    assert.ok(read("dashboard-next/src/server/gateway.mjs").includes(`env.${name}`), `the gateway actually reads ${name}`);
  }
});

test("a single concurrency group serialises dashboard deploys", () => {
  assert.match(DASHBOARD_YML, /concurrency:\n  group: deploy-news-market-ai-dashboard\n/);
});
