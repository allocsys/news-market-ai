// Covers src/index.js's TRANSITIONAL queue() handler (added 2026-09-20,
// see that handler's own comment for the full Cloudflare-platform reason
// it exists). DELETE THIS FILE along with the handler in the follow-up
// deploy that removes it -- there is nothing left to test once it's gone.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("queue() (transitional) acks every message without throwing, and logs that it was invoked unexpectedly", async (t) => {
  const errorLogs = [];
  t.mock.method(console, "error", (...args) => errorLogs.push(args));

  const messages = [
    { body: { type: "backfill", id: "x" }, ack() { this.acked = true; } },
    { body: { type: "something_else" }, ack() { this.acked = true; } },
  ];

  await worker.queue({ messages });

  assert.ok(messages.every((m) => m.acked));
  assert.ok(errorLogs.some(([msg]) => msg.includes("queue() invoked unexpectedly")));
});
