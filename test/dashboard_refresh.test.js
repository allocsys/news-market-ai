// Covers the per-page Refresh link + "Loaded" time the dashboard shell renders
// above a section's content (src/dashboard/shell.js#renderPageToolbar), and which
// routes (src/dashboard/routes.js) opt in to it.
//
// The Refresh control is deliberately a plain GET <a> back to the same path +
// query string -- the dashboard is server-rendered with no client-side
// routing, and every section re-reads D1 on each request, so following the link
// IS the refresh. These tests pin that contract: the eight data-driven sections
// get it, pages with nothing to go stale (trigger forms, confirm pages, More) don't,
// and active filters survive the round trip.
//
// FakeDashboardDb is the same generic empty-result D1 stub index_login.test.js
// uses -- enough for every section to render (an empty or error state is fine
// here; the toolbar is independent of the section's own content).

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { renderShell } from "../src/dashboard/shell.js";

class FakeDashboardDb {
  prepare() {
    return {
      bind() {
        return this;
      },
      async all() {
        return { results: [] };
      },
      async first() {
        return undefined;
      },
      async run() {},
    };
  }
}

function env() {
  // No DASHBOARD_USERNAME/PASSWORD/JWT_SECRET -> the dashboard is unauthenticated
  // (unchanged legacy behavior), so no session cookie is needed here.
  return { DB: new FakeDashboardDb() };
}

async function getHtml(pathAndQuery) {
  const response = await worker.fetch(new Request(`https://worker.example${pathAndQuery}`), env());
  assert.equal(response.status, 200, `${pathAndQuery} should render`);
  return response.text();
}

/** Returns the Refresh link's href attribute (still HTML-escaped, as it appears in the markup), or null if the page has no Refresh link. */
function refreshHrefIn(html) {
  const match = html.match(/<a href="([^"]*)" class="btn btn-secondary" title="[^"]*"><span aria-hidden="true">[^<]*<\/span> Refresh<\/a>/);
  return match ? match[1] : null;
}

const REFRESHABLE_SECTIONS = ["snapshot", "activity", "charts", "health", "decisions", "positions", "pipeline", "backtest"];

for (const section of REFRESHABLE_SECTIONS) {
  test(`GET /dashboard/${section} renders a Refresh link back to itself, plus a Loaded time`, async () => {
    const html = await getHtml(`/dashboard/${section}`);
    assert.equal(refreshHrefIn(html), `/dashboard/${section}`);
    assert.match(html, /<span class="page-toolbar-updated">Loaded \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC<\/span>/);
  });
}

const NON_REFRESHABLE_PAGES = [
  "/dashboard/backfill",
  "/dashboard/more",
  "/dashboard/backfill/confirm?from=2024-01-01&to=2024-01-31",
  "/dashboard/backtest/confirm?testStart=2024-01-01&testEnd=2024-01-31&tickers=AAPL&graceDays=5",
];

for (const path of NON_REFRESHABLE_PAGES) {
  test(`GET ${path} has no Refresh link -- nothing on it goes stale`, async () => {
    const html = await getHtml(path);
    assert.equal(refreshHrefIn(html), null);
    assert.doesNotMatch(html, /page-toolbar"/);
  });
}

test("Refresh link keeps the page's active filters (query string), HTML-escaped", async () => {
  const html = await getHtml("/dashboard/decisions?decisionStatus=approved&decisionLimit=50");
  // A raw & in an href attribute must be written as &amp; in the markup; the browser
  // decodes it back to & when following the link.
  assert.equal(refreshHrefIn(html), "/dashboard/decisions?decisionStatus=approved&amp;decisionLimit=50");
});

test("renderShell without refreshHref renders no toolbar (e.g. the POST run-accepted status page)", () => {
  const html = renderShell({ activeSection: "backfill", sessionUsername: null, bodyHtml: "<p>body</p>" });
  assert.equal(refreshHrefIn(html), null);
  assert.doesNotMatch(html, /page-toolbar"/);
  assert.match(html, /<p>body<\/p>/);
});

test("renderShell HTML-escapes refreshHref so a hostile query string can't break out of the attribute", () => {
  const html = renderShell({ activeSection: "snapshot", sessionUsername: null, bodyHtml: "", refreshHref: '/dashboard/snapshot?x="><script>alert(1)</script>' });
  assert.doesNotMatch(html, /"><script>alert\(1\)<\/script>/);
  assert.match(html, /href="\/dashboard\/snapshot\?x=&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
});
