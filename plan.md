# News → Market Analysis → Trade Signal Pipeline

## Goal
An AI-driven pipeline that ingests financial news, summarizes it, has a second
LLM reason about likely market impact, and turns that analysis into trade
signals. Needs a historical archive for backtesting and fine-tuning.

## Prior Art

Before building, we looked at what already exists so we're not reinventing
worse versions of solved problems.

- **[TradingAgents](https://github.com/TauricResearch/TradingAgents)** (TauricResearch,
  104k stars, published as an arXiv paper — UCLA/MIT/Tauric Research) — by far the
  most sophisticated open reference. Multi-agent architecture built on LangGraph:
  **Analyst Team** (parallel: fundamentals, sentiment, news, technical analysts) →
  **Researcher Team** (Bull researcher vs. Bear researcher *debate* the analysts'
  findings) → **Trader** (turns debated research into a position thesis) →
  **Risk Management Team** (multiple risk-profile agents review before approval) →
  **Portfolio Management** (final sign-off). Code is organized as
  `agents/{analysts, researchers, managers, risk_mgmt, trader}/` with a shared
  `schemas.py` for structured agent I/O. This is our primary architectural
  reference — see "Adopted Patterns" below.
- **[Agentic-AI-Trading-Bot](https://github.com/fsaavedra0003/Agentic-AI-Trading-Bot-with-LLM-reasoning-sentiment-analysis)**
  (fsaavedra0003) — smaller/portfolio-scale, but a clean minimal folder layout:
  `ingestion/ sentiment/ models/ agents/ execution/ dashboard/ config/ tests/`.
  Good reference for a lightweight skeleton.
- **[llm-news-sentiment-agent](https://github.com/rkaravangelis/llm-news-sentiment-agent)**
  (rkaravangelis) — small, but useful for the summarizer stage: Pydantic structured
  output, few-shot prompting, a 5-band sentiment schema (not just pos/neg/neutral),
  and a mandatory one-sentence justification field per score — makes output
  auditable, not just a number.
- **[llm-rl-finance-trader](https://github.com/franjgs/llm-rl-finance-trader)** —
  uses yfinance (free) for price history, FinBERT + Finnhub for sentiment, and
  compares a PPO trading agent with/without sentiment via Sharpe ratio. Good
  template for *proving* whether our news signal actually helps, not just
  assuming it does.
- Also scanned: LLM-Enhanced-Trading (Ronitt272, Docker/K8s production reference),
  Stock-Market-News-Sentiment-Analysis-and-Summarization (weekly summarization
  reference), and the broader `news-sentiment` GitHub topic (FinBERT + Kafka +
  TimescaleDB + SEC EDGAR patterns for the storage layer).

## Adopted Patterns (stolen from TradingAgents, adapted for us)

1. **Parallel analyst agents, not one big prompt.** Instead of a single
   "analyze this news" LLM call, split into role-specific analysts that each
   look at the same event from a different angle (news/event analyst, sentiment
   analyst, and — once we have price data wired up — a technical analyst). Each
   outputs a structured opinion independently.
2. **Bull/Bear debate before a verdict.** Before turning analysis into a trade
   thesis, run two agents arguing opposite cases (bull case vs. bear case) on
   the same evidence, then have a "judge" step synthesize. This catches
   single-pass overconfidence cheaply, without fine-tuning.
3. **Separate the trade thesis from risk/sizing.** A trader agent decides
   *direction and reasoning*. A distinct risk-management layer decides
   *whether to act and how much*. Never let one agent do both — keeps the
   audit trail clean and makes the sizing layer swappable/rule-based.
4. **Shared structured schemas everywhere.** One `schemas.py`-equivalent
   defining the structured I/O (Pydantic or JSON Schema) that every agent
   reads/writes against, so stages compose without prompt-string gluing.
5. **Mandatory justification field.** Every scored/classified output (sentiment,
   event type, bull/bear verdict) carries a short natural-language "why" field
   alongside the number — critical for debugging bad trades later.
6. **Prove the signal helps before trusting it.** Backtest with the news
   signal on vs. off (e.g. Sharpe ratio comparison) rather than assuming the
   LLM analysis adds value.

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
- yfinance — free, unofficial, per-ticker news endpoint + price/history data
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

### 3. Analyst Team (was: "Summarization LLM")
Parallel, role-specific agents, each taking raw article JSON and producing a
structured opinion against the shared schema:
- **News/Event analyst**: entities/tickers involved, event type (earnings, M&A,
  regulatory, macro, etc.), short factual summary
- **Sentiment analyst**: sentiment score (5-band, not just pos/neg/neutral) +
  mandatory one-sentence justification
- **Technical analyst** (later, once price data is wired up): price/volume
  context at time of news
Use a free/cheap model here (Groq, Gemini free tier, or local via Ollama) —
high volume, relatively simple task per agent.

### 4. Researcher Team (was: "Analysis LLM")
- **Bull researcher** and **Bear researcher**: two agents argue opposite cases
  using the Analyst Team's output as shared evidence.
- **Judge/synthesis step**: reconciles the debate into a single thesis with:
  direction/magnitude estimate, confidence score, time horizon (same-day
  catalyst vs. slow-burn), and the reasoning trail (both sides + why one won).

### 5. Trader Agent
Takes the Researcher Team's synthesized thesis and produces a concrete trade
recommendation (direction, instrument, rationale) — but does **not** decide
position size. That's a separate concern (see stage 6).

### 6. Risk Management + Portfolio Management
- Risk layer: rule-based, deterministic position sizing/risk limits (not an
  LLM). Reviews the trader's recommendation against account risk rules
  (max position size, stop-loss/take-profit, circuit breakers).
- Portfolio management: final go/no-go sign-off, then order generation.
Keep this layer simple and auditable — never let the LLM directly size
positions.

### 7. Historical data for backtesting
Point-in-time correctness matters: need what was actually publicly known at
each moment, not just old articles, to avoid lookahead bias. GDELT is the best
free option since it's timestamped and archived. Pair with historical
price/volume data via yfinance (free).

Validate the pipeline properly: backtest with the news/analysis signal on vs.
off and compare (e.g. Sharpe ratio, cumulative returns, max drawdown) —
following the llm-rl-finance-trader approach — rather than assuming the LLM
layer adds value.

## Proposed Repo Structure
Blending the TradingAgents role-based layout with the lighter
Agentic-AI-Trading-Bot skeleton:
```
ingestion/          # GDELT, EDGAR, RSS, yfinance adapters -> normalized JSON
storage/             # Postgres schema, raw archive access
agents/
  analysts/          # news/event analyst, sentiment analyst, technical analyst
  researchers/        # bull researcher, bear researcher, judge/synthesis
  trader/             # trade thesis agent
  risk_mgmt/          # deterministic sizing/risk rules (not LLM)
  schemas.py           # shared structured I/O types for all agents
backtest/            # point-in-time backtesting harness, signal on/off comparison
dashboard/           # optional visualization
config/
tests/
```

## Open questions / next steps
- [ ] Build GDELT ingestion script (first working prototype)
- [ ] Define final normalized JSON schema + set up Neon Postgres schema
- [ ] Build "jsonify" adapters for non-JSON sources (RSS, scraped HTML)
- [ ] Define shared `schemas.py` structured I/O types (analyst opinion, debate
      output, trade thesis, risk decision)
- [ ] Pick free LLM provider for the Analyst Team stage
- [ ] Prototype the Bull/Bear debate + judge step
- [ ] Build the deterministic risk/sizing layer (rules, not LLM)
- [ ] Source free historical price/volume data for backtesting (yfinance)
- [ ] Build signal on/off backtest comparison harness
