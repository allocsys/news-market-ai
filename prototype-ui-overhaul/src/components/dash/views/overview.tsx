"use client";

import { useDash } from "@/lib/dash/store";
import {
  DECISIONS, OPEN_POSITIONS, CLOSED_POSITIONS, PIPELINE_CHECKPOINTS,
  INGESTION_SOURCES, TICKERS, JOBS, TOTAL_EXPOSURE_PCT, fmtRelativeTime,
} from "@/lib/dash/mock-data";
import { StatCard, MiniStats } from "../shared/stat-card";
import { Panel, PageHeader } from "../shared/primitives";
import { StatusBadge } from "../shared/status-badge";
import { DonutChart, DonutLegend } from "../shared/donut-chart";
import { GaugeChart } from "../shared/gauge-chart";
import { Sparkline } from "../shared/sparkline";
import { cn } from "@/lib/utils";
import {
  Activity, ArrowRight, AlertTriangle, CircleCheck, CircleDot,
  Gauge, Brain, FlaskConical, ListChecks, TrendingUp, TrendingDown,
} from "lucide-react";

export function OverviewView() {
  const setView = useDash((s) => s.setView);
  const setTickerFilter = useDash((s) => s.setTickerFilter);
  const setSearchOpen = useDash((s) => s.setSearchOpen);
  const tickerFilter = useDash((s) => s.tickerFilter);

  // Filter by ticker if set
  const tick = tickerFilter;
  const decisions = tick ? DECISIONS.filter((d) => d.ticker === tick) : DECISIONS;
  const openPositions = tick ? OPEN_POSITIONS.filter((p) => p.ticker === tick) : OPEN_POSITIONS;
  const closedPositions = tick ? CLOSED_POSITIONS.filter((p) => p.ticker === tick) : CLOSED_POSITIONS;
  const stale = INGESTION_SOURCES.filter((s) => !s.fresh);
  const staleTickers = PIPELINE_CHECKPOINTS.filter((p) => p.status === "stale");
  const lastDecision = decisions[0];
  const runningJob = JOBS.find((j) => j.status === "running");

  const longCount = openPositions.filter((p) => p.direction === "long").length;
  const shortCount = openPositions.filter((p) => p.direction === "short").length;
  const composition = [
    { label: "Long", value: longCount, color: "var(--chart-2)" },
    { label: "Short", value: shortCount, color: "var(--chart-4)" },
  ];

  const exposurePct = tick
    ? openPositions.reduce((s, p) => s + p.sizePct, 0)
    : TOTAL_EXPOSURE_PCT;
  const exposureFrac = Math.min(exposurePct / 100, 1);
  const exposureAccent =
    exposurePct < 50 ? "var(--chart-2)" : exposurePct < 80 ? "var(--chart-3)" : "var(--chart-4)";

  const approvalRate = decisions.length
    ? decisions.filter((d) => d.status === "approved").length / decisions.length
    : 0;
  const approved = decisions.filter((d) => d.status === "approved").length;
  const rejected = decisions.filter((d) => d.status === "rejected").length;
  const approval = [
    { label: "Approved", value: approved, color: "var(--chart-2)" },
    { label: "Rejected", value: rejected, color: "var(--chart-4)" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={tick ? `Overview · ${tick}` : "Overview"}
        description={
          tick
            ? `Command-center view filtered to ${TICKERS.find((t) => t.symbol === tick)?.name ?? tick}.`
            : "One-screen health check: is the pipeline alive, what did it just decide, what's my exposure, and what's stale."
        }
        actions={
          <>
            <button
              onClick={() => setView("snapshot")}
              className="text-xs flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border hover:bg-muted/40"
            >
              <ListChecks className="size-3.5" /> Full snapshot <ArrowRight className="size-3 opacity-60" />
            </button>
          </>
        }
      />

      {/* Top alert strip — only when something needs attention */}
      {(stale.length > 0 || staleTickers.length > 0 || runningJob) && (
        <div className="space-y-2">
          {runningJob && (
            <div className="flex items-center gap-3 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-2.5 text-sm">
              <div className="size-2 rounded-full bg-blue-500 pulse-dot" />
              <span className="text-blue-600 dark:text-blue-300 font-medium">
                {runningJob.phase}
              </span>
              <span className="text-muted-foreground tabular text-xs">
                {runningJob.done}/{runningJob.total} · started {fmtRelativeTime(runningJob.startedAt)} by @{runningJob.triggeredBy}
              </span>
              <button
                onClick={() => setView("backtest")}
                className="ml-auto text-xs flex items-center gap-1.5 px-2 py-1 rounded-md border border-blue-500/30 hover:bg-blue-500/10"
              >
                View run <ArrowRight className="size-3" />
              </button>
            </div>
          )}
          {stale.length > 0 && (
            <div className="flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm">
              <AlertTriangle className="size-4 text-amber-500" />
              <span className="text-amber-700 dark:text-amber-300 font-medium">
                {stale.length} ingestion source{stale.length > 1 ? "s" : ""} stale:
              </span>
              <span className="text-muted-foreground">
                {stale.map((s) => s.label).join(", ")}
              </span>
              <button
                onClick={() => setView("health")}
                className="ml-auto text-xs flex items-center gap-1.5 px-2 py-1 rounded-md border border-amber-500/30 hover:bg-amber-500/10"
              >
                Health <ArrowRight className="size-3" />
              </button>
            </div>
          )}
          {staleTickers.length > 0 && (
            <div className="flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm">
              <AlertTriangle className="size-4 text-amber-500" />
              <span className="text-amber-700 dark:text-amber-300 font-medium">
                {staleTickers.length} ticker{staleTickers.length > 1 ? "s" : ""} stalled in pipeline:
              </span>
              <span className="text-muted-foreground">
                {staleTickers.map((t) => t.ticker).join(", ")}
              </span>
              <button
                onClick={() => setView("pipeline")}
                className="ml-auto text-xs flex items-center gap-1.5 px-2 py-1 rounded-md border border-amber-500/30 hover:bg-amber-500/10"
              >
                Pipeline <ArrowRight className="size-3" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* All-good strip when nothing's wrong */}
      {stale.length === 0 && staleTickers.length === 0 && !runningJob && (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm">
          <CircleCheck className="size-4 text-emerald-500" />
          <span className="text-emerald-700 dark:text-emerald-300 font-medium">All systems nominal.</span>
          <span className="text-muted-foreground">Pipeline alive, ingestion fresh, no jobs running.</span>
        </div>
      )}

      {/* 4-card stat row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <StatCard
          value={`${openPositions.length}`}
          label="Open positions"
          sub={tick ? `in ${tick}` : `${longCount} long · ${shortCount} short`}
          accent="blue"
        />
        <StatCard
          value={`${exposurePct.toFixed(1)}%`}
          label="Total exposure"
          sub={exposurePct < 50 ? "conservative" : exposurePct < 80 ? "moderate" : "high"}
          accent={exposurePct < 50 ? "emerald" : exposurePct < 80 ? "amber" : "red"}
        />
        <StatCard
          value={`${(approvalRate * 100).toFixed(0)}%`}
          label="Decision approval"
          sub={`${approved} approved · ${rejected} rejected`}
          accent="emerald"
        />
        <StatCard
          value={`${closedPositions.length}`}
          label="Recently closed"
          sub={`last ${fmtRelativeTime(closedPositions[0]?.closed ?? new Date().toISOString())}`}
          accent="purple"
        />
      </div>

      {/* 3-chart row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-4">
        <Panel title="Book composition" subtitle="Open positions by direction">
          <div className="flex items-center gap-4">
            <DonutChart segments={composition} centerValue={String(openPositions.length)} centerLabel="open" size={120} />
            <DonutLegend segments={composition} className="flex-1" />
          </div>
        </Panel>
        <Panel title="Open exposure" subtitle="Sum of position size %">
          <GaugeChart value={exposureFrac} valueLabel={`${exposurePct.toFixed(1)}%`} label="total exposure" accent={exposureAccent} />
        </Panel>
        <Panel title="Decision outcomes" subtitle="All-time, all statuses">
          <div className="flex items-center gap-4">
            <DonutChart segments={approval} centerValue={`${(approvalRate * 100).toFixed(0)}%`} centerLabel="approval" size={120} />
            <DonutLegend segments={approval} className="flex-1" />
          </div>
        </Panel>
      </div>

      {/* Two-column: latest decision + pipeline pulse */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
        <Panel
          title="Latest decision"
          subtitle={lastDecision ? `${lastDecision.ticker} · ${fmtRelativeTime(lastDecision.when)}` : "—"}
          actions={
            <button onClick={() => setView("decisions")} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
              All decisions <ArrowRight className="size-3" />
            </button>
          }
        >
          {lastDecision ? (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="size-10 rounded-lg bg-muted/60 grid place-items-center text-xs font-semibold tracking-wider">
                    {lastDecision.ticker.slice(0, 4)}
                  </div>
                  <div>
                    <div className="font-medium text-sm">{lastDecision.ticker}</div>
                    <div className="text-xs text-muted-foreground">{lastDecision.agent}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <StatusBadge kind={lastDecision.direction} />
                  <StatusBadge kind={lastDecision.status} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <MiniStats
                  cols={3}
                  items={[
                    { label: "Size", value: `${lastDecision.sizePct}%` },
                    { label: "Confidence", value: lastDecision.confidence.toFixed(2) },
                    { label: "When", value: fmtRelativeTime(lastDecision.when) },
                  ]}
                />
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground leading-relaxed">
                <span className="font-medium text-foreground">Verdict:</span>{" "}
                {lastDecision.reasoning.verdict}
              </div>
              <details className="group">
                <summary className="text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1.5 list-none">
                  <ArrowRight className="size-3 group-open:rotate-90 transition-transform" />
                  Read full LLM reasoning (analyst, bull/bear, trader)
                </summary>
                <div className="mt-3 space-y-2 text-xs">
                  <ReasoningBlock label="Analyst" body={`${lastDecision.reasoning.analyst.sentiment} — ${lastDecision.reasoning.analyst.note}`} />
                  <ReasoningBlock label="Bull" body={lastDecision.reasoning.bull} />
                  <ReasoningBlock label="Bear" body={lastDecision.reasoning.bear} />
                  <ReasoningBlock label="Trader" body={lastDecision.reasoning.trader} />
                </div>
              </details>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No decisions yet for {tick}.</div>
          )}
        </Panel>

        <Panel
          title="Pipeline pulse"
          subtitle="Per-ticker last stage"
          actions={
            <button onClick={() => setView("pipeline")} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
              Pipeline <ArrowRight className="size-3" />
            </button>
          }
        >
          <ul className="space-y-2">
            {(tick
              ? PIPELINE_CHECKPOINTS.filter((p) => p.ticker === tick)
              : PIPELINE_CHECKPOINTS
            ).map((cp) => (
              <li key={cp.ticker} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/30">
                <div
                  className={cn(
                    "size-2 rounded-full shrink-0",
                    cp.status === "ok" && "bg-emerald-500",
                    cp.status === "stale" && "bg-amber-500 pulse-dot",
                    cp.status === "error" && "bg-red-500"
                  )}
                />
                <div className="font-medium text-sm w-16 shrink-0 tabular">{cp.ticker}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs truncate">{cp.lastStageLabel}</div>
                  <div className="text-[10px] text-muted-foreground">{fmtRelativeTime(cp.updatedAt)}</div>
                </div>
                <StatusBadge
                  kind={cp.status === "ok" ? "ok" : cp.status === "stale" ? "stale" : "error"}
                />
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {/* Ticker spotlight (only when no global filter) */}
      {!tick && (
        <Panel
          title="Ticker spotlight"
          subtitle="Top movers in the universe — click any to filter the whole dashboard"
          actions={
            <button
              onClick={() => setSearchOpen(true)}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              Search <ArrowRight className="size-3" />
            </button>
          }
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {TICKERS.slice(0, 8).map((t) => {
              const up = t.changePct >= 0;
              return (
                <button
                  key={t.symbol}
                  onClick={() => {
                    setTickerFilter(t.symbol);
                  }}
                  className="group rounded-xl border border-border bg-card p-3 text-left hover:border-foreground/30 transition-colors"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-medium text-sm">{t.symbol}</div>
                    <div className={cn(
                      "flex items-center gap-1 text-xs tabular",
                      up ? "text-emerald-500" : "text-red-500"
                    )}>
                      {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                      {up ? "+" : ""}{t.changePct.toFixed(2)}%
                    </div>
                  </div>
                  <Sparkline data={t.sparkline} width={220} height={40} />
                  <div className="mt-1.5 flex items-center justify-between text-xs">
                    <span className="tabular font-medium">${t.price.toFixed(2)}</span>
                    <span className="text-muted-foreground text-[10px] group-hover:text-primary">
                      Filter by {t.symbol} →
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </Panel>
      )}

      {/* Quick links strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <QuickLink icon={<Activity className="size-4" />} label="Activity" hint="Decisions per day" onClick={() => setView("activity")} />
        <QuickLink icon={<Brain className="size-4" />} label="LLM calls" hint="42 calls · audit trail" onClick={() => setView("llm")} />
        <QuickLink icon={<FlaskConical className="size-4" />} label="Backtest" hint="3 runs · 1 running" onClick={() => setView("backtest")} />
        <QuickLink icon={<Gauge className="size-4" />} label="Health" hint="Ingestion freshness" onClick={() => setView("health")} />
      </div>
    </div>
  );
}

function ReasoningBlock({ label, body }: { label: string; body: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
      <div className="text-foreground leading-relaxed">{body}</div>
    </div>
  );
}

function QuickLink({ icon, label, hint, onClick }: { icon: React.ReactNode; label: string; hint: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl border border-border bg-card p-3 text-left hover:border-foreground/30 transition-colors flex items-center gap-3"
    >
      <div className="size-9 rounded-lg bg-muted/60 grid place-items-center text-muted-foreground">{icon}</div>
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground truncate">{hint}</div>
      </div>
      <ArrowRight className="size-3.5 ml-auto opacity-40" />
    </button>
  );
}
