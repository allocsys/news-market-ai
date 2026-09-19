// Unit tests for src/ingestion/enqueue.js -- the chunked sendBatch helper that
// keeps the ingest Worker under Cloudflare Queues' per-call limits (100
// messages, 256 KB). The Worker-level behavior (163 items -> two batches, a
// failed chunk logged and the rest still sent) is in ingest_worker.test.js;
// this pins the chunking rules themselves.

import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkQueueMessages,
  sendInChunks,
  QUEUE_MAX_BATCH_MESSAGES,
  QUEUE_MAX_BATCH_BYTES,
} from "../src/ingestion/enqueue.js";

const msg = (n, padding = 0) => ({ body: { type: "analyze", runId: `run-${n}`, ticker: "AAPL", pad: "x".repeat(padding) } });
const many = (count, padding = 0) => Array.from({ length: count }, (_, i) => msg(i, padding));

test("defaults match Cloudflare's documented limits (100 messages) with byte headroom under 256 KB", () => {
  assert.equal(QUEUE_MAX_BATCH_MESSAGES, 100);
  assert.ok(QUEUE_MAX_BATCH_BYTES < 256 * 1024);
});

test("chunkQueueMessages returns no chunks for no messages", () => {
  assert.deepEqual(chunkQueueMessages([]), []);
});

test("chunkQueueMessages keeps a small list in a single chunk", () => {
  const chunks = chunkQueueMessages(many(100));
  assert.deepEqual(chunks.map((c) => c.length), [100]);
});

test("chunkQueueMessages splits by message count at 100, preserving order", () => {
  const messages = many(250);
  const chunks = chunkQueueMessages(messages);
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50]);
  assert.deepEqual(chunks.flat(), messages);
});

test("chunkQueueMessages splits by serialized size when messages are large", () => {
  // ~60 KB each: three fit under a 200 KB budget, the fourth starts a new chunk.
  const chunks = chunkQueueMessages(many(7, 60_000), { maxBytes: 200_000 });
  assert.deepEqual(chunks.map((c) => c.length), [3, 3, 1]);
});

test("chunkQueueMessages puts a single over-budget message alone in its own chunk rather than dropping it", () => {
  const messages = [msg(0), msg(1, 300_000), msg(2)];
  const chunks = chunkQueueMessages(messages, { maxBytes: 200_000 });
  assert.deepEqual(chunks.map((c) => c.length), [1, 1, 1]);
  assert.deepEqual(chunks.flat(), messages);
});

test("chunkQueueMessages honors custom limits", () => {
  assert.deepEqual(chunkQueueMessages(many(5), { maxMessages: 2 }).map((c) => c.length), [2, 2, 1]);
});

test("sendInChunks sends every chunk through sendBatch and reports the count", async () => {
  const batches = [];
  const queue = { sendBatch: async (chunk) => batches.push(chunk.length) };
  const result = await sendInChunks(queue, many(163));
  assert.deepEqual(batches, [100, 63]);
  assert.deepEqual(result, { sent: 163, failures: [] });
});

test("sendInChunks does not call sendBatch at all for an empty list", async () => {
  let calls = 0;
  const result = await sendInChunks({ sendBatch: async () => { calls++; } }, []);
  assert.equal(calls, 0);
  assert.deepEqual(result, { sent: 0, failures: [] });
});

test("sendInChunks records a failing chunk (with ticker:runId labels) and still sends the others; it does not throw", async () => {
  let call = 0;
  const queue = {
    sendBatch: async () => {
      if (call++ === 1) throw new Error("boom");
    },
  };
  const result = await sendInChunks(queue, many(250));
  assert.equal(result.sent, 150); // chunks 0 (100) and 2 (50) went out
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].count, 100);
  assert.equal(result.failures[0].message, "boom");
  assert.equal(result.failures[0].ids[0], "AAPL:run-100");
});

test("sendInChunks caps the ids listed per failed chunk at 20", async () => {
  const result = await sendInChunks({ sendBatch: async () => { throw new Error("down"); } }, many(100));
  assert.equal(result.failures[0].count, 100);
  assert.equal(result.failures[0].ids.length, 20);
});
