# Pipeline stage diagrams

Reference diagrams for `runPipelineForTicker` (one ticker, one news item), covering the full stage sequence in `src/graph/pipeline.js`.

## Ingest through debate

![Ingest through debate](diagrams/pipeline-ingest-to-debate.svg)

1. **Ingest news item** -- upstream normalization happens in `ingestion/ingest.js#collectNewsItems`, which feeds `newsItem` into the pipeline.
2. Stage `analyzed`: `Promise.all` of three parallel analysts -- `runNewsEventAnalyst` (`agents/analysts/newsEventAnalyst.js`), `runSentimentAnalyst` (`agents/analysts/sentimentAnalyst.js`), `runTechnicalAnalyst` (`agents/analysts/technicalAnalyst.js`, needs price bars via `getPriceBarsAsOf`, skipped if none).
3. Stage `debated`: a loop (`do/while shouldContinueDebate`, `graph/conditional_logic.js`, `config.maxDebateRounds` default 1) of `Promise.all(runBullResearcher, runBearResearcher)` (`agents/researchers/bull.js`, `bear.js`) followed by `runResearchManager` (`agents/managers/research_manager.js`), the judge, which produces the verdict.

## Verdict through commit

![Verdict through commit](diagrams/pipeline-verdict-to-commit.svg)

4. Stage `traded`: `runTrader` (`agents/trader/trader.js`) turns the verdict into a thesis. Never sizes.
5. Stage `risk_checked`: `evaluateRisk` (`agents/risk_mgmt/risk.js`) -- deterministic, no LLM, sets sizing/stop-loss/take-profit.
6. Stage `portfolio_checked`: `evaluatePortfolio` (`agents/managers/portfolio_manager.js`) -- deterministic, no LLM, portfolio-wide risk ceiling go/no-go. If approved: `store.commitThesis` (atomic open/replace), plus `settlePositionOutcome` (`graph/settle.js`, a reflection call) if replacing an existing position.

## Notes

- Every stage is checkpointed (`graph/checkpointer.js`), so a crash resumes from the next stage instead of re-spending LLM calls.
- LLM-backed stages (purple): the three analysts, bull/bear researchers, research manager, trader. These are the calls that collide with the free-tier Gemini RPM limit (see Next To-Dos item on Gemini batching).
- Deterministic stages (gray): risk check, portfolio check. No LLM involvement, no rate-limit exposure.
- Conditional LLM call, easy to miss: `settlePositionOutcome` (`graph/settle.js`) only fires on a position close/replace, but when it does it calls `graph/reflection.js#closeTheLoop` -> `agents/utils/memory.js#recordAndReflect` -> `callStructured` (quick model). Same Gemini key/RPM budget as the stages above -- not shown in the two diagram images above since it isn't part of the main per-item stage sequence, but worth counting when sizing the batching-vs-more-keys decision.
