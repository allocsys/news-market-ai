# News → Market Analysis → Trade Signal Pipeline

## Goal
An AI-driven pipeline that ingests financial news, summarizes it, has a second
LLM reason about likely market impact, and turns that analysis into trade
signals. Needs a historical archive for backtesting and fine-tuning.

## Pipeline Stages

### 1. Ingestion
Pull news from multiple sources and normalize everything into a common JSON
schema, so we're not limited to sources that already return JSON — anything
(RSS, scraped HTML, filings) gets "jsonified" into the same shape at the
ingestion boundary.

**Free sources to start with:**
- GDELT Project — free, global news monitoring, updates every 15 min, historical
  archive back to 2015. Best free option for backtesting since it's timestamped.
- SEC EDGAR full-text search API — free, official, filings (8-K, 10-Q, etc.)
- RSS feeds — Reuters, Yahoo Finance, MarketWatch, CNBC (free, self-parsed)
- yfinance — free, unofficial, per-ticker news endpoint
- NewsAPI free tier — 100 req/day, 24h delayed, dev-only (no commercial use)
- Finnhub / Alpha Vantage free tiers — news+sentiment endpoints, rate-limited
- Reddit / StockTwits API — free, sentiment signal rather than "news" proper

**Common normalized schema (draft):**
```json
{
  "id": "sha256 hash of source_url + published_at",
  "source": "gdelt | edgar | rss:reuters | yfinance | ...",
  "url": "...",
  "published_at": "ISO8601 UTC - exact public timestamp, not ingestion time",
  "ingested_at": "ISO8601 UTC",
  "tickers": ["AAPL"],
  "title": "...",
  "body": "raw article text",
  "raw": { "...original payload for traceability..." }
}
```
Dedup on `id`/URL since the same story often gets syndicated across outlets.

### 2. Storage
- Raw layer: append-only, immutable store of the normalized JSON + original
  payload (object storage or flat files to start).
- Structured layer: Postgres (Neon free tier), indexed by ticker + published_at
  for fast time-range queries.
- Optional later: vector DB (pgvector) for semantic search over historical news.

### 3. Summarization LLM
Takes raw article JSON → outputs structured summary, not prose:
- entities/tickers involved
- event type (earnings, M&A, regulatory, macro, etc.)
- sentiment score
- short factual summary
Use a free/cheap model here (Groq, Gemini free tier, or local via Ollama) —
high volume, relatively simple task.

### 4. Analysis LLM
Takes structured summaries + market context (price, volume, sector moves) →
reasons about likely market effect. Should output:
- direction/magnitude estimate
- confidence score
- time horizon (same-day catalyst vs. slow-burn thesis)
- explanation (for auditing later)

### 5. Historical data for backtesting
Point-in-time correctness matters: need what was actually publicly known at
each moment, not just old articles, to avoid lookahead bias. GDELT is the best
free option since it's timestamped and archived. Pair with historical
price/volume data (free options TBD - Polygon/Tiingo/IEX free tiers).

### 6. Trade signal generation
Keep this as a separate, simple, auditable layer:
`analysis output -> rule-based position sizing/risk rules -> order`
Do not let the LLM directly size positions — keep that layer deterministic and
backtestable.

## Open questions / next steps
- [ ] Build GDELT ingestion script (first working prototype)
- [ ] Define final normalized JSON schema + set up Neon Postgres schema
- [ ] Build "jsonify" adapters for non-JSON sources (RSS, scraped HTML)
- [ ] Pick free LLM provider for summarization stage
- [ ] Design structured output schema for summarizer + analyst stages
- [ ] Source free historical price/volume data for backtesting
- [ ] Design position-sizing rule layer
