// "Jsonify" helpers -- see plan.md's ingestion section: anything that isn't
// already JSON (RSS/Atom XML, scraped HTML) gets turned into plain strings
// here, at the ingestion boundary, before it ever reaches normalize.js's
// buildNormalizedItem(). Nothing downstream of ingestion/sources/*.js should
// need to know these formats exist.
//
// HONEST SCOPE: this is regex/string-based, not a real XML/HTML parser
// (no DOM, no external dep) -- deliberate, since a "real" parser (DOMParser,
// jsdom) either doesn't exist in the Cloudflare Workers runtime or drags in
// a heavy dependency for what is, for RSS/simple article markup, a fairly
// regular format. It handles the common cases (standard RSS 2.0 <item>,
// Atom <entry>, CDATA, numeric/named entities, script/style stripping) and
// is expected to occasionally mis-parse a malformed or unusual feed/page --
// callers should treat a missing title/link as a skip, not a crash.

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  ldquo: "\u201c",
  rdquo: "\u201d",
  lsquo: "\u2018",
  rsquo: "\u2019",
  hellip: "\u2026",
};

/** Decodes XML/HTML named + numeric entities. Not exhaustive (see NAMED_ENTITIES) -- unknown named entities are left as-is rather than guessed. */
export function decodeEntities(str) {
  if (!str) return "";
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(\w+);/g, (m, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m));
}

/** Pulls text out of `<tag>...</tag>` or `<tag>...<![CDATA[...]]>...</tag>`, decoded and trimmed. Returns "" if the tag isn't present. */
function extractTag(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  if (!m) return "";
  const inner = m[1];
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(inner);
  return decodeEntities((cdata ? cdata[1] : inner).trim());
}

/** Atom's <link> is usually a self-closing `<link href="..."/>`, not `<link>text</link>` like RSS -- pull href separately. */
function extractLinkHref(xml) {
  const m = /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(xml);
  return m ? decodeEntities(m[1]) : "";
}

/**
 * Parses an RSS 2.0 or Atom feed's raw XML text into a flat list of
 * `{ title, link, publishedAt, summary }`. `publishedAt` is the raw
 * vendor date string (RFC822 for RSS, ISO8601 for Atom) -- callers should
 * run it through `new Date(...)` themselves (Date parses both formats
 * natively) rather than this module re-implementing date parsing.
 * `summary` is decoded but NOT stripped of any inner HTML -- callers that
 * want plain text should pass it through `stripHtml()` below, since some
 * feeds put plain text there and others embed an HTML fragment.
 */
export function parseFeedItems(xmlText) {
  const entries = [];

  // RSS 2.0: <item>...</item>
  for (const m of xmlText.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    entries.push({
      title: extractTag(block, "title"),
      link: extractTag(block, "link") || extractLinkHref(block),
      publishedAt: extractTag(block, "pubDate"),
      summary: extractTag(block, "description"),
    });
  }

  // Atom: <entry>...</entry> -- only parsed if no RSS <item>s were found,
  // since a feed is one format or the other, not both.
  if (entries.length === 0) {
    for (const m of xmlText.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
      const block = m[1];
      entries.push({
        title: extractTag(block, "title"),
        link: extractLinkHref(block) || extractTag(block, "id"),
        publishedAt: extractTag(block, "published") || extractTag(block, "updated"),
        summary: extractTag(block, "summary") || extractTag(block, "content"),
      });
    }
  }

  return entries;
}

/**
 * Strips an HTML fragment/document down to plain text: drops
 * script/style/nav/header/footer entirely (their text is never article
 * content), turns block-level boundaries into newlines so paragraphs don't
 * run together, removes remaining tags, decodes entities, and collapses
 * whitespace. This is NOT a readability/boilerplate-removal algorithm --
 * it does not distinguish article body from surrounding site chrome
 * (bylines, related-article links, cookie banners, etc. in what remains
 * of <body> all come through as text). Good enough as a first pass;
 * flagged as a known limitation, not silently presented as full extraction.
 */
export function stripHtml(html) {
  if (!html) return "";
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|nav|header|footer|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  return text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").split("\n").map((l) => l.trim()).join("\n").trim();
}

/** Best-effort page title: `<meta property="og:title">` first (usually cleaner, no site-name suffix), falling back to `<title>`. */
export function extractPageTitle(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i.exec(html);
  if (og) return decodeEntities(og[1]).trim();
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).trim() : "";
}
