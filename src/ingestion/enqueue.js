// Chunked sender for Cloudflare Queues `sendBatch`.
//
// Cloudflare caps a single sendBatch call at 100 messages AND 256 KB total
// (each message at 128 KB). Going over throws, e.g. live incident 2026-09-19:
// `batch message count of 163 exceeds limit of 100 (10206)` on every ingest
// tick, which the ingest Worker caught, logged and acked -- so the pipeline
// produced no analysis at all. Everything the ingest Worker enqueues goes
// through sendInChunks so no caller can hit that limit again.
//
// The byte budget is deliberately below the 256 KB cap (queue metadata adds
// overhead on top of the serialized body), so a chunk never lands right on
// the limit. A single message bigger than the budget is sent alone -- it will
// fail if it really is over Cloudflare's per-message cap, and that failure is
// reported like any other, not swallowed.

export const QUEUE_MAX_BATCH_MESSAGES = 100;
export const QUEUE_MAX_BATCH_BYTES = 200_000;

const encoder = new TextEncoder();

function bodyBytes(message) {
  return encoder.encode(JSON.stringify(message.body)).length;
}

/**
 * Splits `messages` (each `{ body }`, the shape sendBatch takes) into
 * consecutive chunks of at most `maxMessages` messages and `maxBytes`
 * serialized-body bytes. Order is preserved; an empty input gives no chunks.
 */
export function chunkQueueMessages(messages, { maxMessages = QUEUE_MAX_BATCH_MESSAGES, maxBytes = QUEUE_MAX_BATCH_BYTES } = {}) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const message of messages) {
    const size = bodyBytes(message);
    if (current.length > 0 && (current.length >= maxMessages || currentBytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(message);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Sends `messages` to `queue` in as many sendBatch calls as the limits need.
 * A failing chunk does not stop the rest: it is recorded in `failures` and the
 * remaining chunks are still attempted. Never throws for a queue error --
 * callers decide what a partial failure means (see ingest-worker.js).
 *
 * @returns {Promise<{ sent: number, failures: Array<{ count: number, message: string, ids: string[] }> }>}
 *   `ids` are `ticker:runId` labels (capped at 20 per failed chunk) so a log
 *   line can say which items never reached ANALYZE.
 */
export async function sendInChunks(queue, messages, options) {
  let sent = 0;
  const failures = [];
  for (const chunk of chunkQueueMessages(messages, options)) {
    try {
      await queue.sendBatch(chunk);
      sent += chunk.length;
    } catch (err) {
      failures.push({
        count: chunk.length,
        message: err?.message ?? String(err),
        ids: chunk.slice(0, 20).map((m) => `${m.body?.ticker}:${m.body?.runId}`),
      });
    }
  }
  return { sent, failures };
}
