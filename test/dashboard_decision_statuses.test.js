// The dashboard's Status filter must key on the store's REAL status vocabulary.
// RunStore#commitThesis has written 'opened' since M2 (the old pipeline wrote
// 'approved'), so a hard-coded list would silently drop statuses from the filter.
// The rendering side of this lives in dashboard-next now; this keeps the server-
// side param parsing honest.

import test from "node:test";
import assert from "node:assert/strict";
import { DECISION_STATUS_OPTIONS, parseDashboardParams } from "../src/dashboard/helpers.js";
import { TRADE_DECISION_STATUS } from "../src/shared/constants.js";

test("Status filter options come from TRADE_DECISION_STATUS: every real status is filterable, the retired 'approved' is not", () => {
  assert.equal(DECISION_STATUS_OPTIONS[0], "all");
  for (const status of Object.values(TRADE_DECISION_STATUS)) {
    assert.ok(DECISION_STATUS_OPTIONS.includes(status), `${status} must be a filter option`);
  }
  assert.ok(!DECISION_STATUS_OPTIONS.includes("approved"));
});

test("parseDashboardParams accepts a real status and rejects the retired 'approved'", () => {
  assert.equal(parseDashboardParams(new URLSearchParams("decisionStatus=opened")).decisionStatus, "opened");
  assert.equal(parseDashboardParams(new URLSearchParams("decisionStatus=approved")).decisionStatus, "all");
});
