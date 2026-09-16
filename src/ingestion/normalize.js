// Every ingestion source adapter (src/ingestion/sources/*.js) must funnel
// its output through buildNormalizedItem() before anything downstream ever
// sees it. This is the "jsonify anything" boundary from plan.md: nothing
// past this module should know or care whether an item came from GDELT's
// native JSON, a scraped RSS feed, or an HTML page.

import { NormalizedNewsItem } from "../schemas/index.js";

/**
 * Deterministic id derived from (url, publishedAt) -- NOT a random uuid --
 * so re-ingesting the same story (syndication, re-fetch) produces the same
 * id and the D1 insert's ON CONFLICT DO NOTHING naturally dedupes it.
 */
export async function deriveNewsItemId(url, publishedAt) {
  const data = new TextEncoder().encode(`${url}|${publishedAt}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildNormalizedItem({ source, url, publishedAt, tickers, title, body, raw }) {
  const id = await deriveNewsItemId(url, publishedAt);
  return NormalizedNewsItem.parse({
    id,
    source,
    url,
    publishedAt,
    ingestedAt: new Date().toISOString(),
    tickers,
    title,
    body,
    raw,
  });
}
