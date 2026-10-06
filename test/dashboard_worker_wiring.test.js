// Wiring checks for the single-Worker dashboard: the Next.js app
// (dashboard-next/) is the Worker `news-market-ai-dashboard`, it reaches the
// private backend over a BACKEND service binding, and CI deploys it from the
// `deploy-dashboard` job in deploy.yml (the 8th job, after the backend `deploy`
// job). The old gateway Worker (src/dashboard-worker.js + wrangler.dashboard.toml)
// must stay gone: a leftover deploy of it would push the retired gateway over the
// live app on the next push to main.
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
const PATH_FILTERS = read(".github/path-filters.yml");
const PACKAGE_JSON = JSON.parse(read("package.json"));

/** One top-level job of deploy.yml, from its `  name:` header to the next job header (or the end). */
function jobBlock(name) {
  const match = DEPLOY_YML.match(new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [a-z][a-z-]*:\\n|$)`));
  assert.ok(match, `deploy.yml has no ${name} job`);
  return match[0];
}

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

test("deploy.yml gates the dashboard like the other Workers: output, per-target baseline, paths-filter step, filter definition", () => {
  assert.match(DEPLOY_YML, /\n      dashboard: \$\{\{ github\.event_name == 'workflow_dispatch' \|\|/, "the `dashboard` changes output");
  assert.ok(DEPLOY_YML.includes("[dashboard]=deploy-dashboard"), "the baseline is the last successful deploy-dashboard run");
  assert.match(DEPLOY_YML, /id: f_dashboard\n        if: github\.event_name == 'push' && steps\.base\.outputs\.dashboard != ''\n        with:\n          base: \$\{\{ steps\.base\.outputs\.dashboard \}\}/, "a paths-filter step against the dashboard baseline");
  const filter = PATH_FILTERS.match(/^dashboard:\n((?:  .*\n)+)/m);
  assert.ok(filter, "path-filters.yml has a dashboard filter");
  assert.ok(filter[1].includes("'dashboard-next/**'"), "it watches dashboard-next/**");
  assert.ok(!/src\/\*\*|'\*\*'/.test(filter[1].replace(/dashboard-next\/\*\*/g, "")), "it does not watch the backend's src/ (the app bundles nothing from it)");
});

test("deploy-dashboard: after the backend deploy, push/dispatch only, builds dashboard-next, sets the login secrets AFTER the deploy", () => {
  const job = jobBlock("deploy-dashboard");
  assert.match(job, /needs: \[changes, deploy\]\n/, "waits for the backend `deploy` job (the BACKEND service binding needs news-market-ai to exist)");
  assert.ok(job.includes("needs.changes.outputs.dashboard == 'true'"), "gated by the dashboard filter");
  assert.ok(job.includes("github.event_name == 'push' || github.event_name == 'workflow_dispatch'"), "never on a pull_request");
  assert.ok(job.includes("group: deploy-news-market-ai-dashboard-${{ github.ref }}"), "its own concurrency group");
  assert.ok(!job.includes("npm ci"), "dashboard-next is its own npm project: no root npm ci");

  const deployStep = job.indexOf("run: npm run deploy\n");
  assert.ok(deployStep > 0, "runs npm run deploy (opennextjs-cloudflare build && deploy)");
  assert.ok(/name: Build and deploy dashboard Worker\n        working-directory: dashboard-next\n/.test(job), "the deploy runs inside dashboard-next/, not the root (root `deploy` is the backend's)");
  assert.equal(PACKAGE_JSON.scripts.deploy, "wrangler deploy", "sanity: the root `deploy` is the backend's -- the dashboard one is dashboard-next's own");
  assert.equal(JSON.parse(read("dashboard-next/package.json")).scripts.deploy, "opennextjs-cloudflare build && opennextjs-cloudflare deploy");

  const gateway = read("dashboard-next/src/server/gateway.mjs");
  for (const name of ["DASHBOARD_USERNAME", "DASHBOARD_PASSWORD", "JWT_SECRET", "SESSION_TTL_SECONDS"]) {
    const put = job.indexOf(`npx wrangler secret put ${name} --config wrangler.jsonc`);
    assert.ok(put > deployStep, `${name} is set after the deploy, from the app's own wrangler.jsonc`);
    assert.ok(job.includes(`${name}: \${{ secrets.${name} }}`), `${name} comes from the repo secret of the same name`);
    assert.ok(gateway.includes(`env.${name}`), `the gateway actually reads ${name}`);
  }
});

test("the dashboard has exactly one deploy path: no separate dashboard deploy workflow next to deploy.yml", () => {
  assert.ok(!existsSync(path.join(ROOT, ".github/workflows/deploy-dashboard-next.yml")), "deploy-dashboard-next.yml is folded into deploy.yml's deploy-dashboard job (two would deploy twice per push)");
  for (const f of readdirSync(path.join(ROOT, ".github/workflows"))) {
    if (f === "deploy.yml") continue;
    assert.ok(!/npm run deploy|opennextjs-cloudflare deploy/.test(read(`.github/workflows/${f}`)) || f === "", `${f} must not deploy the dashboard`);
  }
});
